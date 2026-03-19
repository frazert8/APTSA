// ============================================================
// SwiftClear — TSA Wait Times Adapter
//
// Priority chain (first non-zero result wins):
//   1. TSAWaitTimes.com — rightnow field from the paid API key
//   2. MyTSA / DHS      — per-checkpoint crowdsourced data mapped
//                         to this terminal by sort-order position
//   3. ML Predictor     — weighted k-NN on 28 days of per-terminal
//                         snapshots, with a per-terminal load factor
//   4. Baseline curve   — FAA traffic-distribution fallback with
//                         a stable per-terminal offset so different
//                         checkpoints never return the same number
//
// Zeros are ONLY permitted during the quiet window (12 am – 4 am).
// Outside that window, the chain always resolves to a positive value.
//
// Caching:
//   Live sources:   airport-level key (1 API call per airport, not N)
//   Per-checkpoint: airport-level array, terminal selects its slice
//   ML prediction:  per-terminal key (each terminal caches separately)
// ============================================================

import { supabase } from '../lib/supabase.js';
import { redis, CACHE_TTL } from '../lib/redis.js';
import { predictWaitMinutes, getBaselineWait, terminalLoadFactor, type PredictionSource } from './prediction.js';

// ── Types ─────────────────────────────────────────────────────

interface TsaApiResponse {
  code:          string;
  rightnow:      number;
  user_reported: number;
}

interface MyTsaWaitTime {
  CheckpointIndex:  string;
  WaitTimeIndex:    string;  // 0=no wait, 1=1-10, 2=11-20, 3=21-30, 4=31-45, 5=46-60, 6=60+
  Created_Datetime: string;
}

// What gets returned to the wait-times handler
export interface TsaFetchResult {
  minutes:    number;
  // 'live'      — real-time data from TSAWaitTimes.com or MyTSA
  // 'predicted' — ML model or static baseline (no live data available)
  dataSource: 'live' | PredictionSource;
  samples:    number;  // training rows used (0 for live and baseline)
}

// ── MyTSA bucket → midpoint minutes ──────────────────────────
const MYTSA_MIDPOINTS: Record<string, number> = {
  '0': 0, '1': 5, '2': 15, '3': 25, '4': 37, '5': 53, '6': 70,
};

// ── Terminal → airport code mapping ──────────────────────────
interface TsaMapping { airportCode: string; airportId: string }
const TSA_ID_MAP = new Map<string, TsaMapping>();

export async function initTsaMappings(): Promise<void> {
  const { data, error } = await supabase
    .from('terminals')
    .select('id, airports!inner(iata_code, id)');

  if (error || !data) {
    console.error('[tsa-api] Failed to load terminal mappings', error);
    return;
  }

  for (const row of data) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ap = (row as any).airports as { iata_code: string; id: string } | undefined;
    if (!ap?.iata_code) continue;
    TSA_ID_MAP.set(row.id, { airportCode: ap.iata_code, airportId: ap.id });
  }

  console.log(`[tsa-api] Loaded ${TSA_ID_MAP.size} terminal mappings`);
}

// ── Quiet-window check ────────────────────────────────────────
function isQuietHour(): boolean {
  const h = new Date().getHours();
  return h >= 0 && h < 4;
}

// ── Source 1: TSAWaitTimes.com (paid, airport-level) ─────────
async function fetchTsaWaitTimesApi(airportCode: string, apiKey: string): Promise<number | null> {
  const cacheKey = `tsaAirport:${airportCode}`;
  const cached   = await redis.get<number>(cacheKey);
  if (cached !== null && cached > 0) return cached;

  try {
    const url  = `https://www.tsawaittimes.com/api/airport/${apiKey}/${airportCode}/json`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'SwiftClear/1.0 (+https://swiftclear.app)' },
      signal:  AbortSignal.timeout(4_000),
    });
    if (!resp.ok) return null;

    const data    = (await resp.json()) as TsaApiResponse;
    const minutes = data.rightnow;
    if (!minutes || minutes <= 0) return null;

    await redis.setex(cacheKey, CACHE_TTL.TSA_RAW, minutes);
    return minutes;
  } catch {
    return null;
  }
}

