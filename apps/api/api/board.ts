// ============================================================
// APTSA -- Live Flight Board (Departures + Arrivals)
//
// GET /api/board?airportIata=ATL
//
// Priority chain:
//   1. AviationStack live API (if key present and returns data)
//   2. Simulated board — airport-specific hub routes, high-demand
//      airlines, time-seeded so flights feel current & realistic
//
// Env: AVIATIONSTACK_API_KEY (optional)
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { redis } from '../src/lib/redis.js';

// ── AviationStack flight shape (fields we use) ──────────────
interface AsFlight {
  flight_status: string;
  departure: {
    airport:   string;
    iata:      string;
    scheduled: string;
    estimated: string;
    actual:    string | null;
    delay:     number | null;
    terminal:  string | null;
    gate:      string | null;
  };
  arrival: {
    airport:   string;
    iata:      string;
    scheduled: string;
    estimated: string;
    actual:    string | null;
    delay:     number | null;
    terminal:  string | null;
    gate:      string | null;
  };
  airline: { name: string; iata: string };
  flight:  { iata: string; number: string };
}

// ── Normalised row returned to the client ───────────────────
export interface FlightRow {
  flightIata: string;
  airline:    string;
  airlineIata: string;
  city:       string;
  cityIata:   string;
  scheduled:  string;
  estimated:  string;
  actual:     string | null;
  status:     string;
  delay:      number | null;
  terminal:   string | null;
  gate:       string | null;
}

export interface BoardData {
  iata:       string;
  departures: FlightRow[];
  arrivals:   FlightRow[];
  cachedAt:   string;
  mock:       boolean;  // true = simulated data
}

// ── High-demand airlines ────────────────────────────────────
// Domestic + international carriers with highest passenger volume
interface Airline { name: string; iata: string; flightBase: number }

const AIRLINES: Airline[] = [
  { name: 'American Airlines', iata: 'AA', flightBase: 100 },
  { name: 'Delta Air Lines',   iata: 'DL', flightBase: 200 },
  { name: 'United Airlines',   iata: 'UA', flightBase: 300 },
  { name: 'Southwest Airlines',iata: 'WN', flightBase: 400 },
  { name: 'Alaska Airlines',   iata: 'AS', flightBase: 200 },
  { name: 'JetBlue Airways',   iata: 'B6', flightBase: 600 },
  { name: 'Spirit Airlines',   iata: 'NK', flightBase: 500 },
  { name: 'British Airways',   iata: 'BA', flightBase: 100 },
  { name: 'Lufthansa',         iata: 'LH', flightBase: 400 },
  { name: 'Air France',        iata: 'AF', flightBase: 100 },
  { name: 'Qatar Airways',     iata: 'QR', flightBase: 300 },
  { name: 'Emirates',          iata: 'EK', flightBase: 200 },
];

// ── Airport hub route maps ───────────────────────────────────
// Each entry lists the most common city-pairs for that hub.
// Airlines are weighted toward each hub's dominant carrier.
interface Route { city: string; iata: string }

