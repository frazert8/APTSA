// ============================================================
// APTSA -- Live Flight Board (Departures + Arrivals)
//
// GET /api/board?airportIata=ATL
//
// Uses AviationStack to fetch upcoming departures and recent
// arrivals at the given airport.  Results cached 5 min in
// Redis to stay well within the free-tier 500 req/month cap.
//
// Env: AVIATIONSTACK_API_KEY
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { redis } from '../src/lib/redis.js';

// ── AviationStack flight shape (fields we use) ──────────────
interface AsFlight {
  flight_status: string;
  departure: {
    airport:    string;
    iata:       string;
    scheduled:  string;
    estimated:  string;
    actual:     string | null;
    delay:      number | null;
    terminal:   string | null;
    gate:       string | null;
  };
  arrival: {
    airport:    string;
    iata:       string;
    scheduled:  string;
    estimated:  string;
    actual:     string | null;
    delay:      number | null;
    terminal:   string | null;
    gate:       string | null;
  };
  airline: { name: string; iata: string };
  flight:  { iata: string; number: string };
}

// ── Normalised row returned to the client ───────────────────
export interface FlightRow {
  flightIata:      string;
  airline:         string;
  city:            string;
  cityIata:        string;
  scheduled:       string;
  estimated:       string;
  actual:          string | null;
  status:          string;
  delay:           number | null;
  terminal:        string | null;
  gate:            string | null;
}

export interface BoardData {
  iata:        string;
  departures:  FlightRow[];
  arrivals:    FlightRow[];
  cachedAt:    string;
  mock:        boolean;
}

// ── Fetch one direction from AviationStack ──────────────────
async function fetchFlights(
  direction: 'dep' | 'arr',
  iata: string,
  apiKey: string,
): Promise<FlightRow[]> {
  const paramKey  = direction === 'dep' ? 'dep_iata' : 'arr_iata';
  const url = `http://api.aviationstack.com/v1/flights?access_key=${apiKey}`
    + `&${paramKey}=${iata}&limit=20`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(6_000) });
  if (!resp.ok) throw new Error(`AviationStack ${resp.status}`);

  const json    = (await resp.json()) as { data?: AsFlight[] };
  const flights = json.data ?? [];

  return flights.map((f): FlightRow => {
    const other = direction === 'dep' ? f.arrival : f.departure;
    return {
      flightIata: f.flight.iata ?? `${f.airline.iata}${f.flight.number}`,
      airline:    f.airline.name,
      city:       other.airport,
      cityIata:   other.iata,
      scheduled:  direction === 'dep' ? f.departure.scheduled : f.arrival.scheduled,
      estimated:  direction === 'dep' ? f.departure.estimated : f.arrival.estimated,
      actual:     direction === 'dep' ? f.departure.actual    : f.arrival.actual,
      status:     f.flight_status,
      delay:      direction === 'dep' ? f.departure.delay     : f.arrival.delay,
      terminal:   direction === 'dep' ? f.departure.terminal  : f.arrival.terminal,
      gate:       direction === 'dep' ? f.departure.gate      : f.arrival.gate,
    };
  });
}

// ── Mock data (no API key) ───────────────────────────────────
function makeMockRows(direction: 'dep' | 'arr', iata: string): FlightRow[] {
  const airlines = ['American', 'United', 'Delta', 'Southwest', 'JetBlue'];
  const cities   = [
    { city: 'Miami International',     iata: 'MIA' },
    { city: "Chicago O'Hare Intl",     iata: 'ORD' },
    { city: 'Dallas Fort Worth Intl',  iata: 'DFW' },
    { city: 'Los Angeles Intl',        iata: 'LAX' },
    { city: 'Boston Logan Intl',       iata: 'BOS' },
    { city: 'Seattle-Tacoma Intl',     iata: 'SEA' },
    { city: 'Denver Intl',             iata: 'DEN' },
    { city: 'Phoenix Sky Harbor',      iata: 'PHX' },
  ].filter(c => c.iata !== iata);

  const statuses = ['scheduled', 'scheduled', 'scheduled', 'active', 'active', 'landed', 'delayed'];
  const now = Date.now();

  return Array.from({ length: 8 }, (_, i) => {
    const base    = now + (direction === 'dep' ? 1 : -1) * (i * 25 + 10) * 60_000;
    const city    = cities[i % cities.length];
    const airline = airlines[i % airlines.length];
    const status  = statuses[i % statuses.length];
    const delay   = status === 'delayed' ? 25 + (i * 7) : null;
    return {
      flightIata: `${airline.slice(0,1)}${airline.slice(-1).toUpperCase()}${100 + i * 37}`,
      airline,
      city:      city.city,
      cityIata:  city.iata,
      scheduled: new Date(base).toISOString(),
      estimated: new Date(base + (delay ?? 0) * 60_000).toISOString(),
      actual:    status === 'active' || status === 'landed'
                   ? new Date(base + (Math.random() * 8 - 4) * 60_000).toISOString()
                   : null,
      status,
      delay,
      terminal: `${i % 3 + 1}`,
      gate:     `${String.fromCharCode(65 + (i % 4))}${10 + i}`,
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
  const cacheKey = `board:${iata}`;
  const cached   = await redis.get<BoardData>(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  const asKey = process.env['AVIATIONSTACK_API_KEY'];

  // ── No key → demo mode ────────────────────────────────────
  if (!asKey) {
    const result: BoardData = {
      iata,
      departures: makeMockRows('dep', iata),
      arrivals:   makeMockRows('arr', iata),
      cachedAt:   new Date().toISOString(),
      mock:       true,
    };
    // Short cache for mock (1 min) to keep times realistic
    await redis.setex(cacheKey, 60, result);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(result);
  }

  // ── Live data: fetch dep + arr in parallel ────────────────
  const [depResult, arrResult] = await Promise.allSettled([
    fetchFlights('dep', iata, asKey),
    fetchFlights('arr', iata, asKey),
  ]);

  const departures = depResult.status === 'fulfilled' ? depResult.value : [];
  const arrivals   = arrResult.status === 'fulfilled' ? arrResult.value : [];

  const result: BoardData = {
    iata,
    departures,
    arrivals,
    cachedAt: new Date().toISOString(),
    mock:     false,
  };

  // 5 min cache — board data changes slowly
  await redis.setex(cacheKey, 300, result);
  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json(result);
}
