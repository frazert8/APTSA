// ============================================================
// SwiftClear — TSA Wait Times Adapter
//
// Priority chain (first non-zero result wins):
//   1. TSAWaitTimes.com — rightnow field from the paid API key
//   2. MyTSA / DHS      — free crowdsourced bucket data (recent only)
//   3. ML Predictor     — weighted k-NN on 28 days of snapshots
//   4. Baseline curve   — FAA traffic-distribution fallback
//
// Zeros are ONLY permitted during the quiet window (12 am – 4 am).
// Outside that window, the chain always resolves to a positive value.
//
// Caching: airport-level key for live sources (shared across all
// terminals at the same airport → N terminals = 1 API call, not N).
// ML predictions are cached per (terminal, hour, dow) for 15 min.
// ============================================================

import { supabase } from '../lib/supabase.js';
import { redis, CACHE_TTL } from '../lib/redis.js';
import { predictWaitMinutes, getBaselineWait, type PredictionSource } from './prediction.js';

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
  minutes:   number;
  // 'live'      — real-time data from TSAWaitTimes.com or MyTSA
  // 'predicted' — ML model or static baseline (no live data available)
  dataSource: 'live' | PredictionSource;
}

// ── MyTSA bucket → midpoint minutes ──────────────────────────
const MYTSA_MIDPOINTS: Record<string, number> = {
  '0': 0, '1': 5, '2': 15, '3': 25, '4': 37, '5': 53, '6': 70,
};

// ── Terminal → airport code mapping ──────────────────────────
interface TsaMapping { airportCode: string }
const TSA_ID_MAP = new Map<string, TsaMapping>();

export async function initTsaMappings(): Promise<void> {
  const { data, error } = await supabase
    .from('terminals')
    .select('id, airports!inner(iata_code)');

  if (error || !data) {
    console.error('[tsa-api] Failed to load terminal mappings', error);
    return;
  }

  for (const row of data) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const iata = (row as any).airports?.iata_code as string | undefined;
    if (!iata) continue;
    TSA_ID_MAP.set(row.id, { airportCode: iata });
  }

  console.log(`[tsa-api] Loaded ${TSA_ID_MAP.size} terminal mappings`);
}

// ── Quiet-window check ────────────────────────────────────────
// Returns true if the current time is in the 12 am – 4 am window
// where a genuine 0-minute wait is plausible.
function isQuietHour(): boolean {
  const h = new Date().getHours();
  return h >= 0 && h < 4;
}

// ── Source 1: TSAWaitTimes.com (paid) ────────────────────────
async function fetchTsaWaitTimesApi(airportCode: string, apiKey: string): Promise<number | null> {
  const cacheKey = `tsaAirport:${airportCode}`;
  const cached   = await redis.get<number>(cacheKey);
  // Only return from cache if it's a positive number
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

    // rightnow === 0 means the airport has no active reporting, not a genuine
    // zero-minute wait. Don't cache it; let the fallback chain provide a value.
    if (!minutes || minutes <= 0) return null;

    await redis.setex(cacheKey, CACHE_TTL.TSA_RAW, minutes);
    return minutes;
  } catch {
    return null;
  }
}

// ── Source 2: MyTSA / DHS (free) ─────────────────────────────
async function fetchMyTsaWaitMinutes(airportCode: string): Promise<number | null> {
  const cacheKey = `myTsaAirport:${airportCode}`;
  const cached   = await redis.get<number>(cacheKey);
  if (cached !== null && cached > 0) return cached;

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

    // Only use reports from the last 2 hours — stale overnight data averages
    // to 0 and would falsely report an empty queue during morning rush.
    const cutoff = Date.now() - 2 * 60 * 60 * 1_000;
    const recent = all.filter((w) => {
      const ts = new Date(w.Created_Datetime).getTime();
      return !isNaN(ts) && ts > cutoff;
    });

    if (!recent.length) return null;

    const total   = recent.reduce((sum, w) => sum + (MYTSA_MIDPOINTS[w.WaitTimeIndex] ?? 10), 0);
    const minutes = Math.round(total / recent.length);

    // If the average of recent data is still 0, treat as "no useful signal"
    if (minutes <= 0) return null;

    await redis.setex(cacheKey, 600, minutes);
    return minutes;
  } catch {
    return null;
  }
}

// ── Main export ───────────────────────────────────────────────
export async function fetchTsaWaitMinutes(terminalId: string): Promise<TsaFetchResult | null> {
  // MOCK_TSA=true forces the predictor's baseline for local dev
  if (process.env['MOCK_TSA'] === 'true') {
    const now = new Date();
    return { minutes: getBaselineWait(now), dataSource: 'baseline' };
  }

  // Resolve terminal → airport code
  if (!TSA_ID_MAP.has(terminalId)) await initTsaMappings();
  const m = TSA_ID_MAP.get(terminalId);
  if (!m) return null;  // genuinely unknown terminal — caller decides

  const tsaKey = process.env['TSA_API_KEY'];

  // ── 1. Paid TSAWaitTimes.com ──────────────────────────────
  if (tsaKey) {
    const live = await fetchTsaWaitTimesApi(m.airportCode, tsaKey);
    if (live !== null && live > 0) {
      return { minutes: live, dataSource: 'live' };
    }
    console.info(`[tsa-api] TSAWaitTimes.com returned no data for ${m.airportCode}`);
  }

  // ── 2. MyTSA / DHS free fallback ─────────────────────────
  const myTsa = await fetchMyTsaWaitMinutes(m.airportCode);
  if (myTsa !== null && myTsa > 0) {
    return { minutes: myTsa, dataSource: 'live' };
  }
  console.info(`[tsa-api] MyTSA returned no usable data for ${m.airportCode}`);

  // ── 3. ML predictor (k-NN on historical snapshots) ────────
  // Returns 0 only inside the quiet window (12 am – 4 am).
  const prediction = await predictWaitMinutes(terminalId);
  if (prediction.minutes > 0 || isQuietHour()) {
    return { minutes: prediction.minutes, dataSource: prediction.source };
  }

  // ── 4. Absolute safety net ────────────────────────────────
  // predictWaitMinutes already returns baseline as its own final
  // step, but this guards against any edge case where all paths
  // return 0 outside the quiet window.
  const baseline = getBaselineWait();
  console.warn(`[tsa-api] All sources returned 0 outside quiet window for ${m.airportCode} — using baseline`);
  return { minutes: Math.max(baseline, 5), dataSource: 'baseline' };
}
