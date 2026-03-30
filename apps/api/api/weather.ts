// ============================================================
// APTSA -- Aviation Weather Intelligence
//
// GET /api/weather?airportIata=ATL
//
// Source: aviationweather.gov (NOAA/NWS) — free, no API key,
// authoritative US aviation weather. Same data stream used by
// pilots, airline ops centers, and dispatch.
//
// Returns:
//   - Current METAR decoded into structured fields
//   - Flight category (VFR / MVFR / IFR / LIFR)
//   - Delay risk assessment with plain-English factors
//   - Near-term TAF forecast periods (next 6 hours)
//
// Cache: 3-minute TTL (METARs updated every 20–30 minutes;
//         special reports / SPECIs issued within minutes of changes)
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { redis } from '../src/lib/redis.js';

// IATA → ICAO station identifier (all 35 APTSA airports are US K-prefix)
const IATA_TO_ICAO: Record<string, string> = {
  ATL: 'KATL', BOS: 'KBOS', CLT: 'KCLT', ORD: 'KORD', DFW: 'KDFW',
  DEN: 'KDEN', LAS: 'KLAS', LAX: 'KLAX', MIA: 'KMIA', MSP: 'KMSP',
  JFK: 'KJFK', MCO: 'KMCO', PHX: 'KPHX', SFO: 'KSFO', SEA: 'KSEA',
  AUS: 'KAUS', BWI: 'KBWI', BNA: 'KBNA', DCA: 'KDCA', DTW: 'KDTW',
  EWR: 'KEWR', FLL: 'KFLL', HOU: 'KHOU', IAD: 'KIAD', IAH: 'KIAH',
  LGA: 'KLGA', MCI: 'KMCI', MDW: 'KMDW', PDX: 'KPDX', PHL: 'KPHL',
  RDU: 'KRDU', SAN: 'KSAN', SJC: 'KSJC', SLC: 'KSLC', TPA: 'KTPA',
};

// ── aviationweather.gov METAR JSON schema (relevant fields) ──

interface MetarJson {
  icaoId:   string;
  obsTime:  number;             // Unix timestamp
  temp:     number | null;
  dewp:     number | null;
  wdir:     number | 'VRB' | null;
  wspd:     number | null;
  wgst:     number | null;
  visib:    string | number | null; // "10+", "1/2", numeric SM
  wxString: string | null;          // "TSRA", "-SN BR", etc.
  cover:    string | null;          // "CLR", "FEW", "SCT", "BKN", "OVC"
  cldBas1:  number | null;          // hundreds of feet AGL
  cover2:   string | null;
  cldBas2:  number | null;
  cover3:   string | null;
  cldBas3:  number | null;
  rawOb:    string;
  fltcat:   'VFR' | 'MVFR' | 'IFR' | 'LIFR' | null;
  metar_type: string;               // "METAR" or "SPECI"
}

// ── TAF JSON schema (relevant fields) ────────────────────────

interface TafCloudLayer {
  cover: string;  // SKC, FEW, SCT, BKN, OVC
  base:  number;  // hundreds of feet
}

interface TafForecast {
  timeFrom:  number;  // Unix timestamp
  timeTo:    number;  // Unix timestamp
  wdir?:     number | null;
  wspd?:     number | null;
  wgst?:     number | null;
  visib:     string | number | null;
  wxString:  string | null;
  clds:      TafCloudLayer[] | null;
}

interface TafJson {
  icaoId:        string;
  issueTime:     number;
  validTimeFrom: number;
  validTimeTo:   number;
  fcsts:         TafForecast[];
}

// ── Weather phenomena → human label + delay severity ─────────

interface Phenomenon { label: string; severity: 'info' | 'warn' | 'crit' }

const PHENOMENA_MAP: Array<{ code: string } & Phenomenon> = [
  { code: 'FC',   label: 'Funnel Cloud',      severity: 'crit' },
  { code: 'DS',   label: 'Dust Storm',        severity: 'crit' },
  { code: 'SS',   label: 'Sandstorm',         severity: 'crit' },
  { code: 'TSGR', label: 'Hail + Thunder',    severity: 'crit' },
  { code: 'TS',   label: 'Thunderstorm',      severity: 'crit' },
  { code: 'FZRA', label: 'Freezing Rain',     severity: 'crit' },
  { code: 'FZDZ', label: 'Freezing Drizzle',  severity: 'crit' },
  { code: 'FZFG', label: 'Freezing Fog',      severity: 'crit' },
  { code: 'BLSN', label: 'Blowing Snow',      severity: 'crit' },
  { code: 'GR',   label: 'Hail',              severity: 'crit' },
  { code: 'SQ',   label: 'Squalls',           severity: 'crit' },
  { code: '+SN',  label: 'Heavy Snow',        severity: 'crit' },
  { code: '+RA',  label: 'Heavy Rain',        severity: 'warn' },
  { code: 'GS',   label: 'Small Hail',        severity: 'warn' },
  { code: 'PL',   label: 'Ice Pellets',       severity: 'warn' },
  { code: 'SN',   label: 'Snow',              severity: 'warn' },
  { code: 'FG',   label: 'Dense Fog',         severity: 'warn' },
  { code: 'SA',   label: 'Blowing Sand',      severity: 'warn' },
  { code: 'DU',   label: 'Blowing Dust',      severity: 'warn' },
  { code: 'BCFG', label: 'Patchy Fog',        severity: 'info' },
  { code: 'MIFG', label: 'Shallow Fog',       severity: 'info' },
  { code: 'BR',   label: 'Mist',              severity: 'info' },
  { code: 'HZ',   label: 'Haze',              severity: 'info' },
  { code: 'RA',   label: 'Rain',              severity: 'info' },
  { code: 'DZ',   label: 'Drizzle',           severity: 'info' },
];

