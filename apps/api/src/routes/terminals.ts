// ============================================================
// GET /api/terminals?airportIata=ATL
// Returns terminals for a given airport, served from Redis cache.
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { supabase } from '../lib/supabase.js';
import { redis, CACHE_KEYS, CACHE_TTL } from '../lib/redis.js';
import type { Terminal } from '../types/index.js';

export const config = { runtime: 'edge' };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')  return res.status(405).json({ error: 'Method not allowed' });

  const iata = (req.query['airportIata'] as string | undefined)?.toUpperCase().trim();
  if (!iata || iata.length !== 3) {
    return res.status(400).json({ error: 'airportIata must be a 3-letter IATA code' });
  }

  // ── Cache hit ────────────────────────────────────────────
  // Key by airport IATA, not airport UUID, so mobile can call without prior DB lookup
  const cacheKey = `terminals_iata:${iata}`;
  const cached = await redis.get<Terminal[]>(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  // ── Fetch from Supabase ───────────────────────────────────
  const { data, error } = await supabase
    .from('terminals')
    .select(
      `id, airport_id, terminal_code, checkpoint_name, is_precheck, walk_to_gate_avg_minutes,
       airports!inner(iata_code)`,
    )
    .eq('airports.iata_code', iata)
    .order('display_order');

  if (error) {
    console.error('terminals fetch error', error);
    return res.status(500).json({ error: 'Database error' });
  }

  if (!data?.length) return res.status(404).json({ error: `No terminals found for ${iata}` });

  const terminals: Terminal[] = data.map((row) => ({
    id:                      row.id,
    airport_id:              row.airport_id,
    terminal_code:           row.terminal_code,
    checkpoint_name:         row.checkpoint_name,
    is_precheck:             row.is_precheck,
    walk_to_gate_avg_minutes: row.walk_to_gate_avg_minutes,
  }));

  await redis.setex(cacheKey, CACHE_TTL.TERMINALS, terminals);
  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json(terminals);
}
