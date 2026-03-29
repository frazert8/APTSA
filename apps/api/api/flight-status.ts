// ============================================================
// APTSA -- AI Flight Status & Delay Detection
//
// Priority chain (first success wins):
//   1. FlightAware AeroAPI  — best coverage for US flights,
//      real FAA data, live position, structured status
//   2. AviationStack        — global fallback, includes live position
//   3. Realistic mock       — demo mode when no keys configured
//
// Env: FLIGHTAWARE_API_KEY, AVIATIONSTACK_API_KEY
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';

type DelayRisk = { risk: 'low' | 'medium' | 'high'; reason: string };

// ════════════════════════════════════════════════════════════════
// FLIGHTAWARE AEROAPI
// ════════════════════════════════════════════════════════════════

interface FaPosition {
  altitude:    number;   // hundreds of feet (350 = 35,000 ft)
  groundspeed: number;   // knots
  heading:     number;
  latitude:    number;
  longitude:   number;
  timestamp:   string;
  update_type: string;
}

interface FaAirport {
  code:      string;
  code_iata: string;
  name:      string;
  city:      string;
  timezone?: string;   // IANA tz, e.g. "America/New_York" — used for local-time display
}

interface FaFlight {
  ident:         string;
  ident_iata:    string;
  status:        string;   // e.g. "En Route / On Time", "Delayed", "Cancelled"
  scheduled_out: string;   // gate departure (UTC ISO)
  actual_out:    string | null;
  estimated_in:  string | null;
  actual_in:     string | null;
  origin:      FaAirport;
  destination: FaAirport;
  last_position: FaPosition | null;
  aircraft_type: string | null;
  operator:      string | null;
  operator_iata: string | null;
  departure_delay: number | null;   // seconds
  arrival_delay:   number | null;   // seconds
  gate_origin?:    string | null;
  gate_destination?: string | null;
}

function faDelayRisk(f: FaFlight): DelayRisk {
  const status = f.status.toLowerCase();

  if (status.includes('cancel'))  return { risk: 'high', reason: 'Flight cancelled' };
  if (status.includes('divert'))  return { risk: 'high', reason: 'Flight diverted' };

  const depDelayMin = Math.round((f.departure_delay ?? 0) / 60);
  const arrDelayMin = Math.round((f.arrival_delay   ?? 0) / 60);
  const maxDelay    = Math.max(depDelayMin, arrDelayMin);

  if (maxDelay > 60) return { risk: 'high',   reason: `${maxDelay} min delay` };
  if (maxDelay > 20) return { risk: 'medium', reason: `${maxDelay} min delay` };
  if (status.includes('delay')) return { risk: 'medium', reason: 'Delay reported' };

  // Still at gate past scheduled departure
  if (!f.actual_out && f.scheduled_out) {
    const minsLate = Math.floor((Date.now() - new Date(f.scheduled_out).getTime()) / 60_000);
    if (minsLate > 30) return { risk: 'high',   reason: `Still at gate, ${minsLate} min past departure` };
    if (minsLate > 10) return { risk: 'medium', reason: `Still on ground, ${minsLate} min past departure` };
  }

  return { risk: 'low', reason: 'On schedule' };
}

async function queryFlightAware(flightIata: string, apiKey: string) {
  const url  = `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(flightIata)}?max_pages=1`;
  const resp = await fetch(url, {
    headers: { 'x-apikey': apiKey },
    signal:  AbortSignal.timeout(6_000),
  });
  if (!resp.ok) throw new Error(`FlightAware HTTP ${resp.status}`);

  const json = (await resp.json()) as { flights?: FaFlight[] };
  const flights = json.flights ?? [];
  if (!flights.length) throw new Error('no_flights');

  // Prefer in-flight, then most-recently-scheduled
  const f = flights.find((x) => x.last_position && !x.actual_in)
         ?? flights.find((x) => !x.actual_in)
         ?? flights[0];

  if (!f) throw new Error('no_flights');

  const pos = f.last_position;
  const delayRisk = faDelayRisk(f);

  return {
    flightNumber: f.ident_iata || f.ident,
    status:       f.status,
    airline:      f.operator ?? f.operator_iata ?? 'Unknown',
    validated:    true,
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
      scheduled: f.estimated_in ?? null,
      actual:    f.actual_in,
      delay:     f.arrival_delay != null ? Math.round(f.arrival_delay / 60) : 0,
      gate:      f.gate_destination ?? null,
    },
    live: pos ? {
      latitude:  pos.latitude,
      longitude: pos.longitude,
      altitude:  pos.altitude * 100,   // convert hundreds-of-feet → feet
      speed:     pos.groundspeed,
      heading:   pos.heading,
      isGround:  pos.altitude < 1,
    } : null,
    aircraft: f.aircraft_type ?? null,
    delayRisk,
    source: 'flightaware' as const,
  };
}

// ════════════════════════════════════════════════════════════════
// AVIATIONSTACK (fallback)
// ════════════════════════════════════════════════════════════════

interface AviationStackFlight {
  flight_status: string;
  departure: { airport: string; iata: string; scheduled: string; estimated: string; actual: string | null; delay: number | null; gate?: string | null; timezone?: string };
  arrival:   { airport: string; iata: string; scheduled: string; estimated: string; actual: string | null; delay: number | null; gate?: string | null; timezone?: string };
  live:      { latitude: number; longitude: number; altitude: number; speed_horizontal: number; is_ground: boolean } | null;
  airline:   { name: string; iata: string };
  flight:    { iata: string; number: string };
  aircraft:  { registration: string; iata: string } | null;
}

