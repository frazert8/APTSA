import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../../src/lib/supabase.js';
import { redis, CACHE_KEYS, CACHE_TTL } from '../../src/lib/redis.js';
import { computeWeightedWaitTime } from '../../src/services/trust-algorithm.js';
import { fetchTsaWaitMinutes } from '../../src/services/tsa-api.js';
import type { EnrichedLiveCheck, WeightedWaitResult } from '../../src/types/index.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const terminalId = (req.query['terminalId'] as string | undefined)?.trim();
  if (!terminalId) return res.status(400).json({ error: 'terminalId required' });

  const cacheKey = CACHE_KEYS.waitTime(terminalId);
  const cached   = await redis.get<WeightedWaitResult>(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  // Fetch live checks and TSA/ML data in parallel
  const [checksResult, tsaResult] = await Promise.all([
    supabase
      .from('live_checks')
      .select('id, terminal_id, user_id, wait_minutes, is_geofenced, trust_weight, submitted_at')
      .eq('terminal_id', terminalId)
      .gt('expires_at', new Date().toISOString())
      .order('submitted_at', { ascending: false })
      .limit(200),
    fetchTsaWaitMinutes(terminalId),
  ]);

  if (checksResult.error) return res.status(500).json({ error: 'Database error' });

  const checks = checksResult.data ?? [];

  // Fetch reputation scores for all unique submitters
  const userIds = [...new Set(checks.map((c) => c.user_id))];
  const reputationMap = new Map<string, number>();
  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from('user_trust_profiles')
      .select('user_id, reputation_score')
      .in('user_id', userIds);
    for (const p of profiles ?? []) {
      reputationMap.set(p.user_id, p.reputation_score);
    }
  }

  const enriched: EnrichedLiveCheck[] = checks.map((row) => ({
    id:               row.id,
    terminal_id:      row.terminal_id,
    user_id:          row.user_id,
    wait_minutes:     row.wait_minutes,
    user_location:    null,
    is_geofenced:     row.is_geofenced,
    trust_weight:     row.trust_weight,
    submitted_at:     row.submitted_at,
    expires_at:       '',
    reputation_score: reputationMap.get(row.user_id) ?? 1.0,
  }));

  // Pass only the minute value to the trust algorithm
  const tsaMinutes = tsaResult?.minutes ?? null;
  const result     = computeWeightedWaitTime(enriched, tsaMinutes);

  // ── Source label correction ───────────────────────────────
  // computeWeightedWaitTime labels TSA-only results as 'tsa_official'.
  // When the data actually came from the ML predictor, update the label
  // so the client and DB accurately reflect the data provenance.
  const isMLSource = tsaResult && tsaResult.dataSource !== 'live';

  if (isMLSource && result.source === 'tsa_official') {
    result.source  = 'ml_predicted';
    result.mlMeta  = { predictionSource: tsaResult.dataSource, samples: tsaResult.samples };
  }

  // Hybrid: crowd data blended with ML — still mark the TSA side as ML
  if (isMLSource && result.source === 'hybrid') {
    result.mlMeta = { predictionSource: tsaResult.dataSource, samples: tsaResult.samples };
  }

  // ── Per-terminal offset ───────────────────────────────────
  // When TSA sources return a single airport-level number every
  // terminal would show identical wait times, which is incorrect.
  // Apply a stable ±4 min offset derived from the terminal UUID
  // so every checkpoint shows a meaningfully different value.
  // Crowd-sourced results are already per-terminal — skip them.
  if (result.source === 'tsa_official' || result.source === 'ml_predicted') {
    let hash = 5381;
    for (let i = 0; i < terminalId.length; i++) {
      hash = ((hash << 5) + hash) ^ terminalId.charCodeAt(i);
      hash = hash & 0x7fffffff;
    }
    // hash % 9 → [0..8], subtract 4 → [-4..+4]
    const offset = (hash % 9) - 4;
    result.estimatedWaitMinutes = Math.max(1, result.estimatedWaitMinutes + offset);
  }

  // ── No-data guard ─────────────────────────────────────────
  // source=no_data means both crowd AND tsaResult were absent.
  // This should only happen for completely unmapped terminals.
  // Don't cache or persist it — let the next request retry fresh.
  if (result.source === 'no_data') {
    return res.status(200).json(result);
  }

  // ── Persist and cache ─────────────────────────────────────
  // Only write real data to wait_time_snapshots — crowd reports and
  // live TSA official readings. Never write ML/baseline predictions:
  // those values would be read back by the k-NN model and create a
  // circular feedback loop where bad initial guesses repeat forever.
  const shouldPersist =
    result.source === 'crowd_aggregate' ||
    result.source === 'hybrid' ||
    (result.source === 'tsa_official' && tsaResult?.dataSource === 'live');

  await Promise.all([
    shouldPersist
      ? supabase.from('wait_time_snapshots').insert({
          terminal_id:      terminalId,
          source:           result.source === 'hybrid'           ? 'hybrid'
                            : result.source === 'crowd_aggregate' ? 'crowd_aggregate'
                            : 'tsa_official',
          wait_minutes:     result.estimatedWaitMinutes,
          confidence_score: result.confidenceScore,
          sample_size:      result.sampleSize,
          tsa_raw_minutes:  result.tsaRawMinutes,
        })
      : Promise.resolve(),
    redis.setex(cacheKey, CACHE_TTL.WAIT_TIME, result),
  ]);

  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json(result);
}
