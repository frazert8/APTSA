// ============================================================
// GET /api/wait-times/:terminalId
// Vercel Edge Function — returns merged wait time for a terminal
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../lib/supabase.js';
import { redis, CACHE_KEYS, CACHE_TTL } from '../lib/redis.js';
import { computeWeightedWaitTime } from '../services/trust-algorithm.js';
import { fetchTsaWaitMinutes } from '../services/tsa-api.js';
import type { EnrichedLiveCheck, WeightedWaitResult } from '../types/index.js';

export const config = { runtime: 'edge' };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const terminalId = (req.query['terminalId'] as string | undefined)?.trim();
  if (!terminalId) return res.status(400).json({ error: 'terminalId required' });

  // ── Cache hit ────────────────────────────────────────────
  const cacheKey = CACHE_KEYS.waitTime(terminalId);
  const cached = await redis.get<WeightedWaitResult>(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  // ── Fetch active live_checks + reputation scores ─────────
  const [checksResult, tsaMinutes] = await Promise.all([
    supabase
      .from('live_checks')
      .select(
        `id, terminal_id, user_id, wait_minutes, is_geofenced, trust_weight, submitted_at,
         user_trust_profiles!inner(reputation_score)`,
      )
      .eq('terminal_id', terminalId)
      .gt('expires_at', new Date().toISOString())
      .order('submitted_at', { ascending: false })
      .limit(200),
    fetchTsaWaitMinutes(terminalId),
  ]);

  if (checksResult.error) {
    console.error('Supabase error', checksResult.error);
    return res.status(500).json({ error: 'Database error' });
  }

  // Flatten the joined reputation_score onto each check
  const enriched: EnrichedLiveCheck[] = (checksResult.data ?? []).map((row) => ({
    id: row.id,
    terminal_id: row.terminal_id,
    user_id: row.user_id,
    wait_minutes: row.wait_minutes,
    user_location: null,
    is_geofenced: row.is_geofenced,
    trust_weight: row.trust_weight,
    submitted_at: row.submitted_at,
    expires_at: '',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reputation_score: (row as any).user_trust_profiles?.reputation_score ?? 1.0,
  }));

  const result = computeWeightedWaitTime(enriched, tsaMinutes);

  // ── Persist snapshot to DB + cache ───────────────────────
  await Promise.all([
    supabase.from('wait_time_snapshots').insert({
      terminal_id: terminalId,
      source: result.source === 'no_data' ? 'tsa_official' : result.source,
      wait_minutes: result.estimatedWaitMinutes,
      confidence_score: result.confidenceScore,
      sample_size: result.sampleSize,
      tsa_raw_minutes: result.tsaRawMinutes,
    }),
    redis.setex(cacheKey, CACHE_TTL.WAIT_TIME, result),
  ]);

  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json(result);
}