// ── Utilities ─────────────────────────────────────────────────

function parseVisib(v: string | number | null): number {
  if (v == null)              return 10;
  if (typeof v === 'number')  return v;
  if (v === '10+')            return 10;
  if (v.includes('/')) {
    const parts = v.trim().split(/\s+/);  // handles "1 1/2"
    let total = 0;
    for (const p of parts) {
      if (p.includes('/')) {
        const parts2 = p.split('/');
        const n = Number(parts2[0]);
        const d = Number(parts2[1]);
        total += (d !== 0 ? n / d : 0);
      } else {
        total += parseFloat(p) || 0;
      }
    }
    return total;
  }
  return parseFloat(v) || 10;
}

function getLowestCeiling(m: MetarJson): number | null {
  const layers = [
    { cover: m.cover,  base: m.cldBas1 },
    { cover: m.cover2, base: m.cldBas2 },
    { cover: m.cover3, base: m.cldBas3 },
  ];
  for (const l of layers) {
    if (l.cover && ['BKN', 'OVC', 'VV'].includes(l.cover) && l.base != null) {
      return l.base * 100;   // hundreds-of-ft → ft AGL
    }
  }
  return null;
}

function parsePhenomena(wxString: string | null): Phenomenon[] {
  if (!wxString) return [];
  const matched: Phenomenon[] = [];
  for (const p of PHENOMENA_MAP) {
    if (wxString.includes(p.code)) {
      matched.push({ label: p.label, severity: p.severity });
      // Only report the highest-severity phenomenon to avoid noise
      if (p.severity === 'crit') break;
    }
  }
  return matched;
}

function windCardinal(deg: number | 'VRB' | null): string {
  if (deg === 'VRB') return 'Variable';
  if (deg == null)   return 'Calm';
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE',
                 'S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round((deg as number) / 22.5) % 16]!;
}

function cToF(c: number | null): string {
  if (c == null) return '—';
  return Math.round(c * 9 / 5 + 32) + '°F';
}

function assessDelayRisk(m: MetarJson): { risk: 'low' | 'medium' | 'high'; factors: string[] } {
  const factors: string[] = [];
  let level = 0;   // 0=low, 1=medium, 2=high
  const bump = (n: number) => { if (n > level) level = n; };

  const cat   = m.fltcat ?? 'VFR';
  const wspd  = m.wspd  ?? 0;
  const wgst  = m.wgst  ?? 0;
  const wx    = m.wxString ?? '';

  // Flight category
  if      (cat === 'LIFR') { bump(2); factors.push('LIFR — ceiling < 500 ft or vis < 1 SM'); }
  else if (cat === 'IFR')  { bump(2); factors.push('IFR — low ceilings or reduced visibility'); }
  else if (cat === 'MVFR') { bump(1); factors.push('Marginal VFR conditions'); }

  // Thunderstorm — always high risk, ground stops common
  if (wx.includes('TS')) { bump(2); factors.push('Active thunderstorm'); }

  // Freezing precipitation — de-icing required
  if (wx.includes('FZ')) { bump(2); factors.push('Freezing precip — de-icing required'); }

  // Snow
  if (wx.includes('+SN'))       { bump(2); factors.push('Heavy snow'); }
  else if (wx.includes('SN'))   { bump(1); factors.push('Snow'); }

  // Wind
  const maxWind = Math.max(wspd, wgst);
  if      (maxWind >= 35) { bump(2); factors.push(`High winds ${wspd}${wgst ? 'G' + wgst : ''} kts`); }
  else if (maxWind >= 25) { bump(1); factors.push(`Strong winds ${wspd}${wgst ? 'G' + wgst : ''} kts`); }

  return {
    risk:    level >= 2 ? 'high' : level === 1 ? 'medium' : 'low',
    factors,
  };
}

// ── TAF forecast (next 6 h) ───────────────────────────────────

