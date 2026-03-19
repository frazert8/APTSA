// ============================================================
// APTSA -- Live Flight Board (Departures + Arrivals)
//
// GET /api/board?airportIata=ATL
//
// Priority chain:
//   1. AviationStack live API (if key present and returns ≥1 result)
//   2. Airline-accurate simulated board — each carrier only flies
//      routes it actually operates (WN=DAL not DFW, no Spirit to
//      London, no JetBlue at DFW, international carriers at hubs only)
//
// Env: AVIATIONSTACK_API_KEY (optional)
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { redis } from '../src/lib/redis.js';

// ── AviationStack flight shape ───────────────────────────────
interface AsFlight {
  flight_status: string;
  departure: { airport: string; iata: string; scheduled: string; estimated: string; actual: string | null; delay: number | null; terminal: string | null; gate: string | null };
  arrival:   { airport: string; iata: string; scheduled: string; estimated: string; actual: string | null; delay: number | null; terminal: string | null; gate: string | null };
  airline: { name: string; iata: string };
  flight:  { iata: string; number: string };
}

export interface FlightRow {
  flightIata:  string;
  airline:     string;
  airlineIata: string;
  city:        string;
  cityIata:    string;
  scheduled:   string;
  estimated:   string;
  actual:      string | null;
  status:      string;
  delay:       number | null;
  terminal:    string | null;
  gate:        string | null;
}

export interface BoardData {
  iata:       string;
  departures: FlightRow[];
  arrivals:   FlightRow[];
  cachedAt:   string;
  mock:       boolean;
}

// ── Route type ───────────────────────────────────────────────
interface Route { city: string; iata: string }

// ── Airline-specific route networks ─────────────────────────
//
// Every airline here only contains destinations it *actually* serves.
// Key real-world constraints encoded:
//
//  WN (Southwest) — domestic US + select Caribbean/Mexico only.
//     Uses secondary airports: DAL (not DFW), MDW (not ORD),
//     HOU (not IAH), BWI (not DCA), FLL (not MIA), LGA (not JFK).
//     No transatlantic, no Europe, no Asia.
//
//  NK (Spirit) — ULCC domestic US + Caribbean/Latin America only.
//     No transatlantic routes whatsoever.
//
//  AS (Alaska) — West-coast focused domestic + Mexico/Hawaii.
//     Very limited transatlantic (none simulated here).
//
//  B6 (JetBlue) — domestic + Caribbean. DOES fly transatlantic
//     since 2021 (LHR, CDG, AMS only from JFK/BOS). Does NOT serve DFW.
//
//  BA/LH/AF/QR/EK — international carriers; only at major
//     international gateways (JFK, LAX, ORD, MIA, IAH, SFO, BOS, ATL, DFW, SEA).
//
// ────────────────────────────────────────────────────────────

