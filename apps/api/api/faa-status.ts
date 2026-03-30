// ============================================================
// APTSA -- FAA NAS (National Airspace System) Status
//
// GET /api/faa-status?airportIata=ORD
//
// Source: nasstatus.faa.gov (FAA public API — no key required)
// The same ATC mandate data that powers Flighty's "Airport
// Intelligence" delay explanations.
//
// Returns active programs affecting the requested airport:
//   - Ground Delay Programs (GDPs) — avg/max delay, trend
//   - Ground Stops — holds all inbound/outbound flights
//   - Arrival/Departure delay advisories
//   - Airport Closures
//   - Airspace Flow Programs (AFPs) — en-route restrictions
//
// Cache: 2-minute TTL — programs change rapidly during operations
//
// Graceful degradation: if nasstatus.faa.gov is unreachable,
// returns empty programs array (no active programs) rather than
// an error — frontend treats this as "no ATC restrictions".
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { redis } from '../src/lib/redis.js';

// ── nasstatus.faa.gov JSON types ─────────────────────────────

interface NasDelayInfo {
  ARPT:                string;
  Reason:              string;
  Arrival_Departure?:  string;
  Min?:                string;   // "41" minutes or "1:05" h:mm
  Max?:                string;
  Trend?:              string;   // "Increasing" | "Decreasing" | "Stagnant"
}

interface NasGroundDelay {
  ARPT:    string;
  Reason:  string;
  Avg:     string;   // e.g. "1:12" → 1h 12m average
  Max:     string;
  Trend?:  string;
}

interface NasGroundStop {
  ARPT:     string;
  Reason:   string;
  EndTime?: string;  // "08:00PM EDT"
  Type?:    string;  // "Regional" | "National"
}

interface NasClosure {
  ARPT:       string;
  Reason:     string;
  BeginTime?: string;
  EndTime?:   string;
}

interface NasAfp {
  Name:          string;
  Reason:        string;
  AffectedFlows?: string;
}

interface NasStatusEnvelope {
  AirportStatusInformation: {
    UpdateTime:                      string;
    ArrivalDepartureDelayInformation?: NasDelayInfo[];
    GroundDelayPrograms?:             NasGroundDelay[];
    GroundStops?:                     NasGroundStop[];
    AirspaceFlowPrograms?:            NasAfp[];
    Closures?:                        NasClosure[];
  };
}

// ── Public response shape ────────────────────────────────────

export interface FaaProgram {
  type:      'ground_delay' | 'ground_stop' | 'arrival_delay'
           | 'departure_delay' | 'closure' | 'airspace_flow';
  severity:  'warn' | 'crit';
  headline:  string;
  detail:    string;
  trend?:    string | undefined;
}

export interface FaaStatusData {
  iata:              string;
  programs:          FaaProgram[];
  hasActivePrograms: boolean;
  updateTime:        string;   // NASStatus last-refresh timestamp
  fetchedAt:         string;
  source:            'nasstatus';
}

// ── Helpers ──────────────────────────────────────────────────

