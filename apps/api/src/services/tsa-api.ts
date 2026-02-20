// ============================================================
// SwiftClear — TSA Wait Times API Adapter
//
// Production: fetches from tsawaittimes.com API.
//   Key: https://www.tsawaittimes.com/register
//   Endpoint: /api/airport/{KEY}/{IATA}/json
//
// NOTE: The TSA API returns one wait time per airport, not per
// checkpoint. All checkpoints at the same airport will reflect
// the same airport-level reading. Per-checkpoint accuracy
// improves as crowd submissions accumulate.
//
// Caching: airport-level Redis key shared across all terminals
// at the same airport, so N terminals = 1 API call, not N.
// ============================================================

import { supabase } from '../lib/supabase.js';
import { redis, CACHE_TTL } from '../lib/redis.js';

interface TsaApiResponse {
  code:          string;
  rightnow:      number;  // current airport-level wait in minutes
  user_reported: number;
}

interface TsaMapping {
  airportCode: string;
}

// terminalId → airport IATA code
const TSA_ID_MAP = new Map<string, TsaMapping>();

// ── Auto-populate from DB ─────────────────────────────────────
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

// ── Dev mock data ─────────────────────────────────────────────
function getMockWaitMinutes(): number {
  const hour = new Date().getHours();
  const isPeakMorning = hour >= 5  && hour <= 8;
  const isPeakEvening = hour >= 16 && hour <= 19;
  const isNightQuiet  = hour >= 23 || hour <= 4;

  if (isPeakMorning || isPeakEvening) return 15 + Math.floor(Math.random() * 35);
  if (isNightQuiet)                   return 2  + Math.floor(Math.random() * 8);
  return 8 + Math.floor(Math.random() * 22);
}

// ── Airport-level TSA fetch (shared across all terminals) ─────
// Caches under tsaAirport:{IATA} so all terminals at an airport
// share one API call and one Redis key.
async function fetchAirportWaitMinutes(airportCode: string, apiKey: string): Promise<number | null> {
  const airportCacheKey = `tsaAirport:${airportCode}`;
  const cached = await redis.get<number>(airportCacheKey);
  if (cached !== null) return cached;

  try {
    const url = `https://www.tsawaittimes.com/api/airport/${apiKey}/${airportCode}/json`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'SwiftClear/1.0 (+https://swiftclear.app)' },
      signal: AbortSignal.timeout(4000),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as TsaApiResponse;
    const minutes = data.rightnow ?? 0;
    await redis.setex(airportCacheKey, CACHE_TTL.TSA_RAW, minutes);
    return minutes;
  } catch {
    return null;
  }
}

// ── Main export ───────────────────────────────────────────────
export async function fetchTsaWaitMinutes(terminalId: string): Promise<number | null> {
  const apiKey = process.env['TSA_API_KEY'];

  // ── Dev mock ──────────────────────────────────────────────
  if (process.env['MOCK_TSA'] === 'true' || !apiKey) {
    return getMockWaitMinutes();
  }

  // ── Load airport mapping ──────────────────────────────────
  if (!TSA_ID_MAP.has(terminalId)) {
    await initTsaMappings();
  }
  const m = TSA_ID_MAP.get(terminalId);
  if (!m) return null;

  return fetchAirportWaitMinutes(m.airportCode, apiKey);
}
