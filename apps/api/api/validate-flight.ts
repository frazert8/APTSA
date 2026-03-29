// ============================================================
// APTSA -- Flight Validation Service
//
// GET /api/validate-flight?flight=DL2276
//
// Multi-source validation: FlightAware (primary) → AviationStack
// (fallback). Validates that a flight number is real, returns
// its canonical route, schedule, and a confidence score.
//
// Used to:
//   1. Verify flight numbers before any data is displayed
//   2. Cross-check board display data for conflicts
//   3. Provide data quality badges to the frontend
//
// Confidence scoring:
//   1.0 = FlightAware confirmed (authoritative FAA source)
//   0.8 = AviationStack confirmed (real-time global coverage)
//   0.0 = Not found in any source
//
// Cache: 3-minute TTL (flights change slowly when scheduled)
// Env:   FLIGHTAWARE_API_KEY, AVIATIONSTACK_API_KEY
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { redis } from '../src/lib/redis.js';

export interface ValidatedFlight {
  verified:      boolean;
  confidence:    number;           // 0.0–1.0
  flightNumber:  string;
  airline:       string;
  airlineIata:   string;
  origin: {
    iata:        string;
    name:        string;
    city:        string;
    timezone:    string | null;
  };
  destination: {
    iata:        string;
    name:        string;
    city:        string;
    timezone:    string | null;
  };
  departure: {
    scheduled:   string;           // ISO UTC
    actual:      string | null;
    delay:       number;           // minutes
    gate:        string | null;
  };
  arrival: {
    scheduled:   string | null;    // ISO UTC
    actual:      string | null;
    delay:       number;           // minutes
    gate:        string | null;
  };
  status:        string;
  aircraft:      string | null;
  dataSource:    'flightaware' | 'aviationstack';
  validatedAt:   string;          // ISO UTC
}

export interface ValidationFailure {
  verified:    false;
  flightNumber: string;
  confidence:  0;
  error:       string;
  dataSource:  'none';
}

// ── FlightAware AeroAPI ─────────────────────────────────────

interface FaAirport {
  code:      string;
  code_iata: string;
  name:      string;
  city:      string;
  timezone?: string;
}

interface FaFlight {
  ident:            string;
  ident_iata:       string;
  status:           string;
  scheduled_out:    string;
  scheduled_in?:    string;
  estimated_in?:    string;
  actual_out:       string | null;
  actual_in:        string | null;
  origin:           FaAirport;
  destination:      FaAirport;
  aircraft_type:    string | null;
  operator:         string | null;
  operator_iata:    string | null;
  departure_delay:  number | null;
  arrival_delay:    number | null;
  gate_origin?:     string | null;
  gate_destination?: string | null;
}

async function validateViaFlightAware(
  flightIata: string,
  apiKey: string,
): Promise<ValidatedFlight> {
  const url = `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(flightIata)}?max_pages=1`;
  const resp = await fetch(url, {
    headers: { 'x-apikey': apiKey },
    signal:  AbortSignal.timeout(7_000),
  });
  if (!resp.ok) throw new Error(`FlightAware HTTP ${resp.status}`);

  const json = (await resp.json()) as { flights?: FaFlight[] };
  const flights = json.flights ?? [];
  if (!flights.length) throw new Error('no_flights');

  // Prefer in-flight, then most-recently-scheduled upcoming flight
  const f = flights.find(x => !x.actual_in && x.actual_out)
         ?? flights.find(x => !x.actual_in)
         ?? flights[0];
  if (!f) throw new Error('no_flights');

  return {
    verified:     true,
    confidence:   1.0,
    flightNumber: f.ident_iata || f.ident,
    airline:      f.operator ?? f.operator_iata ?? 'Unknown',
    airlineIata:  f.operator_iata ?? '',
    origin: {
      iata:     f.origin.code_iata,
      name:     f.origin.name,
      city:     f.origin.city,
      timezone: f.origin.timezone ?? null,
    },
    destination: {
      iata:     f.destination.code_iata,
      name:     f.destination.name,
      city:     f.destination.city,
      timezone: f.destination.timezone ?? null,
    },
    departure: {
      scheduled: f.scheduled_out,
      actual:    f.actual_out,
      delay:     f.departure_delay != null ? Math.round(f.departure_delay / 60) : 0,
      gate:      f.gate_origin ?? null,
    },
    arrival: {
      scheduled: f.estimated_in ?? f.scheduled_in ?? null,
      actual:    f.actual_in,
      delay:     f.arrival_delay != null ? Math.round(f.arrival_delay / 60) : 0,
      gate:      f.gate_destination ?? null,
    },
    status:      f.status,
    aircraft:    f.aircraft_type ?? null,
    dataSource:  'flightaware',
    validatedAt: new Date().toISOString(),
  };
}

// ── AviationStack ────────────────────────────────────────────

interface AsFlight {
  flight_status: string;
  departure: {
    airport:   string;
    iata:      string;
    scheduled: string;
    estimated: string;
    actual:    string | null;
    delay:     number | null;
    terminal?: string | null;
    gate?:     string | null;
    timezone?: string;
  };
  arrival: {
    airport:   string;
    iata:      string;
    scheduled: string;
    estimated: string;
    actual:    string | null;
    delay:     number | null;
    terminal?: string | null;
    gate?:     string | null;
    timezone?: string;
  };
  airline:  { name: string; iata: string };
  flight:   { iata: string; icao?: string; number: string };
  aircraft: { registration: string; iata: string } | null;
}