const AIRLINE_ROUTES: Record<string, Route[]> = {

  // American Airlines — full network, global
  AA: [
    { city: 'Los Angeles',      iata: 'LAX' }, { city: 'New York JFK',     iata: 'JFK' },
    { city: 'Chicago O\'Hare',  iata: 'ORD' }, { city: 'Miami',            iata: 'MIA' },
    { city: 'Denver',           iata: 'DEN' }, { city: 'Seattle',          iata: 'SEA' },
    { city: 'Phoenix',          iata: 'PHX' }, { city: 'Charlotte',        iata: 'CLT' },
    { city: 'Philadelphia',     iata: 'PHL' }, { city: 'Boston',           iata: 'BOS' },
    { city: 'Washington DC',    iata: 'DCA' }, { city: 'Las Vegas',        iata: 'LAS' },
    { city: 'Atlanta',          iata: 'ATL' }, { city: 'Dallas/Fort Worth',iata: 'DFW' },
    { city: 'Houston',          iata: 'IAH' }, { city: 'San Francisco',    iata: 'SFO' },
    { city: 'London Heathrow',  iata: 'LHR' }, { city: 'Madrid',           iata: 'MAD' },
    { city: 'Cancun',           iata: 'CUN' }, { city: 'Mexico City',      iata: 'MEX' },
    { city: 'São Paulo GRU',    iata: 'GRU' }, { city: 'Buenos Aires',     iata: 'EZE' },
    { city: 'Tokyo Narita',     iata: 'NRT' }, { city: 'Paris CDG',        iata: 'CDG' },
  ],

  // Delta Air Lines — full network, global
  DL: [
    { city: 'Los Angeles',      iata: 'LAX' }, { city: 'New York JFK',     iata: 'JFK' },
    { city: 'Chicago O\'Hare',  iata: 'ORD' }, { city: 'Boston',           iata: 'BOS' },
    { city: 'Miami',            iata: 'MIA' }, { city: 'Denver',           iata: 'DEN' },
    { city: 'Seattle',          iata: 'SEA' }, { city: 'Minneapolis',      iata: 'MSP' },
    { city: 'Detroit',          iata: 'DTW' }, { city: 'Salt Lake City',   iata: 'SLC' },
    { city: 'Las Vegas',        iata: 'LAS' }, { city: 'San Francisco',    iata: 'SFO' },
    { city: 'Dallas/Fort Worth',iata: 'DFW' }, { city: 'Washington DC',    iata: 'DCA' },
    { city: 'Philadelphia',     iata: 'PHL' }, { city: 'Houston',          iata: 'IAH' },
    { city: 'London Heathrow',  iata: 'LHR' }, { city: 'Amsterdam',        iata: 'AMS' },
    { city: 'Paris CDG',        iata: 'CDG' }, { city: 'Tokyo Narita',     iata: 'NRT' },
    { city: 'Cancun',           iata: 'CUN' }, { city: 'São Paulo GRU',    iata: 'GRU' },
    { city: 'Mexico City',      iata: 'MEX' }, { city: 'Frankfurt',        iata: 'FRA' },
  ],

  // United Airlines — full network, global
  UA: [
    { city: 'Los Angeles',      iata: 'LAX' }, { city: 'New York Newark',  iata: 'EWR' },
    { city: 'Chicago O\'Hare',  iata: 'ORD' }, { city: 'San Francisco',    iata: 'SFO' },
    { city: 'Denver',           iata: 'DEN' }, { city: 'Washington Dulles',iata: 'IAD' },
    { city: 'Seattle',          iata: 'SEA' }, { city: 'Miami',            iata: 'MIA' },
    { city: 'Boston',           iata: 'BOS' }, { city: 'Las Vegas',        iata: 'LAS' },
    { city: 'Dallas/Fort Worth',iata: 'DFW' }, { city: 'Phoenix',          iata: 'PHX' },
    { city: 'Atlanta',          iata: 'ATL' }, { city: 'Minneapolis',      iata: 'MSP' },
    { city: 'London Heathrow',  iata: 'LHR' }, { city: 'Frankfurt',        iata: 'FRA' },
    { city: 'Tokyo Narita',     iata: 'NRT' }, { city: 'Sydney',           iata: 'SYD' },
    { city: 'Cancun',           iata: 'CUN' }, { city: 'Mexico City',      iata: 'MEX' },
    { city: 'São Paulo GRU',    iata: 'GRU' }, { city: 'Bogota',           iata: 'BOG' },
  ],

  // Southwest Airlines — DOMESTIC US + select Caribbean/Mexico ONLY.
  // Uses secondary/alternative airports:
  //   DAL (Love Field) not DFW  |  MDW not ORD  |  HOU not IAH
  //   BWI not DCA/IAD           |  FLL not MIA  |  LGA not JFK
  //   OAK/SJC alongside SFO    |  HNL, OGG for Hawaii
  WN: [
    { city: 'Dallas Love Field',iata: 'DAL' }, { city: 'Chicago Midway',   iata: 'MDW' },
    { city: 'Houston Hobby',    iata: 'HOU' }, { city: 'Baltimore/Wash.',  iata: 'BWI' },
    { city: 'Fort Lauderdale',  iata: 'FLL' }, { city: 'New York LaGuardia',iata:'LGA' },
    { city: 'Las Vegas',        iata: 'LAS' }, { city: 'Denver',           iata: 'DEN' },
    { city: 'Phoenix',          iata: 'PHX' }, { city: 'Orlando',          iata: 'MCO' },
    { city: 'Los Angeles',      iata: 'LAX' }, { city: 'Nashville',        iata: 'BNA' },
    { city: 'San Diego',        iata: 'SAN' }, { city: 'Oakland',          iata: 'OAK' },
    { city: 'Seattle',          iata: 'SEA' }, { city: 'St. Louis',        iata: 'STL' },
    { city: 'Kansas City',      iata: 'MCI' }, { city: 'Sacramento',       iata: 'SMF' },
    { city: 'Raleigh/Durham',   iata: 'RDU' }, { city: 'Indianapolis',     iata: 'IND' },
    { city: 'Columbus',         iata: 'CMH' }, { city: 'Austin',           iata: 'AUS' },
    { city: 'Cancun',           iata: 'CUN' }, { city: 'Montego Bay',      iata: 'MBJ' },
    { city: 'Cabo San Lucas',   iata: 'SJD' }, { city: 'Honolulu',         iata: 'HNL' },
  ],

  // Alaska Airlines — West Coast + domestic + Mexico/Hawaii. Limited transatlantic.
  AS: [
    { city: 'Los Angeles',      iata: 'LAX' }, { city: 'San Francisco',    iata: 'SFO' },
    { city: 'Seattle',          iata: 'SEA' }, { city: 'Portland',         iata: 'PDX' },
    { city: 'Anchorage',        iata: 'ANC' }, { city: 'Las Vegas',        iata: 'LAS' },
    { city: 'Phoenix',          iata: 'PHX' }, { city: 'Denver',           iata: 'DEN' },
    { city: 'Dallas/Fort Worth',iata: 'DFW' }, { city: 'Chicago O\'Hare',  iata: 'ORD' },
    { city: 'New York JFK',     iata: 'JFK' }, { city: 'Boston',           iata: 'BOS' },
    { city: 'Miami',            iata: 'MIA' }, { city: 'Washington DC',    iata: 'DCA' },
    { city: 'Honolulu',         iata: 'HNL' }, { city: 'Maui',             iata: 'OGG' },
    { city: 'San Diego',        iata: 'SAN' }, { city: 'Salt Lake City',   iata: 'SLC' },
    { city: 'Cancun',           iata: 'CUN' }, { city: 'Mexico City',      iata: 'MEX' },
    { city: 'Cabo San Lucas',   iata: 'SJD' }, { city: 'Vancouver',        iata: 'YVR' },
  ],

  // JetBlue — domestic US + Caribbean + transatlantic (LHR/CDG/AMS from JFK/BOS only).
  // Does NOT serve DFW, MEM, IND, or many secondary markets.
  B6: [
    { city: 'New York JFK',     iata: 'JFK' }, { city: 'Boston',           iata: 'BOS' },
    { city: 'Fort Lauderdale',  iata: 'FLL' }, { city: 'Orlando',          iata: 'MCO' },
    { city: 'Los Angeles',      iata: 'LAX' }, { city: 'Long Beach',       iata: 'LGB' },
    { city: 'Washington DC',    iata: 'DCA' }, { city: 'San Juan',         iata: 'SJU' },
    { city: 'Cancun',           iata: 'CUN' }, { city: 'Nassau',           iata: 'NAS' },
    { city: 'Punta Cana',       iata: 'PUJ' }, { city: 'Montego Bay',      iata: 'MBJ' },
    { city: 'Barbados',         iata: 'BGI' }, { city: 'Aruba',            iata: 'AUA' },
    { city: 'Santo Domingo',    iata: 'SDQ' }, { city: 'Portland',         iata: 'PDX' },
    { city: 'Seattle',          iata: 'SEA' }, { city: 'Denver',           iata: 'DEN' },
    { city: 'Las Vegas',        iata: 'LAS' }, { city: 'San Francisco',    iata: 'SFO' },
    { city: 'London Heathrow',  iata: 'LHR' }, { city: 'Paris CDG',        iata: 'CDG' },
    { city: 'Amsterdam',        iata: 'AMS' },
  ],

  // Spirit Airlines — ULCC domestic US + Caribbean/Latin America ONLY.
  // No transatlantic. No Europe. No Asia.
  NK: [
    { city: 'Fort Lauderdale',  iata: 'FLL' }, { city: 'Las Vegas',        iata: 'LAS' },
    { city: 'Orlando',          iata: 'MCO' }, { city: 'Chicago O\'Hare',  iata: 'ORD' },
    { city: 'Los Angeles',      iata: 'LAX' }, { city: 'Dallas/Fort Worth',iata: 'DFW' },
    { city: 'Atlanta',          iata: 'ATL' }, { city: 'New York LaGuardia',iata:'LGA' },
    { city: 'Houston',          iata: 'IAH' }, { city: 'Detroit',          iata: 'DTW' },
    { city: 'Philadelphia',     iata: 'PHL' }, { city: 'Boston',           iata: 'BOS' },
    { city: 'Denver',           iata: 'DEN' }, { city: 'Baltimore',        iata: 'BWI' },
    { city: 'Minneapolis',      iata: 'MSP' }, { city: 'Tampa',            iata: 'TPA' },
    { city: 'Cancun',           iata: 'CUN' }, { city: 'Punta Cana',       iata: 'PUJ' },
    { city: 'Montego Bay',      iata: 'MBJ' }, { city: 'San Juan',         iata: 'SJU' },
    { city: 'Bogota',           iata: 'BOG' }, { city: 'Medellin',         iata: 'MDE' },
  ],

  // British Airways — international, major US gateways only
  BA: [
    { city: 'London Heathrow',  iata: 'LHR' }, { city: 'London Gatwick',   iata: 'LGW' },
    { city: 'Manchester',       iata: 'MAN' }, { city: 'Edinburgh',        iata: 'EDI' },
  ],

  // Lufthansa — international, major US gateways only
  LH: [
    { city: 'Frankfurt',        iata: 'FRA' }, { city: 'Munich',           iata: 'MUC' },
    { city: 'Zurich',           iata: 'ZRH' }, { city: 'Vienna',           iata: 'VIE' },
  ],

  // Air France — international, major US gateways only
  AF: [
    { city: 'Paris CDG',        iata: 'CDG' }, { city: 'Paris Orly',       iata: 'ORY' },
    { city: 'Lyon',             iata: 'LYS' }, { city: 'Nice',             iata: 'NCE' },
  ],

  // Qatar Airways — international, major US gateways only
  QR: [
    { city: 'Doha',             iata: 'DOH' },
  ],

  // Emirates — international, major US gateways only
  EK: [
    { city: 'Dubai',            iata: 'DXB' },
  ],
};

