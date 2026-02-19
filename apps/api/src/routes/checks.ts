// ============================================================
// POST /api/checks
// Submit a crowdsourced live check.
// The backend verifies geofencing server-side (never trust client).
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { redis, CACHE_KEYS } from '../lib/redis.js';

export const config = { runtime: 'edge' };

const SubmitCheckSchema = z.object({
  terminalId:  z.string().uuid(),
  waitMinutes: z.number().int().min(0).max(240),
  userLat:     z.number().min(-90).max(90).optional(),
  userLng:     z.number().min(-180).max(180).optional(),
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth ─────────────────────────────────────────────────
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  const jwt = authHeader.slice(7);

  const { data: { user }, error: authError } = await supabase.auth.getUser(jwt);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  // ── Validate body ────────────────────────────────────────
  let body: z.infer<typeof SubmitCheckSchema>;
  try {
    body = SubmitCheckSchema.parse(await req.body);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid request body', details: e });
  }

  const { terminalId, waitMinutes, userLat, userLng } = body;

  // ── Server-side geofence check (PostGIS) ─────────────────
  let isGeofenced = false;
  if (userLat !== undefined && userLng !== undefined) {
    const { data: geofenceResult } = await supabase
      .rpc('is_point_in_terminal_geofence', {
        p_terminal_id: terminalId,
        p_lng: userLng,
        p_lat: userLat,
      });
    isGeofenced = geofenceResult === true;
  }

  // ── Fetch submitter reputation ────────────────────────────
  const { data: profile } = await supabase
    .from('user_trust_profiles')
    .select('reputation_score')
    .eq('user_id', user.id)
    .single();

  const reputationScore = profile?.reputation_score ?? 1.0;

  // Composite trust_weight stored on the row for fast weighted queries
  const geofenceBoost = isGeofenced ? 2.5 : 1.0;
  const trustWeight = Math.min(3.0, reputationScore * geofenceBoost);

  // ── Insert live_check ─────────────────────────────────────
  const { data: check, error: insertError } = await supabase
    .from('live_checks')
    .insert({
      terminal_id: terminalId,
      user_id: user.id,
      wait_minutes: waitMinutes,
      user_location:
        userLat !== undefined && userLng !== undefined
          ? `POINT(${userLng} ${userLat})`
          : null,
      is_geofenced: isGeofenced,
      trust_weight: trustWeight,
    })
    .select()
    .single();

  if (insertError) {
    // Unique constraint hit = rate-limit violation
    if (insertError.code === '23514') {
      return res.status(429).json({ error: 'You can submit once per 15 minutes per terminal' });
    }
    console.error('Insert error', insertError);
    return res.status(500).json({ error: 'Failed to save check' });
  }

  // ── Bust the wait-time cache so next read recomputes ──────
  await redis.del(CACHE_KEYS.waitTime(terminalId));

  return res.status(201).json({
    checkId: check.id,
    isGeofenced,
    trustWeight,
    expiresAt: check.expires_at,
  });
}
