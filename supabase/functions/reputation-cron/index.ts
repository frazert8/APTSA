// ============================================================
// Supabase Edge Function: reputation-cron
// Schedule: every 30 minutes (set in supabase/config.toml)
//
// For each live_check that has now expired and has a matching
// recent wait_time_snapshot, evaluates whether the user's
// report was accurate (±5 min) and updates their reputation score.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const ACCURACY_WINDOW_MINUTES = 5;

// ELO-style reputation from accuracy ratio
function computeReputation(totalChecks: number, accurateChecks: number): number {
  if (totalChecks === 0) return 1.0;
  const accuracy = accurateChecks / totalChecks;
  return Math.max(0.2, Math.min(5.0, 0.2 + accuracy * 4.8));
}

Deno.serve(async (_req) => {
  try {
    const now = new Date().toISOString();

    // ── Find checks that expired in the last 30 min ────────
    // (between 45 and 75 min ago, i.e. just expired)
    const windowStart = new Date(Date.now() - 75 * 60_000).toISOString();
    const windowEnd   = new Date(Date.now() - 45 * 60_000).toISOString();

    const { data: expiredChecks, error: checkErr } = await supabase
      .from('live_checks')
      .select('id, user_id, terminal_id, wait_minutes, submitted_at')
      .gte('expires_at', windowStart)
      .lte('expires_at', windowEnd);

    if (checkErr) throw checkErr;
    if (!expiredChecks?.length) {
      return new Response(JSON.stringify({ processed: 0 }), { status: 200 });
    }

    let processed = 0;

    for (const check of expiredChecks) {
      // Get the hybrid/crowd_aggregate snapshot closest to the check's submission time
      const { data: snapshots } = await supabase
        .from('wait_time_snapshots')
        .select('wait_minutes, confidence_score')
        .eq('terminal_id', check.terminal_id)
        .in('source', ['hybrid', 'crowd_aggregate'])
        .gte('captured_at', check.submitted_at)
        .lte('captured_at', new Date(new Date(check.submitted_at).getTime() + 60 * 60_000).toISOString())
        .order('captured_at')
        .limit(1);

      if (!snapshots?.length || snapshots[0] === undefined) continue;
      const snapshot = snapshots[0];

      // Only evaluate against high-confidence snapshots
      if (snapshot.confidence_score < 0.5) continue;

      const isAccurate =
        Math.abs(check.wait_minutes - snapshot.wait_minutes) <= ACCURACY_WINDOW_MINUTES;

      // ── Atomically update trust profile ──────────────────
      const { data: profile } = await supabase
        .from('user_trust_profiles')
        .select('total_checks, accurate_checks')
        .eq('user_id', check.user_id)
        .single();

      if (!profile) continue;

      const newTotal    = profile.total_checks + 1;
      const newAccurate = profile.accurate_checks + (isAccurate ? 1 : 0);
      const newScore    = computeReputation(newTotal, newAccurate);

      await supabase
        .from('user_trust_profiles')
        .update({
          total_checks:    newTotal,
          accurate_checks: newAccurate,
          reputation_score: Math.round(newScore * 100) / 100,
        })
        .eq('user_id', check.user_id);

      processed++;
    }

    console.log(`[reputation-cron] ${now} — evaluated ${processed}/${expiredChecks.length} checks`);
    return new Response(JSON.stringify({ processed, total: expiredChecks.length }), { status: 200 });
  } catch (err) {
    console.error('[reputation-cron] error', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