export interface ForecastPeriod {
  from:       string;   // ISO UTC
  to:         string;   // ISO UTC
  visib:      number;   // SM
  ceiling:    number | null; // ft AGL
  phenomena:  string[];
  windSpd:    number;
  windGust:   number | null;
}

async function buildForecast(icao: string): Promise<ForecastPeriod[]> {
  try {
    const url  = `https://aviationweather.gov/api/data/taf?ids=${icao}&format=json&metar=false`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'APTSA/1.0 (+https://aptsa.vercel.app)' },
      signal:  AbortSignal.timeout(5_000),
    });
    if (!resp.ok) return [];
    const tafs = (await resp.json()) as TafJson[];
    if (!tafs.length) return [];

    const now     = Date.now() / 1000;
    const horizon = now + 6 * 3600;

    return (tafs[0]!.fcsts ?? [])
      .filter(f => f.timeTo > now && f.timeFrom < horizon)
      .slice(0, 5)
      .map((f): ForecastPeriod => {
        const ceilLayer = (f.clds ?? []).find(c => ['BKN','OVC','VV'].includes(c.cover));
        return {
          from:      new Date(f.timeFrom * 1000).toISOString(),
          to:        new Date(f.timeTo   * 1000).toISOString(),
          visib:     parseVisib(f.visib),
          ceiling:   ceilLayer ? ceilLayer.base * 100 : null,
          phenomena: f.wxString ? [f.wxString] : [],
          windSpd:   f.wspd ?? 0,
          windGust:  f.wgst ?? null,
        };
      });
  } catch {
    return [];
  }
}

// ── Public response shape ────────────────────────────────────

export interface WeatherData {
  iata:        string;
  icao:        string;
  obsTime:     string;                // ISO UTC of latest observation
  isSpeci:     boolean;               // true = special observation (rapid change)
  flightCat:   'VFR' | 'MVFR' | 'IFR' | 'LIFR';
  visibility:  number;                // statute miles
  ceiling:     number | null;         // ft AGL (null = clear above 12,000)
  windDir:     string;                // cardinal or "Variable"/"Calm"
  windSpd:     number;                // knots
  windGust:    number | null;
  tempF:       string;
  dewpointF:   string;
  phenomena:   Phenomenon[];
  delayRisk:   { risk: 'low' | 'medium' | 'high'; factors: string[] };
  rawMetar:    string;
  forecast:    ForecastPeriod[];
  source:      'aviationweather';
  fetchedAt:   string;
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
    return res.status(400).json({ error: 'airportIata required (e.g. ATL)' });
  }

  const icao = IATA_TO_ICAO[iata];
  if (!icao) {
    return res.status(400).json({ error: `Airport ${iata} not in supported list` });
  }

  // ── Cache check ───────────────────────────────────────────
  const cacheKey = `weather:v2:${iata}`;
  try {
    const cached = await redis.get<WeatherData>(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cached);
    }
  } catch { /* Redis failure is non-fatal */ }

  // ── Fetch METAR + TAF in parallel ────────────────────────
  const metarUrl = `https://aviationweather.gov/api/data/metar`
    + `?ids=${icao}&format=json&taf=false&hours=2`;

  const [metarResp, forecast] = await Promise.all([
    fetch(metarUrl, {
      headers: { 'User-Agent': 'APTSA/1.0 (+https://aptsa.vercel.app)' },
      signal:  AbortSignal.timeout(7_000),
    }),
    buildForecast(icao),
  ]);

  if (!metarResp.ok) {
    return res.status(502).json({ error: `Weather service HTTP ${metarResp.status}` });
  }

  const metars = (await metarResp.json()) as MetarJson[];
  if (!metars.length) {
    return res.status(404).json({ error: `No METAR data found for ${iata} (${icao})` });
  }

  const m = metars[0]!;   // Most recent observation

  const result: WeatherData = {
    iata,
    icao,
    obsTime:    new Date(m.obsTime * 1000).toISOString(),
    isSpeci:    m.metar_type === 'SPECI',
    flightCat:  m.fltcat ?? 'VFR',
    visibility: parseVisib(m.visib),
    ceiling:    getLowestCeiling(m),
    windDir:    windCardinal(m.wdir),
    windSpd:    m.wspd  ?? 0,
    windGust:   m.wgst  ?? null,
    tempF:      cToF(m.temp),
    dewpointF:  cToF(m.dewp),
    phenomena:  parsePhenomena(m.wxString),
    delayRisk:  assessDelayRisk(m),
    rawMetar:   m.rawOb,
    forecast,
    source:     'aviationweather',
    fetchedAt:  new Date().toISOString(),
  };

  try {
    await redis.setex(cacheKey, 180, result);   // 3-minute cache
  } catch { /* non-fatal */ }

  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json(result);
}
