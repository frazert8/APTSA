// ============================================================
// SwiftClear — TSA Wait Times API Adapter
//
// Production: fetches from tsawaittimes.com API.
//   - Requires TSA_API_KEY from https://www.tsawaittimes.com/register
//   - Key is embedded in the URL path: /api/airport/{KEY}/{IATA}/json
//   - Returns airport-level wait time; PreCheck lanes get a scaled estimate.
//
// Development (MOCK_TSA=true): returns realistic random data.
// Mapping is auto-populated from the terminals DB table
// via initTsaMappings() called once at API cold-start.
// ============================================================

import { supabase } from '../lib/supabase.js';
import { redis, CACHE_KEYS, CACHE_TTL } from '../lib/redis.js';

// tsawaittimes.com /api/airport/{KEY}/{CODE}/json response
interface TsaApiResponse {
  code:          string;
  name:          string;
  rightnow:      number;   // current wait in minutes (standard lane)
  user_reported: number;   // crowd-reported wait in minutes
  precheck:      number;   // 1 if PreCheck lane is available
}

interface TsaMapping {
  airportCode: string;
  isPreCheck:  boolean;
}

// terminalId → TSA API identifiers
const TSA_ID_MAP = new Map<string, TsaMapping>();

// ── Auto-populate from DB ─────────────────────────────────────
// Call once at module load / edge function warm-up.
export async function initTsaMappings(): Promise<void> {
  const { data, error } = await supabase
    .from('terminals')
    .select('id, is_precheck, airports!inner(iata_code)');

  if (error || !data) {
    console.error('[tsa-api] Failed to load terminal mappings', error);
    return;
  }

  for (const row of data) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const iata = (row as any).airports?.iata_code as string | undefined;
    if (!iata) continue;
    TSA_ID_MAP.set(row.id, {
      airportCode: iata,
      isPreCheck:  row.is_precheck ?? false,
    });
  }

  console.log(`[tsa-api] Loaded ${TSA_ID_MAP.size} terminal mappings`);
}

// ── Dev mock data ─────────────────────────────────────────────
function getMockWaitMinutes(isPreCheck = false): number {
  const hour = new Date().getHours();
  const isPeakMorning = hour >= 5  && hour <= 8;
  const isPeakEvening = hour >= 16 && hour <= 19;
  const isNightQuiet  = hour >= 23 || hour <= 4;

  let base: number;
  if (isPeakMorning || isPeakEvening) base = 15 + Math.floor(Math.random() * 35); // 15–50
  else if (isNightQuiet)              base = 2  + Math.floor(Math.random() * 8);  // 2–10
  else                                base = 8  + Math.floor(Math.random() * 22); // 8–30

  // PreCheck is typically 25% of standard lane
  return isPreCheck ? Math.max(2, Math.round(base * 0.25)) : base;
}

// ── Main export ───────────────────────────────────────────────
export async function fetchTsaWaitMinutes(terminalId: string): Promise<number | null> {
  const apiKey = process.env['TSA_API_KEY'];

  // ── Dev mock (no key set, or explicitly enabled) ──────────
  if (process.env['MOCK_TSA'] === 'true' || !apiKey) {
    const isPreCheck = TSA_ID_MAP.get(terminalId)?.isPreCheck ?? false;
    const mock = getMockWaitMinutes(isPreCheck);
    await redis.setex(CACHE_KEYS.tsaRaw(terminalId), CACHE_TTL.TSA_RAW, mock);
    return mock;
  }

  // ── Cache hit ─────────────────────────────────────────────
  const cacheKey = CACHE_KEYS.tsaRaw(terminalId);
  const cached = await redis.get<number>(cacheKey);
  if (cached !== null) return cached;

  // ── Mapping lookup ────────────────────────────────────────
  if (!TSA_ID_MAP.has(terminalId)) {
    await initTsaMappings();
  }
  const m = TSA_ID_MAP.get(terminalId);
  if (!m) return null;

  try {
    // tsawaittimes.com API: key is a path segment, not a header
    const url = `https://www.tsawaittimes.com/api/airport/${apiKey}/${m.airportCode}/json`;

    const resp = await fetch(url, {
      headers: { 'User-Agent': 'SwiftClear/1.0 (+https://swiftclear.app)' },
      signal: AbortSignal.timeout(4000),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as TsaApiResponse;
    const standardWait = data.rightnow ?? 0;

    // PreCheck lanes are typically ~25% of the standard lane wait
    const minutes = m.isPreCheck
      ? Math.max(2, Math.round(standardWait * 0.25))
      : standardWait;

    await redis.setex(cacheKey, CACHE_TTL.TSA_RAW, minutes);
    return minutes;
  } catch {
    return null;
  }
}
