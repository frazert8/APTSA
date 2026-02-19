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
  const cached = await redis.get<WeightedWaitResult>(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  const [checksResult, tsaMinutes] = await Promise.all([
    supabase
      .from('live_checks')
      .select(
        `id, terminal_id, user_id, wait_minutes, is_geofenced, trust_weight,
         submitted_at, user_trust_profiles!inner(reputation_score)`,
      )
      .eq('terminal_id', terminalId)
      .gt('expires_at', new Date().toISOString())
      .order('submitted_at', { ascending: false })
      .limit(200),
    fetchTsaWaitMinutes(terminalId),
  ]);

  if (checksResult.error) return res.status(500).json({ error: 'Database error' });

  const enriched: EnrichedLiveCheck[] = (checksResult.data ?? []).map((row) => ({
    id:             row.id,
    terminal_id:    row.terminal_id,
    user_id:        row.user_id,
    wait_minutes:   row.wait_minutes,
    user_location:  null,
    is_geofenced:   row.is_geofenced,
    trust_weight:   row.trust_weight,
    submitted_at:   row.submitted_at,
    expires_at:     '',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reputation_score: (row as any).user_trust_profiles?.reputation_score ?? 1.0,
  }));

  const result = computeWeightedWaitTime(enriched, tsaMinutes);

  await Promise.all([
    supabase.from('wait_time_snapshots').insert({
      terminal_id:      terminalId,
      source:           result.source === 'no_data' ? 'tsa_official' : result.source,
      wait_minutes:     result.estimatedWaitMinutes,
      confidence_score: result.confidenceScore,
      sample_size:      result.sampleSize,
      tsa_raw_minutes:  result.tsaRawMinutes,
    }),
    redis.setex(cacheKey, CACHE_TTL.WAIT_TIME, result),
  ]);

  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json(result);
}