async function validateViaAviationStack(
  flightIata: string,
  apiKey: string,
): Promise<ValidatedFlight> {
  const url = `http://api.aviationstack.com/v1/flights?access_key=${apiKey}&flight_iata=${encodeURIComponent(flightIata)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(7_000) });
  if (!resp.ok) throw new Error(`AviationStack HTTP ${resp.status}`);

  const json = (await resp.json()) as { data?: AsFlight[]; error?: { message: string } };
  if (json.error) throw new Error(`AviationStack: ${json.error.message}`);
  const flights = json.data ?? [];
  if (!flights.length) throw new Error('no_flights');

  const f = flights.find(x => x.flight_status === 'active')
         ?? flights.find(x => x.flight_status === 'scheduled')
         ?? flights[0];
  if (!f) throw new Error('no_flights');

  return {
    verified:     true,
    confidence:   0.8,
    flightNumber: f.flight.iata ?? `${f.airline.iata}${f.flight.number}`,
    airline:      f.airline.name,
    airlineIata:  f.airline.iata ?? '',
    origin: {
      iata:     f.departure.iata,
      name:     f.departure.airport,
      city:     f.departure.airport,
      timezone: f.departure.timezone ?? null,
    },
    destination: {
      iata:     f.arrival.iata,
      name:     f.arrival.airport,
      city:     f.arrival.airport,
      timezone: f.arrival.timezone ?? null,
    },
    departure: {
      scheduled: f.departure.scheduled,
      actual:    f.departure.actual,
      delay:     f.departure.delay ?? 0,
      gate:      f.departure.gate ?? null,
    },
    arrival: {
      scheduled: f.arrival.scheduled ?? null,
      actual:    f.arrival.actual,
      delay:     f.arrival.delay ?? 0,
      gate:      f.arrival.gate ?? null,
    },
    status:      f.flight_status,
    aircraft:    f.aircraft?.iata ?? null,
    dataSource:  'aviationstack',
    validatedAt: new Date().toISOString(),
  };
}

// ── Handler ──────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const raw = (req.query['flight'] as string | undefined)?.toUpperCase().trim() ?? '';
  // Normalise: strip spaces (e.g. "DL 2276" → "DL2276")
  const flightIata = raw.replace(/\s+/g, '');

  if (!flightIata || flightIata.length < 2 || flightIata.length > 8) {
    return res.status(400).json({
      verified:     false,
      flightNumber: flightIata,
      confidence:   0,
      error:        'flight parameter required (e.g. DL2276)',
      dataSource:   'none',
    } satisfies ValidationFailure);
  }

  // ── Cache check ───────────────────────────────────────────
  const cacheKey = `validated:v2:${flightIata}`;
  try {
    const cached = await redis.get<ValidatedFlight | ValidationFailure>(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      const statusCode = (cached as ValidationFailure).verified === false ? 404 : 200;
      return res.status(statusCode).json(cached);
    }
  } catch { /* Redis failure is non-fatal */ }

  const faKey = process.env['FLIGHTAWARE_API_KEY'];
  const asKey = process.env['AVIATIONSTACK_API_KEY'];

  if (!faKey && !asKey) {
    const result: ValidationFailure = {
      verified:     false,
      flightNumber: flightIata,
      confidence:   0,
      error:        'No aviation API keys configured — configure FLIGHTAWARE_API_KEY or AVIATIONSTACK_API_KEY',
      dataSource:   'none',
    };
    return res.status(200).json(result);
  }

  // ── 1. FlightAware (confidence 1.0) ────────────────────────
  if (faKey) {
    try {
      const result = await validateViaFlightAware(flightIata, faKey);
      await redis.setex(cacheKey, 180, result).catch(() => {});
      res.setHeader('X-Cache', 'MISS');
      return res.status(200).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'no_flights') {
        const result: ValidationFailure = {
          verified:     false,
          flightNumber: flightIata,
          confidence:   0,
          error:        `Flight ${flightIata} not found — verify the flight number`,
          dataSource:   'none',
        };
        await redis.setex(cacheKey, 60, result).catch(() => {}); // short TTL for not-found
        return res.status(404).json(result);
      }
      console.warn(`[validate-flight] FlightAware failed (${msg}), trying AviationStack`);
    }
  }

  // ── 2. AviationStack (confidence 0.8) ─────────────────────
  if (asKey) {
    try {
      const result = await validateViaAviationStack(flightIata, asKey);
      await redis.setex(cacheKey, 180, result).catch(() => {});
      res.setHeader('X-Cache', 'MISS');
      return res.status(200).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'no_flights') {
        const result: ValidationFailure = {
          verified:     false,
          flightNumber: flightIata,
          confidence:   0,
          error:        `Flight ${flightIata} not found — verify the flight number`,
          dataSource:   'none',
        };
        await redis.setex(cacheKey, 60, result).catch(() => {});
        return res.status(404).json(result);
      }
      console.error(`[validate-flight] AviationStack also failed: ${msg}`);
    }
  }

  return res.status(502).json({
    verified:     false,
    flightNumber: flightIata,
    confidence:   0,
    error:        'Flight validation service temporarily unavailable — please try again',
    dataSource:   'none',
  } satisfies ValidationFailure);
}