// "WEATHER / THUNDERSTORMS" → "Thunderstorms"
// "RUNWAY CONSTRUCTION"      → "Runway Construction"
function humanizeReason(raw: string): string {
  return raw
    .replace(/^WEATHER\s*\/\s*/i, '')
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

// "1:30" → "1h 30m"   "41" → "41 min"   "0:45" → "45 min"
function humanizeDelay(str: string | undefined): string {
  if (!str) return '';
  if (str.includes(':')) {
    const parts = str.split(':');
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    if (h === 0 || isNaN(h))  return `${isNaN(m) ? 0 : m} min`;
    if (m === 0 || isNaN(m))  return `${h}h`;
    return `${h}h ${m}m`;
  }
  const mins = parseInt(str, 10);
  if (isNaN(mins)) return str;
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60 > 0 ? (mins % 60) + 'm' : ''}`.trim() : `${mins} min`;
}

// Normalize inbound array: NASStatus sometimes returns a single object
// instead of an array when there's only one entry (quirk of XML→JSON)
function toArray<T>(val: T | T[] | undefined): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

// ── Handler ──────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const iata = (req.query['airportIata'] as string | undefined)?.toUpperCase().trim();
  if (!iata || iata.length !== 3) {
    return res.status(400).json({ error: 'airportIata required (e.g. ORD)' });
  }

  // ── Cache check ───────────────────────────────────────────
  const cacheKey = `faastat:v2:${iata}`;
  try {
    const cached = await redis.get<FaaStatusData>(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cached);
    }
  } catch { /* Redis failure non-fatal */ }

  // ── Fetch NASStatus ───────────────────────────────────────
  let envelope: NasStatusEnvelope;
  try {
    const resp = await fetch('https://nasstatus.faa.gov/api/airport-status-information', {
      headers: {
        'Accept':     'application/json',
        'User-Agent': 'APTSA/1.0 (+https://aptsa.vercel.app)',
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) throw new Error(`NASStatus HTTP ${resp.status}`);
    envelope = (await resp.json()) as NasStatusEnvelope;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[faa-status] NASStatus unavailable (${msg}) — returning empty`);
    // Graceful degradation: return "no programs" so frontend doesn't error
    const empty: FaaStatusData = {
      iata,
      programs:          [],
      hasActivePrograms: false,
      updateTime:        new Date().toISOString(),
      fetchedAt:         new Date().toISOString(),
      source:            'nasstatus',
    };
    return res.status(200).json(empty);
  }

  const info     = envelope.AirportStatusInformation;
  const programs: FaaProgram[] = [];

  // ── 1. Ground Delay Programs (GDPs) ─────────────────────
  // Aircraft on the ground; avg/max delays growing due to
  // weather, capacity constraints, or volume issues.
  for (const gdp of toArray(info.GroundDelayPrograms)) {
    if (gdp.ARPT?.toUpperCase() !== iata) continue;
    const avg    = humanizeDelay(gdp.Avg);
    const max    = humanizeDelay(gdp.Max);
    const reason = humanizeReason(gdp.Reason);
    programs.push({
      type:     'ground_delay',
      severity: 'crit',
      headline: `Ground Delay Program — avg ${avg} delay`,
      detail:   `Flights to ${iata} experiencing average ${avg} delay (max ${max}). Cause: ${reason}.${gdp.Trend ? ' Trend: ' + gdp.Trend + '.' : ''}`,
      trend:    gdp.Trend,
    });
  }

  // ── 2. Ground Stops ─────────────────────────────────────
  // All inbound flights held on the ground until stop lifts.
  for (const gs of toArray(info.GroundStops)) {
    if (gs.ARPT?.toUpperCase() !== iata) continue;
    const reason  = humanizeReason(gs.Reason);
    const endPart = gs.EndTime ? ` until ${gs.EndTime}` : '';
    programs.push({
      type:     'ground_stop',
      severity: 'crit',
      headline: `Ground Stop${endPart}`,
      detail:   `All inbound flights to ${iata} held on ground${endPart}. Cause: ${reason}. Expect extended delays.`,
    });
  }

  // ── 3. Arrival / Departure Delay Advisories ──────────────
  // Less severe than a GDP — delays exist but no formal holding program.
  for (const di of toArray(info.ArrivalDepartureDelayInformation)) {
    if (di.ARPT?.toUpperCase() !== iata) continue;
    const dir    = di.Arrival_Departure ?? 'Arrival/Departure';
    const reason = humanizeReason(di.Reason);
    const min    = humanizeDelay(di.Min);
    const max    = humanizeDelay(di.Max);
    const type   = dir.toLowerCase().includes('depart')
      ? 'departure_delay' as const
      : 'arrival_delay'   as const;
    programs.push({
      type,
      severity: 'warn',
      headline: `${dir} Delays — ${min} to ${max}`,
      detail:   `${dir} delays of ${min}–${max} at ${iata}. Cause: ${reason}.${di.Trend ? ' Trend: ' + di.Trend + '.' : ''}`,
      trend:    di.Trend,
    });
  }

  // ── 4. Closures ─────────────────────────────────────────
  for (const cl of toArray(info.Closures)) {
    if (cl.ARPT?.toUpperCase() !== iata) continue;
    const reason  = humanizeReason(cl.Reason);
    const endPart = cl.EndTime ? ` until ${cl.EndTime}` : '';
    programs.push({
      type:     'closure',
      severity: 'crit',
      headline: `Airport Closed${endPart}`,
      detail:   `${iata} is closed${endPart}. Cause: ${reason}.`,
    });
  }

  // ── 5. Airspace Flow Programs ────────────────────────────
  // En-route restrictions — may affect flights passing through
  // the same airspace even if the airport itself is clear.
  for (const afp of toArray(info.AirspaceFlowPrograms)) {
    const reason = humanizeReason(afp.Reason);
    // AFP names often contain the affected ARTCC (e.g. "ZAU_MINOR")
    // Surface these as lower-severity advisories
    programs.push({
      type:     'airspace_flow',
      severity: 'warn',
      headline: `Airspace Flow Program — ${afp.Name}`,
      detail:   `En-route flow restrictions may affect flights through this region. Cause: ${reason}.${afp.AffectedFlows ? ' Affected: ' + afp.AffectedFlows + '.' : ''}`,
    });
  }

  const result: FaaStatusData = {
    iata,
    programs,
    hasActivePrograms: programs.length > 0,
    updateTime:        info.UpdateTime ?? new Date().toISOString(),
    fetchedAt:         new Date().toISOString(),
    source:            'nasstatus',
  };

  try {
    await redis.setex(cacheKey, 120, result);   // 2-minute cache
  } catch { /* non-fatal */ }

  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json(result);
}