const HUB_ROUTES: Record<string, Route[]> = {
  DFW: [
    { city: 'Los Angeles',    iata: 'LAX' }, { city: 'Miami',           iata: 'MIA' },
    { city: "Chicago O'Hare", iata: 'ORD' }, { city: 'New York JFK',    iata: 'JFK' },
    { city: 'Denver',         iata: 'DEN' }, { city: 'Atlanta',         iata: 'ATL' },
    { city: 'Seattle',        iata: 'SEA' }, { city: 'Phoenix',         iata: 'PHX' },
    { city: 'Houston',        iata: 'IAH' }, { city: 'Las Vegas',       iata: 'LAS' },
    { city: 'New York LGA',   iata: 'LGA' }, { city: 'Washington DC',   iata: 'DCA' },
    { city: 'Boston',         iata: 'BOS' }, { city: 'Charlotte',       iata: 'CLT' },
    { city: 'London Heathrow',iata: 'LHR' }, { city: 'Cancun',          iata: 'CUN' },
  ],
  ATL: [
    { city: 'New York JFK',   iata: 'JFK' }, { city: 'Los Angeles',     iata: 'LAX' },
    { city: 'Chicago',        iata: 'ORD' }, { city: 'Dallas/Fort Worth',iata: 'DFW'},
    { city: 'Miami',          iata: 'MIA' }, { city: 'Denver',          iata: 'DEN' },
    { city: 'Boston',         iata: 'BOS' }, { city: 'Seattle',         iata: 'SEA' },
    { city: 'Orlando',        iata: 'MCO' }, { city: 'Las Vegas',       iata: 'LAS' },
    { city: 'Washington DC',  iata: 'DCA' }, { city: 'Philadelphia',    iata: 'PHL' },
    { city: 'London Heathrow',iata: 'LHR' }, { city: 'Amsterdam',       iata: 'AMS' },
    { city: 'Cancun',         iata: 'CUN' }, { city: 'San Juan',        iata: 'SJU' },
  ],
  LAX: [
    { city: 'New York JFK',   iata: 'JFK' }, { city: 'Chicago',         iata: 'ORD' },
    { city: 'Dallas/Fort Worth',iata:'DFW' }, { city: 'Atlanta',         iata: 'ATL' },
    { city: 'Seattle',        iata: 'SEA' }, { city: 'Las Vegas',       iata: 'LAS' },
    { city: 'San Francisco',  iata: 'SFO' }, { city: 'Denver',          iata: 'DEN' },
    { city: 'Boston',         iata: 'BOS' }, { city: 'Miami',           iata: 'MIA' },
    { city: 'London Heathrow',iata: 'LHR' }, { city: 'Tokyo Narita',    iata: 'NRT' },
    { city: 'Sydney',         iata: 'SYD' }, { city: 'Cancun',          iata: 'CUN' },
    { city: 'Mexico City',    iata: 'MEX' }, { city: 'Paris CDG',       iata: 'CDG' },
  ],
  ORD: [
    { city: 'New York JFK',   iata: 'JFK' }, { city: 'Los Angeles',     iata: 'LAX' },
    { city: 'Dallas/Fort Worth',iata:'DFW' }, { city: 'Atlanta',         iata: 'ATL' },
    { city: 'Miami',          iata: 'MIA' }, { city: 'Denver',          iata: 'DEN' },
    { city: 'Seattle',        iata: 'SEA' }, { city: 'San Francisco',   iata: 'SFO' },
    { city: 'Boston',         iata: 'BOS' }, { city: 'Washington DC',   iata: 'DCA' },
    { city: 'London Heathrow',iata: 'LHR' }, { city: 'Frankfurt',       iata: 'FRA' },
    { city: 'Cancun',         iata: 'CUN' }, { city: 'Toronto',         iata: 'YYZ' },
    { city: 'Phoenix',        iata: 'PHX' }, { city: 'Las Vegas',       iata: 'LAS' },
  ],
  JFK: [
    { city: 'Los Angeles',    iata: 'LAX' }, { city: 'Chicago',         iata: 'ORD' },
    { city: 'Miami',          iata: 'MIA' }, { city: 'Atlanta',         iata: 'ATL' },
    { city: 'Dallas/Fort Worth',iata:'DFW' }, { city: 'San Francisco',   iata: 'SFO' },
    { city: 'London Heathrow',iata: 'LHR' }, { city: 'Paris CDG',       iata: 'CDG' },
    { city: 'Frankfurt',      iata: 'FRA' }, { city: 'Amsterdam',       iata: 'AMS' },
    { city: 'Dubai',          iata: 'DXB' }, { city: 'Doha',            iata: 'DOH' },
    { city: 'Cancun',         iata: 'CUN' }, { city: 'Boston',          iata: 'BOS' },
    { city: 'Washington DC',  iata: 'DCA' }, { city: 'Seattle',         iata: 'SEA' },
  ],
  MIA: [
    { city: 'New York JFK',   iata: 'JFK' }, { city: 'Los Angeles',     iata: 'LAX' },
    { city: 'Chicago',        iata: 'ORD' }, { city: 'Atlanta',         iata: 'ATL' },
    { city: 'Dallas/Fort Worth',iata:'DFW' }, { city: 'Bogota',          iata: 'BOG' },
    { city: 'Lima',           iata: 'LIM' }, { city: 'São Paulo GRU',   iata: 'GRU' },
    { city: 'Mexico City',    iata: 'MEX' }, { city: 'Cancun',          iata: 'CUN' },
    { city: 'London Heathrow',iata: 'LHR' }, { city: 'Madrid',          iata: 'MAD' },
    { city: 'San Juan',       iata: 'SJU' }, { city: 'Nassau',          iata: 'NAS' },
    { city: 'Montego Bay',    iata: 'MBJ' }, { city: 'Punta Cana',      iata: 'PUJ' },
  ],
  SEA: [
    { city: 'Los Angeles',    iata: 'LAX' }, { city: 'San Francisco',   iata: 'SFO' },
    { city: 'New York JFK',   iata: 'JFK' }, { city: 'Chicago',         iata: 'ORD' },
    { city: 'Dallas/Fort Worth',iata:'DFW' }, { city: 'Atlanta',         iata: 'ATL' },
    { city: 'Denver',         iata: 'DEN' }, { city: 'Phoenix',         iata: 'PHX' },
    { city: 'Las Vegas',      iata: 'LAS' }, { city: 'Anchorage',       iata: 'ANC' },
    { city: 'Honolulu',       iata: 'HNL' }, { city: 'Tokyo Narita',    iata: 'NRT' },
    { city: 'Vancouver',      iata: 'YVR' }, { city: 'Miami',           iata: 'MIA' },
    { city: 'Boston',         iata: 'BOS' }, { city: 'Portland',        iata: 'PDX' },
  ],
  DEN: [
    { city: 'Los Angeles',    iata: 'LAX' }, { city: 'Chicago',         iata: 'ORD' },
    { city: 'New York JFK',   iata: 'JFK' }, { city: 'Dallas/Fort Worth',iata:'DFW'},
    { city: 'Atlanta',        iata: 'ATL' }, { city: 'Seattle',         iata: 'SEA' },
    { city: 'San Francisco',  iata: 'SFO' }, { city: 'Phoenix',         iata: 'PHX' },
    { city: 'Las Vegas',      iata: 'LAS' }, { city: 'Miami',           iata: 'MIA' },
    { city: 'Boston',         iata: 'BOS' }, { city: 'Washington DC',   iata: 'DCA' },
    { city: 'Salt Lake City', iata: 'SLC' }, { city: 'Minneapolis',     iata: 'MSP' },
    { city: 'Houston',        iata: 'IAH' }, { city: 'Cancun',          iata: 'CUN' },
  ],
  LAS: [
    { city: 'Los Angeles',    iata: 'LAX' }, { city: 'New York JFK',    iata: 'JFK' },
    { city: 'Chicago',        iata: 'ORD' }, { city: 'Dallas/Fort Worth',iata:'DFW'},
    { city: 'Atlanta',        iata: 'ATL' }, { city: 'Seattle',         iata: 'SEA' },
    { city: 'Denver',         iata: 'DEN' }, { city: 'Phoenix',         iata: 'PHX' },
    { city: 'San Francisco',  iata: 'SFO' }, { city: 'Miami',           iata: 'MIA' },
    { city: 'Boston',         iata: 'BOS' }, { city: 'Portland',        iata: 'PDX' },
    { city: 'Salt Lake City', iata: 'SLC' }, { city: 'Minneapolis',     iata: 'MSP' },
    { city: 'Washington DC',  iata: 'DCA' }, { city: 'Houston',         iata: 'IAH' },
  ],
  SFO: [
    { city: 'Los Angeles',    iata: 'LAX' }, { city: 'New York JFK',    iata: 'JFK' },
    { city: 'Chicago',        iata: 'ORD' }, { city: 'Seattle',         iata: 'SEA' },
    { city: 'Dallas/Fort Worth',iata:'DFW' }, { city: 'Atlanta',         iata: 'ATL' },
    { city: 'Denver',         iata: 'DEN' }, { city: 'Las Vegas',       iata: 'LAS' },
    { city: 'Tokyo Narita',   iata: 'NRT' }, { city: 'London Heathrow', iata: 'LHR' },
    { city: 'Shanghai PVG',   iata: 'PVG' }, { city: 'Hong Kong',       iata: 'HKG' },
    { city: 'Honolulu',       iata: 'HNL' }, { city: 'Mexico City',     iata: 'MEX' },
    { city: 'Vancouver',      iata: 'YVR' }, { city: 'Paris CDG',       iata: 'CDG' },
  ],
  BOS: [
    { city: 'New York JFK',   iata: 'JFK' }, { city: 'Los Angeles',     iata: 'LAX' },
    { city: 'Chicago',        iata: 'ORD' }, { city: 'Miami',           iata: 'MIA' },
    { city: 'Atlanta',        iata: 'ATL' }, { city: 'Dallas/Fort Worth',iata:'DFW'},
    { city: 'Washington DC',  iata: 'DCA' }, { city: 'Philadelphia',    iata: 'PHL' },
    { city: 'London Heathrow',iata: 'LHR' }, { city: 'Dublin',          iata: 'DUB' },
    { city: 'Reykjavik',      iata: 'KEF' }, { city: 'Toronto',         iata: 'YYZ' },
    { city: 'Cancun',         iata: 'CUN' }, { city: 'San Juan',        iata: 'SJU' },
    { city: 'Denver',         iata: 'DEN' }, { city: 'Seattle',         iata: 'SEA' },
  ],
  IAH: [
    { city: 'Los Angeles',    iata: 'LAX' }, { city: 'New York JFK',    iata: 'JFK' },
    { city: 'Chicago',        iata: 'ORD' }, { city: 'Dallas/Fort Worth',iata:'DFW'},
    { city: 'Atlanta',        iata: 'ATL' }, { city: 'Denver',          iata: 'DEN' },
    { city: 'Miami',          iata: 'MIA' }, { city: 'Mexico City',     iata: 'MEX' },
    { city: 'Bogota',         iata: 'BOG' }, { city: 'Cancun',          iata: 'CUN' },
    { city: 'London Heathrow',iata: 'LHR' }, { city: 'Frankfurt',       iata: 'FRA' },
    { city: 'Panama City',    iata: 'PTY' }, { city: 'Lima',            iata: 'LIM' },
    { city: 'São Paulo GRU',  iata: 'GRU' }, { city: 'Monterrey',       iata: 'MTY' },
  ],
  MCO: [
    { city: 'New York JFK',   iata: 'JFK' }, { city: 'Atlanta',         iata: 'ATL' },
    { city: 'Chicago',        iata: 'ORD' }, { city: 'Boston',          iata: 'BOS' },
    { city: 'Philadelphia',   iata: 'PHL' }, { city: 'Dallas/Fort Worth',iata:'DFW'},
    { city: 'Washington DC',  iata: 'DCA' }, { city: 'Los Angeles',     iata: 'LAX' },
    { city: 'Minneapolis',    iata: 'MSP' }, { city: 'Detroit',         iata: 'DTW' },
    { city: 'Baltimore',      iata: 'BWI' }, { city: 'Newark',          iata: 'EWR' },
    { city: 'Cancun',         iata: 'CUN' }, { city: 'Nassau',          iata: 'NAS' },
    { city: 'San Juan',       iata: 'SJU' }, { city: 'London Heathrow', iata: 'LHR' },
  ],
  PHX: [
    { city: 'Los Angeles',    iata: 'LAX' }, { city: 'Dallas/Fort Worth',iata:'DFW'},
    { city: 'Chicago',        iata: 'ORD' }, { city: 'Denver',          iata: 'DEN' },
    { city: 'Las Vegas',      iata: 'LAS' }, { city: 'Seattle',         iata: 'SEA' },
    { city: 'Atlanta',        iata: 'ATL' }, { city: 'New York JFK',    iata: 'JFK' },
    { city: 'San Francisco',  iata: 'SFO' }, { city: 'Salt Lake City',  iata: 'SLC' },
    { city: 'Minneapolis',    iata: 'MSP' }, { city: 'Miami',           iata: 'MIA' },
    { city: 'Boston',         iata: 'BOS' }, { city: 'Portland',        iata: 'PDX' },
    { city: 'Cancun',         iata: 'CUN' }, { city: 'Cabo San Lucas',  iata: 'SJD' },
  ],
};

