// ============================================================
// POST /api/route
// Returns driving time + walk-to-gate for Leave-By calculation.
// Uses Mapbox Matrix API (can swap for Google Distance Matrix).
// Result cached in Redis keyed by origin cell (1km grid snap).
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { redis } from '../lib/redis.js';
import type { RouteResult } from '../types/index.js';

export const config = { runtime: 'edge' };

const MAPBOX_TOKEN = process.env['MAPBOX_ACCESS_TOKEN'];

// Snap coordinates to ~1km grid to maximise cache hits
function snapToGrid(val: number, precision = 2): number {
  return Math.round(val * (10 ** precision)) / (10 ** precision);
}

const RouteSchema = z.object({
  originLat:  z.number().min(-90).max(90),
  originLng:  z.number().min(-180).max(180),
  terminalId: z.string().uuid(),
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body: z.infer<typeof RouteSchema>;
  try {
    body = RouteSchema.parse(await req.body);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid body', details: e });
  }

  const { originLat, originLng, terminalId } = body;

  // ── Fetch terminal centroid + walk time from DB ──────────
  const { data: terminal, error } = await supabase
    .from('terminals')
    .select('walk_to_gate_avg_minutes, airport_id, airports!inner(location)')
    .eq('id', terminalId)
    .single();

  if (error || !terminal) return res.status(404).json({ error: 'Terminal not found' });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const airportLocation = (terminal as any).airports?.location as
    | { coordinates: [number, number] }
    | undefined;

  if (!airportLocation) return res.status(500).json({ error: 'Airport location unavailable' });

  const [destLng, destLat] = airportLocation.coordinates;

  // ── Cache key: snapped origin + terminal ─────────────────
  const sLat = snapToGrid(originLat);
  const sLng = snapToGrid(originLng);
  const cacheKey = `route:${sLat}:${sLng}:${terminalId}`;

  const cached = await redis.get<RouteResult>(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  // ── Mapbox Matrix API ─────────────────────────────────────
  if (!MAPBOX_TOKEN) return res.status(500).json({ error: 'Routing API not configured' });

  const coords = `${originLng},${originLat};${destLng},${destLat}`;
  const mapboxUrl =
    `https://api.mapbox.com/directions-matrix/v1/mapbox/driving-traffic/${coords}` +
    `?sources=0&destinations=1&annotations=duration,distance` +
    `&access_token=${MAPBOX_TOKEN}`;

  const mapboxRes = await fetch(mapboxUrl, { signal: AbortSignal.timeout(5000) });
  if (!mapboxRes.ok) return res.status(502).json({ error: 'Routing API error' });

  const mapboxData = await mapboxRes.json() as {
    durations: number[][];
    distances: number[][];
  };

  const drivingSeconds = mapboxData.durations[0]?.[0] ?? 0;
  const drivingMeters  = mapboxData.distances[0]?.[0] ?? 0;

  const result: RouteResult = {
    drivingMinutes:      Math.ceil(drivingSeconds / 60),
    drivingDistanceKm:   Math.round(drivingMeters / 100) / 10,
    walkToGateMinutes:   terminal.walk_to_gate_avg_minutes,
    lastCalculated:      new Date().toISOString(),
  };

  // Cache for 10 min (traffic changes but not dramatically)
  await redis.setex(cacheKey, 600, result);

  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json(result);
}