// ── Source 2: MyTSA / DHS (free, per-checkpoint) ─────────────
// Returns an array of wait-minutes ordered by CheckpointIndex asc.
// At a 5-terminal airport this typically yields [n0, n1, n2, n3, n4].
// Callers map their terminal's position-order to the matching index.
async function fetchMyTsaCheckpoints(airportCode: string): Promise<number[] | null> {
  const cacheKey = `myTsaCheckpoints:${airportCode}`;
  const cached   = await redis.get<number[]>(cacheKey);
  if (cached) return cached;

  try {
    const url  = `https://apps.tsa.dhs.gov/MyTSAWebService/GetTSOWaitTimes.ashx?ap=${airportCode}&output=json`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'SwiftClear/1.0' },
      signal:  AbortSignal.timeout(5_000),
    });
    if (!resp.ok) throw new Error(`MyTSA HTTP ${resp.status}`);

    const body: unknown = await resp.json();
    const all: MyTsaWaitTime[] = (body as { WaitTimes?: MyTsaWaitTime[] })?.WaitTimes ?? [];
    if (!all.length) return null;

    // Only use reports from the last 2 hours
    const cutoff = Date.now() - 2 * 60 * 60 * 1_000;
    const recent = all.filter((w) => {
      const ts = new Date(w.Created_Datetime).getTime();
      return !isNaN(ts) && ts > cutoff;
    });
    if (!recent.length) return null;

    // Group by CheckpointIndex, compute per-checkpoint average
    const byIdx = new Map<number, number[]>();
    for (const w of recent) {
      const idx = parseInt(w.CheckpointIndex ?? '0', 10);
      if (!byIdx.has(idx)) byIdx.set(idx, []);
      byIdx.get(idx)!.push(MYTSA_MIDPOINTS[w.WaitTimeIndex] ?? 10);
    }

    if (byIdx.size === 0) return null;

    // Sort by checkpoint index → stable positional mapping
    const sorted  = [...byIdx.entries()].sort(([a], [b]) => a - b);
    const minutes = sorted.map(([, vals]) =>
      Math.round(vals.reduce((s, v) => s + v, 0) / vals.length),
    );

    // If every checkpoint reports 0 mins, treat as "no signal"
    if (minutes.every((v) => v === 0)) return null;

    await redis.setex(cacheKey, 600, minutes);
    return minutes;
  } catch {
    return null;
  }
}

// ── Terminal sort-order resolver ──────────────────────────────
// Returns 0-based index of this terminal among all terminals at the
// same airport, sorted by checkpoint_name. Used to index into the
// MyTSA per-checkpoint array.
async function terminalPositionAt(terminalId: string, airportId: string): Promise<number> {
  const cacheKey = `terminalPos:${airportId}`;
  const cached   = await redis.get<string[]>(cacheKey);

  let orderedIds: string[];
  if (cached) {
    orderedIds = cached;
  } else {
    const { data } = await supabase
      .from('terminals')
      .select('id')
      .eq('airport_id', airportId)
      .order('checkpoint_name', { ascending: true });
    orderedIds = (data ?? []).map((r) => r.id);
    // Cache for 1 hour — terminal list changes rarely
    if (orderedIds.length) await redis.setex(cacheKey, 3600, orderedIds);
  }

  const idx = orderedIds.indexOf(terminalId);
  return idx < 0 ? 0 : idx;
}

// ── Main export ───────────────────────────────────────────────
export async function fetchTsaWaitMinutes(terminalId: string): Promise<TsaFetchResult | null> {
  if (process.env['MOCK_TSA'] === 'true') {
    const now = new Date();
    const base = getBaselineWait(now);
    const lf   = terminalLoadFactor(terminalId);
    return { minutes: Math.max(1, Math.round(base * lf)), dataSource: 'baseline', samples: 0 };
  }

  if (!TSA_ID_MAP.has(terminalId)) await initTsaMappings();
  const m = TSA_ID_MAP.get(terminalId);
  if (!m) return null;

  const tsaKey = process.env['TSA_API_KEY'];
  const pos    = await terminalPositionAt(terminalId, m.airportId);
  const lf     = terminalLoadFactor(terminalId);

  // ── 1. Paid TSAWaitTimes.com (airport-level, apply per-terminal load factor) ──
  if (tsaKey) {
    const airportAvg = await fetchTsaWaitTimesApi(m.airportCode, tsaKey);
    if (airportAvg !== null && airportAvg > 0) {
      const minutes = Math.max(1, Math.round(airportAvg * lf));
      return { minutes, dataSource: 'live', samples: 0 };
    }
    console.info(`[tsa-api] TSAWaitTimes.com returned no data for ${m.airportCode}`);
  }

  // ── 2. MyTSA per-checkpoint data ─────────────────────────────────────────────
  const checkpoints = await fetchMyTsaCheckpoints(m.airportCode);
  if (checkpoints && checkpoints.length > 0) {
    // Map terminal position to checkpoint index (wrap if more terminals than checkpoints)
    const cpIdx   = pos % checkpoints.length;
    const minutes = checkpoints[cpIdx] ?? 0;
    if (minutes > 0) {
      return { minutes, dataSource: 'live', samples: 0 };
    }
  }
  console.info(`[tsa-api] MyTSA returned no usable data for ${m.airportCode}`);

  // ── 3. ML predictor (per-terminal k-NN on historical snapshots) ──────────────
  const prediction = await predictWaitMinutes(terminalId);
  if (prediction.minutes > 0 || isQuietHour()) {
    return { minutes: prediction.minutes, dataSource: prediction.source, samples: prediction.samples };
  }

  // ── 4. Absolute safety net ────────────────────────────────────────────────────
  const baseline = getBaselineWait();
  const minutes  = Math.max(1, Math.round(baseline * lf));
  console.warn(`[tsa-api] All sources returned 0 outside quiet window for ${m.airportCode}`);
  return { minutes, dataSource: 'baseline', samples: 0 };
}