function asDelayRisk(f: AviationStackFlight): DelayRisk {
  const status   = f.flight_status;
  const maxDelay = Math.max(f.departure.delay ?? 0, f.arrival.delay ?? 0);

  if (status === 'cancelled') return { risk: 'high',   reason: 'Flight cancelled' };
  if (status === 'diverted')  return { risk: 'high',   reason: 'Flight diverted'  };
  if (maxDelay > 60)          return { risk: 'high',   reason: `${maxDelay} min delay detected` };
  if (maxDelay > 20)          return { risk: 'medium', reason: `${maxDelay} min delay` };

  if (f.live?.is_ground && !f.departure.actual) {
    const minsLate = Math.floor((Date.now() - new Date(f.departure.scheduled).getTime()) / 60_000);
    if (minsLate > 30) return { risk: 'high',   reason: `Still at gate, ${minsLate} min past departure` };
    if (minsLate > 10) return { risk: 'medium', reason: `Still on ground, ${minsLate} min past departure` };
  }
  return { risk: 'low', reason: 'On schedule' };
}

async function queryAviationStack(flightIata: string, apiKey: string) {
  const url  = `http://api.aviationstack.com/v1/flights?access_key=${apiKey}&flight_iata=${flightIata}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(6_000) });
  if (!resp.ok) throw new Error(`AviationStack HTTP ${resp.status}`);

  const json    = (await resp.json()) as { data?: AviationStackFlight[] };
  const flights = json.data ?? [];
  if (!flights.length) throw new Error('no_flights');

  const f = flights.find((x) => x.flight_status === 'active') ?? flights[0];
  if (!f) throw new Error('no_flights');

  const delayRisk = asDelayRisk(f);

  return {
    flightNumber: f.flight.iata,
    status:       f.flight_status,
    airline:      f.airline.name,
    validated:    true,
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
      scheduled: f.arrival.scheduled,
      actual:    f.arrival.actual,
      delay:     f.arrival.delay ?? 0,
      gate:      f.arrival.gate ?? null,
    },
    live: f.live ? {
      latitude:  f.live.latitude,
      longitude: f.live.longitude,
      altitude:  f.live.altitude,
      speed:     f.live.speed_horizontal,
      heading:   null,
      isGround:  f.live.is_ground,
    } : null,
    aircraft:   f.aircraft?.iata ?? null,
    delayRisk,
    source: 'aviationstack' as const,
  };
}

// ════════════════════════════════════════════════════════════════
// HANDLER
// ════════════════════════════════════════════════════════════════

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const flightIata = (req.query['flight'] as string | undefined)?.toUpperCase().trim();
  if (!flightIata || flightIata.length < 3 || flightIata.length > 8) {
    return res.status(400).json({ error: 'flight parameter required (e.g. AA123)' });
  }

  const faKey = process.env['FLIGHTAWARE_API_KEY'];
  const asKey = process.env['AVIATIONSTACK_API_KEY'];

  // ── No keys → demo mode ───────────────────────────────────
  if (!faKey && !asKey) {
    const mockOrigins: Record<string, { iata: string; name: string; city: string }> = {
      AA: { iata: 'MIA', name: 'Miami International',         city: 'Miami, FL'    },
      UA: { iata: 'ORD', name: "Chicago O'Hare International",city: 'Chicago, IL'  },
      DL: { iata: 'ATL', name: 'Hartsfield-Jackson Atlanta',  city: 'Atlanta, GA'  },
      WN: { iata: 'DAL', name: 'Dallas Love Field',           city: 'Dallas, TX'   },
      B6: { iata: 'JFK', name: 'JFK International',           city: 'New York, NY' },
      SW: { iata: 'DAL', name: 'Dallas Love Field',           city: 'Dallas, TX'   },
    };
    const prefix = flightIata.replace(/\d/g, '').slice(0, 2);
    const origin = mockOrigins[prefix] ?? { iata: 'MIA', name: 'Miami International', city: 'Miami, FL' };
    return res.status(200).json({
      mock:      true,
      validated: false,
      source:    'demo',
      flightNumber: flightIata,
      status: 'En Route / On Time',
      airline: `${prefix || 'Demo'} Airlines`,
      origin:      { ...origin, timezone: null },
      destination: { iata: 'JFK', name: 'JFK International', city: 'New York, NY', timezone: 'America/New_York' },
      departure: { scheduled: new Date(Date.now() - 3_600_000).toISOString(), actual: new Date(Date.now() - 3_540_000).toISOString(), delay: 0, gate: null },
      arrival:   { scheduled: new Date(Date.now() + 3_600_000).toISOString(), actual: null, delay: 0, gate: null },
      live: { latitude: 28.6, longitude: -80.5, altitude: 35_000, speed: 510, heading: 45, isGround: false },
      aircraft: 'B738',
      delayRisk: { risk: 'low', reason: 'On schedule' },
      note: 'Demo data — add FLIGHTAWARE_API_KEY or AVIATIONSTACK_API_KEY for live tracking',
    });
  }

  // ── 1. Try FlightAware (best for US) ──────────────────────
  if (faKey) {
    try {
      const data = await queryFlightAware(flightIata, faKey);
      return res.status(200).json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'no_flights') {
        return res.status(404).json({ error: `No flight found for ${flightIata}` });
      }
      console.warn(`[flight-status] FlightAware failed (${msg}), trying AviationStack`);
    }
  }

  // ── 2. AviationStack fallback ──────────────────────────────
  if (asKey) {
    try {
      const data = await queryAviationStack(flightIata, asKey);
      return res.status(200).json(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'no_flights') {
        return res.status(404).json({ error: `No flight found for ${flightIata}` });
      }
      console.error(`[flight-status] AviationStack also failed: ${msg}`);
    }
  }

  return res.status(502).json({ error: 'Flight data temporarily unavailable — please try again' });
}