// ── Airline flight number ranges ─────────────────────────────
const FLIGHT_NUM_RANGE: Record<string, [number, number]> = {
  AA: [1,    3999], DL: [1,    4999], UA: [1,    4999],
  WN: [1,    9999], AS: [1,    999],  B6: [1,    2999],
  NK: [300,  1999], BA: [1,    499],  LH: [400,  8999],
  AF: [1,    9099], QR: [1,    1499], EK: [1,    999],
};

// ── Per-airport airline presence ─────────────────────────────
//
// Only airlines that actually serve each airport are listed.
// Weights reflect dominant carriers (more entries = more flights shown).
//
// Key constraints:
//  • WN not at DFW (Love Field DAL), ORD (MDW), IAH (HOU), MIA (FLL), JFK (LGA)
//  • International carriers (BA/LH/AF/QR/EK) only at major int'l gateways
//  • B6 not at DFW (JetBlue has no DFW service)
//
const AIRPORT_AIRLINES: Record<string, string[]> = {
  DFW: ['AA','AA','AA','AA','DL','UA','AS','NK','QR','BA'],
  ATL: ['DL','DL','DL','DL','UA','AA','WN','NK','B6','BA','AF','LH'],
  LAX: ['AA','DL','UA','AS','B6','WN','NK','BA','QR','EK','AF','LH'],
  ORD: ['UA','UA','UA','AA','AA','DL','AS','NK','B6','BA','LH'],
  JFK: ['AA','DL','B6','B6','B6','UA','NK','AS','BA','AF','QR','EK','LH'],
  MIA: ['AA','AA','AA','DL','UA','B6','NK','AS','BA','AF','LH'],
  SEA: ['AS','AS','AS','DL','UA','AA','WN','B6','BA'],
  DEN: ['UA','UA','DL','AA','WN','WN','B6','AS','NK'],
  LAS: ['WN','WN','WN','AA','DL','UA','NK','B6','AS'],
  SFO: ['UA','UA','UA','AS','DL','AA','WN','B6','BA','LH','QR'],
  BOS: ['AA','DL','B6','B6','B6','UA','AS','NK','BA'],
  IAH: ['UA','UA','UA','UA','AA','DL','NK','BA','LH'],
  MCO: ['AA','DL','UA','WN','WN','B6','B6','NK','AS'],
  PHX: ['AA','AA','AA','AA','WN','WN','DL','UA','AS'],
  CLT: ['AA','AA','AA','AA','DL','UA','WN','NK','B6'],
  EWR: ['UA','UA','UA','AA','DL','B6','NK','LH','BA'],
  MSP: ['DL','DL','DL','UA','AA','WN','AS','NK','B6'],
  DTW: ['DL','DL','DL','UA','AA','WN','NK','B6'],
  SLC: ['DL','DL','DL','UA','AA','WN','AS','B6'],
  BNA: ['WN','WN','WN','AA','DL','UA','NK','B6'],
};

