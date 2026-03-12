// ============================================================
// SwiftClear — ML Wait Time Predictor
//
// When live TSA sources are unavailable or return no data,
// this module estimates wait times from historical snapshots
// using weighted k-NN regression over circular time features.
//
// Algorithm:
//   1. Fetch up to 200 non-zero snapshots for this terminal
//      from the last 28 days (Supabase).
//   2. For each historical row, compute a composite weight:
//        w = kernel(dist) × recency_decay × confidence_score
//      where dist is the Euclidean distance in circular
//      (hour_sin, hour_cos, dow_sin, dow_cos) feature space.
//   3. Return the weighted mean as the predicted wait.
//   4. If the terminal has < MIN_SAMPLES rows, widen the
//      scope to the whole airport (sibling terminals).
//   5. Final fallback: deterministic hour-of-day baseline
//      derived from FAA national average traffic curves.
//      Returns 0 only during the 12 am – 4 am quiet window.
//
// Results cached 15 min per (terminal, hour, day-of-week).
// ============================================================

import { supabase } from '../lib/supabase.js';
import { redis } from '../lib/redis.js';

// ── Constants ────────────────────────────────────────────────
const MIN_SAMPLES        = 5;    // below this, fall back to airport-level model
const RECENCY_HALF_LIFE  = 7;    // days — older snapshots decay exponentially
const CACHE_TTL_SECONDS  = 900;  // 15 min prediction cache
const LOOKBACK_DAYS      = 28;
const QUIET_HOUR_START   = 0;    // midnight
const QUIET_HOUR_END     = 4;    // 4 am (exclusive)

export type PredictionSource = 'ml_terminal' | 'ml_airport' | 'baseline';

export interface PredictionResult {
  minutes:  number;
  source:   PredictionSource;
  samples:  number;   // rows used; 0 for baseline
}

// ── Circular feature encoding ────────────────────────────────
// Encodes hour (period 24) or day-of-week (period 7) onto the
// unit circle so that 23:00 and 01:00 are close, not distant.
function circular(value: number, period: number): [number, number] {
  const angle = (2 * Math.PI * value) / period;
  return [Math.sin(angle), Math.cos(angle)];
}

// Distance in 4-D circular time space.
// Hour is weighted 3× DOW because within-day patterns dominate.
function timeDistance(h1: number, dow1: number, h2: number, dow2: number): number {
  const [hs1, hc1] = circular(h1, 24);
  const [hs2, hc2] = circular(h2, 24);
  const [ds1, dc1] = circular(dow1, 7);
  const [ds2, dc2] = circular(dow2, 7);

  const hourDist = Math.sqrt((hs1 - hs2) ** 2 + (hc1 - hc2) ** 2); // ∈ [0, √2]
  const dowDist  = Math.sqrt((ds1 - ds2) ** 2 + (dc1 - dc2) ** 2); // ∈ [0, √2]
  return 3 * hourDist + dowDist;
}

// Exponential recency decay: weight = 0.5^(daysAgo / halfLife)
function recencyDecay(capturedAt: string, now: Date): number {
  const daysAgo = (now.getTime() - new Date(capturedAt).getTime()) / 86_400_000;
  return Math.pow(0.5, daysAgo / RECENCY_HALF_LIFE);
}

// ── Weighted k-NN regression ─────────────────────────────────
interface Snapshot {
  wait_minutes:    number;
  confidence_score: number;
  captured_at:     string;
  hour:            number;
  dow:             number;
}

function weightedKnn(rows: Snapshot[], targetHour: number, targetDow: number, now: Date): number {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const row of rows) {
    const dist    = timeDistance(targetHour, targetDow, row.hour, row.dow);
    // Gaussian-like kernel with small epsilon to avoid ÷0 when dist≈0
    const kernel  = 1 / (dist ** 2 + 0.01);
    const recency = recencyDecay(row.captured_at, now);
    const conf    = Math.max(0.10, row.confidence_score);
    const w       = kernel * recency * conf;

    weightedSum += row.wait_minutes * w;
    totalWeight += w;
  }

  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
}