// Default routes for airports not in the map
const DEFAULT_ROUTES: Route[] = [
  { city: 'New York JFK',    iata: 'JFK' }, { city: 'Los Angeles',    iata: 'LAX' },
  { city: 'Chicago',         iata: 'ORD' }, { city: 'Dallas/Fort Worth', iata: 'DFW' },
  { city: 'Atlanta',         iata: 'ATL' }, { city: 'Miami',          iata: 'MIA' },
  { city: 'Denver',          iata: 'DEN' }, { city: 'Seattle',        iata: 'SEA' },
  { city: 'San Francisco',   iata: 'SFO' }, { city: 'Las Vegas',      iata: 'LAS' },
  { city: 'Phoenix',         iata: 'PHX' }, { city: 'Boston',         iata: 'BOS' },
  { city: 'Cancun',          iata: 'CUN' }, { city: 'London Heathrow',iata: 'LHR' },
  { city: 'Houston',         iata: 'IAH' }, { city: 'Washington DC',  iata: 'DCA' },
];

// ── Hub-preferred airlines ───────────────────────────────────
// Each hub is dominated by 1-2 carriers; weight the simulation accordingly
const HUB_AIRLINES: Record<string, string[]> = {
  DFW: ['AA','AA','AA','DL','UA','WN','B6','NK'],
  ATL: ['DL','DL','DL','UA','AA','WN','B6','NK'],
  LAX: ['AA','DL','UA','AS','B6','WN','NK','BA','QR','EK'],
  ORD: ['UA','UA','AA','AA','DL','WN','B6','LH'],
  JFK: ['AA','DL','B6','B6','UA','BA','AF','QR','EK','LH'],
  MIA: ['AA','AA','AA','DL','UA','B6','BA','AF'],
  SEA: ['AS','AS','AS','DL','UA','AA','WN','B6'],
  DEN: ['UA','UA','DL','AA','WN','F9','B6','AS'],
  LAS: ['SW','WN','WN','AA','DL','UA','NK','F9','B6'],
  SFO: ['UA','UA','AS','DL','AA','B6','BA','LH','QR'],
  BOS: ['AA','JB','B6','B6','DL','UA','AS','BA'],
  IAH: ['UA','UA','UA','AA','DL','WN','B6','LH'],
  MCO: ['AA','DL','UA','WN','B6','NK','AS','SW'],
  PHX: ['AA','AA','AA','WN','WN','DL','UA','AS'],
};