const DEFAULT_AIRPORT_AIRLINES = ['AA','DL','UA','WN','B6','AS','NK'];

const GATE_LETTERS = ['A','B','C','D','E'];

// ── Stable seeded pseudo-random ──────────────────────────────
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0x100000000; };
}
function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

// ── Simulated board (airline-accurate) ──────────────────────
function makeSimulatedRows(direction: 'dep' | 'arr', iata: string, count = 14): FlightRow[] {
  const now      = Date.now();
  const hourSlot = Math.floor(now / (60 * 60_000));
  const seedBase = iata.split('').reduce((h, c) => h * 31 + c.charCodeAt(0), 0);
  const seed     = seedBase ^ (direction === 'dep' ? 0x1234 : 0x5678) ^ hourSlot;
  const rng      = seededRng(seed);

  const airlineCodes = AIRPORT_AIRLINES[iata] ?? DEFAULT_AIRPORT_AIRLINES;

  return Array.from({ length: count }, (_, i): FlightRow => {
    // Spread flights across a 4-hour window from now
    const minOffset = direction === 'dep'
      ? 5 + i * 17 + Math.floor(rng() * 8)
      : -40 + i * 11 + Math.floor(rng() * 6);

    const scheduledMs  = now + minOffset * 60_000;
    const scheduledISO = new Date(scheduledMs).toISOString();

    const isDelayed    = rng() < 0.12;
    const delayMins    = isDelayed ? (Math.floor(rng() * 6) + 1) * 10 : 0;
    const estimatedISO = new Date(scheduledMs + delayMins * 60_000).toISOString();

    let status: string;
    if (direction === 'dep') {
      status = minOffset < -5 ? 'landed' : minOffset < 20 ? (isDelayed ? 'delayed' : 'active') : (isDelayed ? 'delayed' : 'scheduled');
    } else {
      status = minOffset < -10 ? 'landed' : minOffset < 15 ? (isDelayed ? 'delayed' : 'active') : 'scheduled';
    }
    const actualISO = (status === 'landed' || status === 'active')
      ? new Date(scheduledMs + delayMins * 60_000 + (Math.floor(rng() * 5) - 2) * 60_000).toISOString()
      : null;

    // Pick airline for this airport, then pick a route from that airline's
    // actual network (excluding the current airport itself)
    let airlineIata: string;
    let routes: Route[];
    let attempts = 0;
    do {
      airlineIata = pick(airlineCodes, rng);
      routes = (AIRLINE_ROUTES[airlineIata] ?? []).filter(r => r.iata !== iata);
      attempts++;
    } while (routes.length === 0 && attempts < 10);

    if (routes.length === 0) {
      // Absolute fallback — use AA domestic
      airlineIata = 'AA';
      routes = AIRLINE_ROUTES['AA'].filter(r => r.iata !== iata);
    }

    const airlineName  = AIRLINE_NAMES[airlineIata] ?? airlineIata;
    const [minFn, maxFn] = FLIGHT_NUM_RANGE[airlineIata] ?? [100, 9999];
    const flightNum    = minFn + Math.floor(rng() * (maxFn - minFn + 1));
    const route        = pick(routes, rng);
    const gateL        = pick(GATE_LETTERS, rng);
    const gateN        = Math.floor(rng() * 35) + 1;

    return {
      flightIata:  `${airlineIata}${flightNum}`,
      airline:     airlineName,
      airlineIata,
      city:        route.city,
      cityIata:    route.iata,
      scheduled:   scheduledISO,
      estimated:   estimatedISO,
      actual:      actualISO,
      status,
      delay:       isDelayed ? delayMins : null,
      terminal:    gateL,
      gate:        `${gateL}${gateN}`,
    };
  });
}

