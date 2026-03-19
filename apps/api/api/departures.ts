// ============================================================
// APTSA -- Airport Departures & Delay Intelligence
//
// Combines two data sources:
//   • AviationStack  — remaining scheduled departure count
//   • FlightAware AeroAPI — active delay programs (TMIs)
//
// GET /api/departures?airportIata=ATL
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { redis } from '../src/lib/redis.js';

// IATA → ICAO mapping for FlightAware (uses ICAO codes)
const IATA_TO_ICAO: Record<string, string> = {
  ATL: 'KATL', BOS: 'KBOS', CLT: 'KCLT', ORD: 'KORD', DFW: 'KDFW',
  DEN: 'KDEN', LAS: 'KLAS', LAX: 'KLAX', MIA: 'KMIA', MSP: 'KMSP',
  JFK: 'KJFK', MCO: 'KMCO', PHX: 'KPHX', SFO: 'KSFO', SEA: 'KSEA',
};

// ── FlightAware delay program ─────────────────────────────────
interface FaDelay {
  category:    string;
  color:       'GREEN' | 'YELLOW' | 'RED';
  delay_secs:  number;
  reasons:     string[];
  airport:     string;
}

// ── Normalised output ─────────────────────────────────────────
export interface DepartureInfo {
  iata:     string;
  remaining: number;          // scheduled departures still to go today
  delays:   DelayAlert[];     // active FAA delay programs
  sources:  string[];         // which APIs returned data
  cachedAt: string;
}

export interface DelayAlert {
  type:    string;            // e.g. "Ground Stop", "Ground Delay Program"
  color:   string;            // GREEN | YELLOW | RED
  delayMin: number;           // average delay minutes
  reasons: string[];
}

// ── AviationStack: count remaining scheduled departures ──────
async function fetchRemainingDepartures(iata: string, apiKey: string): Promise<number | null> {
  try {
    // Use pagination.total to get full count without fetching all records
    const url = `http://api.aviationstack.com/v1/flights?access_key=${apiKey}`
      + `&dep_iata=${iata}&flight_status=scheduled&limit=1`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!resp.ok) return null;

    const json = (await resp.json()) as { pagination?: { total?: number } };
    return json.pagination?.total ?? null;
  } catch {
    return null;
  }
}

// ── FlightAware: active delay programs at airport ─────────────
async function fetchDelayPrograms(icao: string, faKey: string): Promise<DelayAlert[]> {
  try {
    const url  = `https://aeroapi.flightaware.com/aeroapi/airports/${icao}/delays`;
    const resp = await fetch(url, {
      headers: { 'x-apikey': faKey },
      signal:  AbortSignal.timeout(5_000),
    });
    if (resp.status === 404) return [];   // no delays = 404 on this endpoint
    if (!resp.ok) throw new Error(`FlightAware delays HTTP ${resp.status}`);

    const json = (await resp.json()) as { delays?: FaDelay[] };
    return (json.delays ?? []).map((d) => ({
      type:     d.category,
      color:    d.color,
      delayMin: Math.round(d.delay_secs / 60),
      reasons:  d.reasons,
    }));
  } catch {
    return [];
  }
}

// ── Handler ───────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const iata = (req.query['airportIata'] as string | undefined)?.toUpperCase().trim();
  if (!iata || iata.length !== 3) {
    return res.status(400).json({ error: 'airportIata required (e.g. ATL)' });
  }

  const cacheKey = `departures:${iata}`;
  const cached   = await redis.get<DepartureInfo>(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  const asKey = process.env['AVIATIONSTACK_API_KEY'];
  const faKey = process.env['FLIGHTAWARE_API_KEY'];
  const icao  = IATA_TO_ICAO[iata];
  const sources: string[] = [];

  // Run both in parallel
  const [remainingResult, delaysResult] = await Promise.allSettled([
    asKey ? fetchRemainingDepartures(iata, asKey) : Promise.resolve(null),
    (faKey && icao) ? fetchDelayPrograms(icao, faKey) : Promise.resolve([]),
  ]);

  const remaining = remainingResult.status === 'fulfilled' && remainingResult.value !== null
    ? remainingResult.value
    : estimateRemainingFromTime(iata);

  const delays = delaysResult.status === 'fulfilled' ? delaysResult.value : [];

  if (asKey && remainingResult.status === 'fulfilled' && remainingResult.value !== null) {
    sources.push('aviationstack');
  } else {
    sources.push('estimate');
  }
  if (faKey && delays.length >= 0) sources.push('flightaware');

  const result: DepartureInfo = {
    iata,
    remaining,
    delays,
    sources,
    cachedAt: new Date().toISOString(),
  };

  // Cache 10 min — departure counts change slowly, delays may update faster
  await redis.setex(cacheKey, 600, result);
  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json(result);
}

// ── Time-based estimate fallback ──────────────────────────────
const DAILY_FLIGHTS: Record<string, number> = {
  ATL: 900, BOS: 380, CLT: 540, ORD: 900, DFW: 840,
  DEN: 600, LAS: 560, LAX: 700, MIA: 480, MSP: 440,
  JFK: 480, MCO: 500, PHX: 560, SFO: 480, SEA: 440,
};

function estimateRemainingFromTime(iata: string): number {
  const daily = DAILY_FLIGHTS[iata] ?? 400;
  const now   = new Date();
  const hoursLeft = 24 - now.getHours() - now.getMinutes() / 60;
  return Math.max(0, Math.round(daily * Math.min(1, hoursLeft / 18)));
}