// ── Stable pseudo-random (seeded) ───────────────────────────
// Deterministic so the same airport+time always gives the same board
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

// ── Gate/terminal helpers ────────────────────────────────────
const GATE_LETTERS = ['A', 'B', 'C', 'D', 'E'];

function fakeGate(rng: () => number): { terminal: string; gate: string } {
  const letter = pick(GATE_LETTERS, rng);
  const num    = Math.floor(rng() * 30) + 1;
  return { terminal: letter, gate: `${letter}${num}` };
}

// ── Simulated board ──────────────────────────────────────────
function makeSimulatedRows(direction: 'dep' | 'arr', iata: string, count = 14): FlightRow[] {
  const now      = Date.now();
  // Seed on airport + direction + current hour-slot so board refreshes hourly
  const hourSlot = Math.floor(now / (60 * 60_000));
  const seed     = iata.split('').reduce((h, c) => h * 31 + c.charCodeAt(0), 0) ^
                   (direction === 'dep' ? 0x1234 : 0x5678) ^
                   hourSlot;
  const rng      = seededRng(seed);

  const routes    = (HUB_ROUTES[iata] ?? DEFAULT_ROUTES).filter(r => r.iata !== iata);
  const hubAirls  = HUB_AIRLINES[iata] ?? ['AA','DL','UA','WN','AS','B6'];

  return Array.from({ length: count }, (_, i): FlightRow => {
    // Departures: 0–240 min from now; Arrivals: -30 to +120 min from now
    const minOffset = direction === 'dep'
      ? 8 + i * 15 + Math.floor(rng() * 10)    // every ~15 min, up to 4 h out
      : -30 + i * 10 + Math.floor(rng() * 8);   // mix of past + upcoming

    const scheduledMs = now + minOffset * 60_000;
    const scheduledISO = new Date(scheduledMs).toISOString();

    // 12% chance of delay (realistic)
    const isDelayed  = rng() < 0.12;
    const delayMins  = isDelayed ? (Math.floor(rng() * 8) + 1) * 10 : 0; // 10, 20, ... 80 min

    // Status based on time offset
    let status: string;
    if (direction === 'dep') {
      if (minOffset < -5)  status = 'landed';
      else if (minOffset < 20) status = isDelayed ? 'delayed' : 'active';
      else status = isDelayed ? 'delayed' : 'scheduled';
    } else {
      if (minOffset < -10) status = 'landed';
      else if (minOffset < 15) status = isDelayed ? 'delayed' : 'active';
      else status = 'scheduled';
    }

    const estimatedMs  = scheduledMs + delayMins * 60_000;
    const estimatedISO = new Date(estimatedMs).toISOString();
    const actualISO    = (status === 'landed' || status === 'active')
      ? new Date(estimatedMs + (Math.floor(rng() * 5) - 2) * 60_000).toISOString()
      : null;

    const airlineIata = pick(hubAirls, rng);
    const airline     = AIRLINES.find(a => a.iata === airlineIata) ?? AIRLINES[0];
    const flightNum   = airline.flightBase + Math.floor(rng() * 899) + 1;

    const route = pick(routes, rng);
    const { terminal, gate } = fakeGate(rng);

    return {
      flightIata:  `${airline.iata}${flightNum}`,
      airline:     airline.name,
      airlineIata: airline.iata,
      city:        route.city,
      cityIata:    route.iata,
      scheduled:   scheduledISO,
      estimated:   estimatedISO,
      actual:      actualISO,
      status,
      delay:       isDelayed ? delayMins : null,
      terminal,
      gate,
    };
  });
}