const AIRLINE_NAMES: Record<string, string> = {
  AA: 'American Airlines', DL: 'Delta Air Lines',  UA: 'United Airlines',
  WN: 'Southwest Airlines',AS: 'Alaska Airlines',  B6: 'JetBlue Airways',
  NK: 'Spirit Airlines',   BA: 'British Airways',  LH: 'Lufthansa',
  AF: 'Air France',        QR: 'Qatar Airways',    EK: 'Emirates',
};

// ── Fetch one direction from AviationStack ──────────────────
async function fetchFlights(direction: 'dep' | 'arr', iata: string, apiKey: string): Promise<FlightRow[]> {
  const paramKey = direction === 'dep' ? 'dep_iata' : 'arr_iata';
  const url = `http://api.aviationstack.com/v1/flights?access_key=${apiKey}&${paramKey}=${iata}&limit=20`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(6_000) });
  if (!resp.ok) throw new Error(`AviationStack ${resp.status}`);
  const json = (await resp.json()) as { data?: AsFlight[]; error?: { message: string } };
  if (json.error) throw new Error(`AviationStack: ${json.error.message}`);
  return (json.data ?? []).map((f): FlightRow => {
    const other = direction === 'dep' ? f.arrival : f.departure;
    return {
      flightIata:  f.flight.iata ?? `${f.airline.iata}${f.flight.number}`,
      airline:     f.airline.name,
      airlineIata: f.airline.iata,
      city:        other.airport,
      cityIata:    other.iata,
      scheduled:   direction === 'dep' ? f.departure.scheduled : f.arrival.scheduled,
      estimated:   direction === 'dep' ? f.departure.estimated : f.arrival.estimated,
      actual:      direction === 'dep' ? f.departure.actual    : f.arrival.actual,
      status:      f.flight_status,
      delay:       direction === 'dep' ? f.departure.delay     : f.arrival.delay,
      terminal:    direction === 'dep' ? f.departure.terminal  : f.arrival.terminal,
      gate:        direction === 'dep' ? f.departure.gate      : f.arrival.gate,
    };
  });
}

