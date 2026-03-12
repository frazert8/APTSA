// ============================================================
// SwiftClear — TSA Wait Times API Adapter
//
// Priority chain (first success wins):
//   1. TSAWaitTimes.com (paid)  — rightnow minutes + hourly forecast
//   2. MyTSA / DHS API (free)   — crowdsourced, 10-min bucket fallback
//   3. Time-of-day mock          — last resort for dev / API outages
//
// Caching: airport-level Redis key shared across all terminals at
// the same airport → N terminals = 1 external API call, not N.
// ============================================================

import { supabase } from '../lib/supabase.js';
import { redis, CACHE_TTL } from '../lib/redis.js';

// ── TSAWaitTimes.com response ────────────────────────────────
interface TsaApiResponse {
  code:          string;
  rightnow:      number;
  user_reported: number;
}

// ── MyTSA (DHS) response ─────────────────────────────────────
interface MyTsaWaitTime {
  CheckpointIndex: string;
  WaitTimeIndex:   string;   // 0=no wait, 1=1-10, 2=11-20, 3=21-30, 4=31-45, 5=46-60, 6=60+
  Created_Datetime: string;
}

// Convert MyTSA bucket index → midpoint estimate in minutes
const MYTSA_BUCKET_MIDPOINTS: Record<string, number> = {
  '0': 0,
  '1': 5,
  '2': 15,
  '3': 25,
  '4': 37,
  '5': 53,
  '6': 70,
};

interface TsaMapping { airportCode: string }
const TSA_ID_MAP = new Map<string, TsaMapping>();

// ── Auto-populate terminal → airport mapping from DB ─────────
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

// ── Time-of-day mock (last resort) ──────────────────────────
function getMockWaitMinutes(): number {
  const hour = new Date().getHours();
  if (hour >= 5  && hour <= 8)  return 15 + Math.floor(Math.random() * 35);
  if (hour >= 16 && hour <= 19) return 15 + Math.floor(Math.random() * 35);
  if (hour >= 23 || hour <= 4)  return 2  + Math.floor(Math.random() * 8);
  return 8 + Math.floor(Math.random() * 22);
}

// ── Source 1: TSAWaitTimes.com ────────────────────────────────
async function fetchTsaWaitTimesApi(airportCode: string, apiKey: string): Promise<number | null> {
  const cacheKey = `tsaAirport:${airportCode}`;
  const cached   = await redis.get<number>(cacheKey);
  if (cached !== null) return cached;

  try {
    const url  = `https://www.tsawaittimes.com/api/airport/${apiKey}/${airportCode}/json`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'SwiftClear/1.0 (+https://swiftclear.app)' },
      signal:  AbortSignal.timeout(4_000),
    });
    if (!resp.ok) return null;

    const data    = (await resp.json()) as TsaApiResponse;
    const minutes = data.rightnow ?? 0;
    await redis.setex(cacheKey, CACHE_TTL.TSA_RAW, minutes);
    return minutes;
  } catch {
    return null;
  }
}

// ── Source 2: MyTSA / DHS (free, no API key) ─────────────────
// Docs (archived): https://www.dhs.gov/archive/mytsa-api-documentation
// Returns bucketed wait times from crowdsourced reports.
async function fetchMyTsaWaitMinutes(airportCode: string): Promise<number | null> {
  const cacheKey = `myTsaAirport:${airportCode}`;
  const cached   = await redis.get<number>(cacheKey);
  if (cached !== null) return cached;

  try {
    // GetTSOWaitTimes uses TSO (officer) reported times — slightly more authoritative
    const url  = `https://apps.tsa.dhs.gov/MyTSAWebService/GetTSOWaitTimes.ashx?ap=${airportCode}&output=json`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'SwiftClear/1.0' },
      signal:  AbortSignal.timeout(5_000),
    });
    if (!resp.ok) throw new Error(`MyTSA HTTP ${resp.status}`);

    const body: unknown = await resp.json();
    const waitTimes: MyTsaWaitTime[] = (body as { WaitTimes?: MyTsaWaitTime[] })?.WaitTimes ?? [];
    if (!waitTimes.length) return null;

    // Average across all checkpoints reported in the last 2 hours
    const cutoff    = Date.now() - 2 * 60 * 60 * 1_000;
    const recent    = waitTimes.filter((w) => {
      const ts = new Date(w.Created_Datetime).getTime();
      return !isNaN(ts) && ts > cutoff;
    });

    const source = recent.length ? recent : waitTimes.slice(0, 5);
    if (!source.length) return null;

    const total   = source.reduce((sum, w) => sum + (MYTSA_BUCKET_MIDPOINTS[w.WaitTimeIndex] ?? 10), 0);
    const minutes = Math.round(total / source.length);

    // Cache for 10 min (MyTSA data is less fresh)
    await redis.setex(cacheKey, 600, minutes);
    return minutes;
  } catch {
    return null;
  }
}

// ── Main export ───────────────────────────────────────────────
export async function fetchTsaWaitMinutes(terminalId: string): Promise<number | null> {
  const tsaKey = process.env['TSA_API_KEY'];

  // Dev mock when no keys configured
  if (process.env['MOCK_TSA'] === 'true' || (!tsaKey && !process.env['MYTSA_ENABLED'])) {
    return getMockWaitMinutes();
  }

  // Load airport mapping
  if (!TSA_ID_MAP.has(terminalId)) await initTsaMappings();
  const m = TSA_ID_MAP.get(terminalId);
  if (!m) return null;

  // 1. Try TSAWaitTimes.com
  if (tsaKey) {
    const result = await fetchTsaWaitTimesApi(m.airportCode, tsaKey);
    if (result !== null) return result;
    console.warn(`[tsa-api] TSAWaitTimes.com failed for ${m.airportCode}, trying MyTSA fallback`);
  }

  // 2. MyTSA fallback (always attempted if TSAWaitTimes.com fails or is unconfigured)
  const myTsaResult = await fetchMyTsaWaitMinutes(m.airportCode);
  if (myTsaResult !== null) return myTsaResult;

  // 3. Time-of-day mock
  console.warn(`[tsa-api] All sources failed for ${m.airportCode}, using mock`);
  return getMockWaitMinutes();
}
