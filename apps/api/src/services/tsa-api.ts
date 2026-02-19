// ============================================================
// SwiftClear — TSA Wait Times API Adapter
//
// Production: fetches from tsawaittimes.com API.
// Development (MOCK_TSA=true): returns realistic random data.
// Mapping is auto-populated from the terminals DB table
// via initTsaMappings() called once at API cold-start.
// ============================================================

import { supabase } from '../lib/supabase.js';
import { redis, CACHE_KEYS, CACHE_TTL } from '../lib/redis.js';

interface TsaApiCheckpoint {
  airportCode: string;
  terminal: string;
  checkpoint: string;
  currentWaitTime: number;
  averageWaitTime: number;
  maxWaitTime: number;
}

interface TsaMapping {
  airportCode: string;
  terminal: string;
  checkpoint: string;
}

// terminalId → TSA API identifiers
const TSA_ID_MAP = new Map<string, TsaMapping>();

// ── Auto-populate from DB ─────────────────────────────────────
// Call once at module load / edge function warm-up.
// Maps terminal.id → (airport IATA, terminal_code, checkpoint_name).
export async function initTsaMappings(): Promise<void> {
  const { data, error } = await supabase
    .from('terminals')
    .select('id, terminal_code, checkpoint_name, airports!inner(iata_code)');

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
      terminal:    row.terminal_code,
      checkpoint:  row.checkpoint_name,
    });
  }

  console.log(`[tsa-api] Loaded ${TSA_ID_MAP.size} terminal mappings`);
}

// ── Dev mock data ─────────────────────────────────────────────
// Returns a realistic time-of-day based wait estimate.
function getMockWaitMinutes(): number {
  const hour = new Date().getHours();
  // Peak hours: 5–8am, 4–7pm
  const isPeakMorning  = hour >= 5  && hour <= 8;
  const isPeakEvening  = hour >= 16 && hour <= 19;
  const isNightQuiet   = hour >= 23 || hour <= 4;

  if (isPeakMorning || isPeakEvening) return 15 + Math.floor(Math.random() * 35); // 15–50
  if (isNightQuiet)                   return 2  + Math.floor(Math.random() * 8);  // 2–10
  return 8 + Math.floor(Math.random() * 22); // 8–30 baseline
}

// ── Main export ───────────────────────────────────────────────
export async function fetchTsaWaitMinutes(terminalId: string): Promise<number | null> {
  // ── Dev mock ──────────────────────────────────────────────
  if (process.env['MOCK_TSA'] === 'true') {
    const mock = getMockWaitMinutes();
    await redis.setex(CACHE_KEYS.tsaRaw(terminalId), CACHE_TTL.TSA_RAW, mock);
    return mock;
  }

  // ── Cache hit ─────────────────────────────────────────────
  const cacheKey = CACHE_KEYS.tsaRaw(terminalId);
  const cached = await redis.get<number>(cacheKey);
  if (cached !== null) return cached;

  const mapping = TSA_ID_MAP.get(terminalId);
  if (!mapping) {
    // Mapping not loaded yet — try initialising now (cold start edge case)
    await initTsaMappings();
    const retry = TSA_ID_MAP.get(terminalId);
    if (!retry) return null;
  }

  const m = TSA_ID_MAP.get(terminalId)!;

  try {
    const url = new URL('https://www.tsawaittimes.com/api/airport');
    url.searchParams.set('airportCode', m.airportCode);

    const headers: Record<string, string> = {
      'User-Agent': 'SwiftClear/1.0 (+https://swiftclear.app)',
    };
    const tsaKey = process.env['TSA_API_KEY'];
    if (tsaKey) {
      headers['Authorization'] = `Bearer ${tsaKey}`;
      headers['x-api-key']     = tsaKey;
    }

    const resp = await fetch(url.toString(), {
      headers,
      signal: AbortSignal.timeout(4000),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as TsaApiCheckpoint[];
    const match = data.find(
      (d) =>
        d.airportCode === m.airportCode &&
        d.terminal    === m.terminal    &&
        d.checkpoint  === m.checkpoint,
    );

    if (!match) return null;

    const minutes = match.currentWaitTime;
    await redis.setex(cacheKey, CACHE_TTL.TSA_RAW, minutes);
    return minutes;
  } catch {
    return null;
  }
}