// ── Fetch one direction from AviationStack ──────────────────
async function fetchFlights(
  direction: 'dep' | 'arr',
  iata: string,
  apiKey: string,
): Promise<FlightRow[]> {
  const paramKey = direction === 'dep' ? 'dep_iata' : 'arr_iata';
  const url = `http://api.aviationstack.com/v1/flights?access_key=${apiKey}`
    + `&${paramKey}=${iata}&limit=20`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(6_000) });
  if (!resp.ok) throw new Error(`AviationStack ${resp.status}`);

  const json    = (await resp.json()) as { data?: AsFlight[]; error?: { message: string } };
  if (json.error) throw new Error(`AviationStack API error: ${json.error.message}`);
  const flights = json.data ?? [];

  return flights.map((f): FlightRow => {
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
  if (!iata || iata.length !== 3) {
    return res.status(400).json({ error: 'airportIata required (e.g. ATL)' });
  }

  // ── Cache check ───────────────────────────────────────────
  const cacheKey = `board:v2:${iata}`;
  const cached   = await redis.get<BoardData>(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  const asKey = process.env['AVIATIONSTACK_API_KEY'];

  let departures: FlightRow[] = [];
  let arrivals:   FlightRow[] = [];
  let usedLive = false;

  // ── 1. Try live AviationStack ─────────────────────────────
  if (asKey) {
    try {
      const [depResult, arrResult] = await Promise.allSettled([
        fetchFlights('dep', iata, asKey),
        fetchFlights('arr', iata, asKey),
      ]);
      departures = depResult.status === 'fulfilled' ? depResult.value : [];
      arrivals   = arrResult.status === 'fulfilled' ? arrResult.value : [];

      // If both returned data, use live
      if (departures.length > 0 || arrivals.length > 0) {
        usedLive = true;
      }
    } catch {
      // fall through to simulated
    }
  }

  // ── 2. Simulated board (API absent, quota exhausted, or 0 results) ──
  if (!usedLive) {
    departures = makeSimulatedRows('dep', iata);
    arrivals   = makeSimulatedRows('arr', iata);
  }

  const result: BoardData = {
    iata,
    departures,
    arrivals,
    cachedAt: new Date().toISOString(),
    mock: !usedLive,
  };

  // Live: 5-min cache. Simulated: 15-min cache (seeded by hour-slot anyway)
  await redis.setex(cacheKey, usedLive ? 300 : 900, result);
  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json(result);
}