// ── Handler ─────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const iata = (req.query['airportIata'] as string | undefined)?.toUpperCase().trim();
  if (!iata || iata.length !== 3) return res.status(400).json({ error: 'airportIata required (e.g. ATL)' });

  const cacheKey = `board:v3:${iata}`;
  const cached   = await redis.get<BoardData>(cacheKey);
  if (cached) { res.setHeader('X-Cache', 'HIT'); return res.status(200).json(cached); }

  const asKey    = process.env['AVIATIONSTACK_API_KEY'];
  let departures: FlightRow[] = [];
  let arrivals:   FlightRow[] = [];
  let usedLive = false;

  if (asKey) {
    try {
      const [dep, arr] = await Promise.allSettled([
        fetchFlights('dep', iata, asKey),
        fetchFlights('arr', iata, asKey),
      ]);
      departures = dep.status === 'fulfilled' ? dep.value : [];
      arrivals   = arr.status === 'fulfilled' ? arr.value : [];
      if (departures.length > 0 || arrivals.length > 0) usedLive = true;
    } catch { /* fall through */ }
  }

  if (!usedLive) {
    departures = makeSimulatedRows('dep', iata);
    arrivals   = makeSimulatedRows('arr', iata);
  }

  const result: BoardData = { iata, departures, arrivals, cachedAt: new Date().toISOString(), mock: !usedLive };
  await redis.setex(cacheKey, usedLive ? 300 : 900, result);
  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json(result);
}