// ── Supabase data fetching ────────────────────────────────────
async function fetchTerminalSnapshots(terminalId: string): Promise<Snapshot[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from('wait_time_snapshots')
    .select('wait_minutes, confidence_score, captured_at')
    .eq('terminal_id', terminalId)
    .gt('wait_minutes', 0)
    .gt('captured_at', since)
    .order('captured_at', { ascending: false })
    .limit(200);

  if (error || !data?.length) return [];

  return data.map((row) => {
    const d = new Date(row.captured_at);
    return {
      wait_minutes:    row.wait_minutes,
      confidence_score: row.confidence_score ?? 0.5,
      captured_at:     row.captured_at,
      hour:            d.getHours(),
      dow:             d.getDay(),
    };
  });
}

async function fetchAirportSnapshots(terminalId: string): Promise<Snapshot[]> {
  // Resolve airport_id from one of this terminal's siblings
  const { data: term } = await supabase
    .from('terminals')
    .select('airport_id')
    .eq('id', terminalId)
    .single();

  if (!term?.airport_id) return [];

  const { data: siblings } = await supabase
    .from('terminals')
    .select('id')
    .eq('airport_id', term.airport_id);

  if (!siblings?.length) return [];

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const ids   = siblings.map((s) => s.id);

  const { data, error } = await supabase
    .from('wait_time_snapshots')
    .select('wait_minutes, confidence_score, captured_at')
    .in('terminal_id', ids)
    .gt('wait_minutes', 0)
    .gt('captured_at', since)
    .order('captured_at', { ascending: false })
    .limit(400);

  if (error || !data?.length) return [];

  return data.map((row) => {
    const d = new Date(row.captured_at);
    return {
      wait_minutes:    row.wait_minutes,
      confidence_score: row.confidence_score ?? 0.5,
      captured_at:     row.captured_at,
      hour:            d.getHours(),
      dow:             d.getDay(),
    };
  });
}

// ── Deterministic hour-of-day baseline ───────────────────────
// Derived from FAA national average enplanement distributions.
// Used only when the DB has no historical rows for this airport.
// Maps hour → typical major-US-airport wait in minutes.
const HOUR_BASELINE: Readonly<Record<number, number>> = {
   4: 6,   5: 14,  6: 22,  7: 26,  8: 24,  9: 18,
  10: 14, 11: 14, 12: 14, 13: 13, 14: 13, 15: 14,
  16: 17, 17: 23, 18: 21, 19: 17, 20: 14, 21: 11,
  22: 9,  23: 6,
};

export function getBaselineWait(now: Date = new Date()): number {
  const hour = now.getHours();
  // Quiet window — returning 0 is accurate and acceptable
  if (hour >= QUIET_HOUR_START && hour < QUIET_HOUR_END) return 0;
  return HOUR_BASELINE[hour] ?? 10;
}

// ── Main export ───────────────────────────────────────────────
export async function predictWaitMinutes(
  terminalId: string,
  now: Date = new Date(),
): Promise<PredictionResult> {
  const hour = now.getHours();
  const dow  = now.getDay();

  // Quiet window — airport is genuinely near-empty; 0 is correct
  if (hour >= QUIET_HOUR_START && hour < QUIET_HOUR_END) {
    return { minutes: 0, source: 'baseline', samples: 0 };
  }

  // Cache key: one prediction per terminal per (hour, dow) slot
  const cacheKey = `predict:${terminalId}:${hour}:${dow}`;
  const cached   = await redis.get<PredictionResult>(cacheKey);
  if (cached) return cached;

  // ── 1. Terminal-level model ────────────────────────────────
  const termSnaps = await fetchTerminalSnapshots(terminalId);
  if (termSnaps.length >= MIN_SAMPLES) {
    const minutes = weightedKnn(termSnaps, hour, dow, now);
    if (minutes > 0) {
      const result: PredictionResult = { minutes, source: 'ml_terminal', samples: termSnaps.length };
      await redis.setex(cacheKey, CACHE_TTL_SECONDS, result);
      return result;
    }
  }

  // ── 2. Airport-level fallback model ───────────────────────
  const airportSnaps = await fetchAirportSnapshots(terminalId);
  if (airportSnaps.length >= MIN_SAMPLES) {
    const minutes = weightedKnn(airportSnaps, hour, dow, now);
    if (minutes > 0) {
      const result: PredictionResult = { minutes, source: 'ml_airport', samples: airportSnaps.length };
      await redis.setex(cacheKey, CACHE_TTL_SECONDS, result);
      return result;
    }
  }

  // ── 3. Static baseline (last resort) ──────────────────────
  const minutes = getBaselineWait(now);
  return { minutes, source: 'baseline', samples: 0 };
}
