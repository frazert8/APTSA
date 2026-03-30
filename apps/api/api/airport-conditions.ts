// ============================================================
// APTSA -- Airport Conditions Intelligence
//
// GET /api/airport-conditions?airportIata=ATL
//
// Single endpoint combining two free, no-key data sources:
//
//   1. aviationweather.gov (NOAA/NWS)
//      Current METAR → flight category, visibility, ceiling,
//      wind, phenomena, delay risk. Same data pilots use.
//      TAF → near-term 6-hour forecast.
//
//   2. FAA NASStatus (nasstatus.faa.gov)
//      Active ATC ground programs → Ground Delay Programs,
//      Ground Stops, arrival/departure advisories, closures.
//      Same ATC mandate data that powers Flighty's "Airport
//      Intelligence" delay explanations.
//
// Both sources fetched in parallel server-side → single
// roundtrip for the frontend.
//
// Cache: weather 3 min, FAA status 2 min (independent TTLs
//        managed via separate Redis keys so each can refresh
//        at its own rate).
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { redis } from '../src/lib/redis.js';

// ── IATA → ICAO (all 35 APTSA airports are US K-prefix) ──────
const IATA_TO_ICAO: Record<string, string> = {
  ATL: 'KATL', BOS: 'KBOS', CLT: 'KCLT', ORD: 'KORD', DFW: 'KDFW',
  DEN: 'KDEN', LAS: 'KLAS', LAX: 'KLAX', MIA: 'KMIA', MSP: 'KMSP',
  JFK: 'KJFK', MCO: 'KMCO', PHX: 'KPHX', SFO: 'KSFO', SEA: 'KSEA',
  AUS: 'KAUS', BWI: 'KBWI', BNA: 'KBNA', DCA: 'KDCA', DTW: 'KDTW',
  EWR: 'KEWR', FLL: 'KFLL', HOU: 'KHOU', IAD: 'KIAD', IAH: 'KIAH',
  LGA: 'KLGA', MCI: 'KMCI', MDW: 'KMDW', PDX: 'KPDX', PHL: 'KPHL',
  RDU: 'KRDU', SAN: 'KSAN', SJC: 'KSJC', SLC: 'KSLC', TPA: 'KTPA',
};

// ════════════════════════════════════════════════════════════════
// WEATHER — aviationweather.gov
// ════════════════════════════════════════════════════════════════

interface MetarJson {
  icaoId:   string;
  obsTime:  number;
  temp:     number | null;
  dewp:     number | null;
  wdir:     number | 'VRB' | null;
  wspd:     number | null;
  wgst:     number | null;
  visib:    string | number | null;
  wxString: string | null;
  cover:    string | null;
  cldBas1:  number | null;
  cover2:   string | null;
  cldBas2:  number | null;
  cover3:   string | null;
  cldBas3:  number | null;
  rawOb:    string;
  fltcat:   'VFR' | 'MVFR' | 'IFR' | 'LIFR' | null;
  metar_type: string;
}

interface TafCloudLayer { cover: string; base: number; }
interface TafForecast {
  timeFrom: number; timeTo: number;
  wspd?: number | null; wgst?: number | null; wdir?: number | null;
  visib: string | number | null;
  wxString: string | null;
  clds: TafCloudLayer[] | null;
}
interface TafJson {
  fcsts: TafForecast[];
}

interface Phenomenon { label: string; severity: 'info' | 'warn' | 'crit'; }

const PHENOMENA: Array<{ code: string } & Phenomenon> = [
  { code: 'FC',   label: 'Funnel Cloud',     severity: 'crit' },
  { code: 'DS',   label: 'Dust Storm',       severity: 'crit' },
  { code: 'TSGR', label: 'Hail + Thunder',   severity: 'crit' },
  { code: 'TS',   label: 'Thunderstorm',     severity: 'crit' },
  { code: 'FZRA', label: 'Freezing Rain',    severity: 'crit' },
  { code: 'FZDZ', label: 'Freezing Drizzle', severity: 'crit' },
  { code: 'FZFG', label: 'Freezing Fog',     severity: 'crit' },
  { code: 'BLSN', label: 'Blowing Snow',     severity: 'crit' },
  { code: 'GR',   label: 'Hail',             severity: 'crit' },
  { code: 'SQ',   label: 'Squalls',          severity: 'crit' },
  { code: '+SN',  label: 'Heavy Snow',       severity: 'crit' },
  { code: '+RA',  label: 'Heavy Rain',       severity: 'warn' },
  { code: 'PL',   label: 'Ice Pellets',      severity: 'warn' },
  { code: 'SN',   label: 'Snow',             severity: 'warn' },
  { code: 'FG',   label: 'Dense Fog',        severity: 'warn' },
  { code: 'SA',   label: 'Blowing Sand',     severity: 'warn' },
  { code: 'BR',   label: 'Mist',             severity: 'info' },
  { code: 'HZ',   label: 'Haze',             severity: 'info' },
  { code: 'RA',   label: 'Rain',             severity: 'info' },
  { code: 'DZ',   label: 'Drizzle',          severity: 'info' },
];

function parseVisib(v: string | number | null): number {
  if (v == null) return 10;
  if (typeof v === 'number') return v;
  if (v === '10+') return 10;
  if (v.includes('/')) {
    let total = 0;
    for (const p of v.trim().split(/\s+/)) {
      if (p.includes('/')) {
        const pts = p.split('/');
        const n = Number(pts[0]); const d = Number(pts[1]);
        total += (d ? n / d : 0);
      } else { total += parseFloat(p) || 0; }
    }
    return total;
  }
  return parseFloat(v) || 10;
}

function lowestCeiling(m: MetarJson): number | null {
  for (const [cover, base] of [
    [m.cover, m.cldBas1] as const,
    [m.cover2, m.cldBas2] as const,
    [m.cover3, m.cldBas3] as const,
  ]) {
    if (cover && ['BKN','OVC','VV'].includes(cover) && base != null) return base * 100;
  }
  return null;
}

function windCardinal(deg: number | 'VRB' | null): string {
  if (deg === 'VRB') return 'Variable';
  if (deg == null)   return 'Calm';
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round((deg as number) / 22.5) % 16] ?? 'N';
}

function parsePhenomena(wx: string | null): Phenomenon[] {
  if (!wx) return [];
  for (const p of PHENOMENA) {
    if (wx.includes(p.code)) return [{ label: p.label, severity: p.severity }];
  }
  return [];
}

function delayRisk(m: MetarJson): { risk: 'low' | 'medium' | 'high'; factors: string[] } {
  const factors: string[] = [];
  let lvl = 0;
  const bump = (n: number) => { if (n > lvl) lvl = n; };
  const wx   = m.wxString ?? '';
  const wspd = m.wspd ?? 0;
  const wgst = m.wgst ?? 0;

  if      (m.fltcat === 'LIFR') { bump(2); factors.push('LIFR — ceiling < 500 ft or vis < 1 SM'); }
  else if (m.fltcat === 'IFR')  { bump(2); factors.push('IFR — low ceilings or reduced visibility'); }
  else if (m.fltcat === 'MVFR') { bump(1); factors.push('Marginal VFR conditions'); }

  if (wx.includes('TS'))  { bump(2); factors.push('Active thunderstorm'); }
  if (wx.includes('FZ'))  { bump(2); factors.push('Freezing precip — de-icing required'); }
  if (wx.includes('+SN')) { bump(2); factors.push('Heavy snow'); }
  else if (wx.includes('SN')) { bump(1); factors.push('Snow'); }

  const maxW = Math.max(wspd, wgst);
  if      (maxW >= 35) { bump(2); factors.push(`High winds ${wspd}${wgst ? 'G' + wgst : ''} kts`); }
  else if (maxW >= 25) { bump(1); factors.push(`Strong winds ${wspd}${wgst ? 'G' + wgst : ''} kts`); }

  return { risk: lvl >= 2 ? 'high' : lvl === 1 ? 'medium' : 'low', factors };
}

export interface ForecastPeriod {
  from: string; to: string;
  visib: number; ceiling: number | null;
  phenomena: string[];
  windSpd: number; windGust: number | null;
}

export interface WeatherData {
  iata: string; icao: string; obsTime: string; isSpeci: boolean;
  flightCat: 'VFR' | 'MVFR' | 'IFR' | 'LIFR';
  visibility: number; ceiling: number | null;
  windDir: string; windSpd: number; windGust: number | null;
  tempF: string; dewpointF: string;
  phenomena: Phenomenon[];
  delayRisk: { risk: 'low' | 'medium' | 'high'; factors: string[] };
  rawMetar: string;
  forecast: ForecastPeriod[];
}

async function fetchWeather(icao: string, iata: string): Promise<WeatherData | null> {
  const metarUrl = `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json&taf=false&hours=2`;
  const tafUrl   = `https://aviationweather.gov/api/data/taf?ids=${icao}&format=json&metar=false`;
  const ua = { 'User-Agent': 'APTSA/1.0 (+https://aptsa.vercel.app)' };

  const [mr, tr] = await Promise.allSettled([
    fetch(metarUrl, { headers: ua, signal: AbortSignal.timeout(7_000) }),
    fetch(tafUrl,   { headers: ua, signal: AbortSignal.timeout(5_000) }),
  ]);

  const metars: MetarJson[] = mr.status === 'fulfilled' && mr.value.ok
    ? (await mr.value.json()) as MetarJson[] : [];
  if (!metars.length) return null;

  const m = metars[0]!;

  // Parse TAF forecasts (next 6 hours)
  const forecast: ForecastPeriod[] = [];
  if (tr.status === 'fulfilled' && tr.value.ok) {
    try {
      const tafs = (await tr.value.json()) as TafJson[];
      if (tafs.length) {
        const now = Date.now() / 1000;
        const end = now + 6 * 3600;
        for (const f of (tafs[0]!.fcsts ?? []).slice(0, 5)) {
          if (f.timeTo <= now || f.timeFrom >= end) continue;
          const ceil = (f.clds ?? []).find(c => ['BKN','OVC','VV'].includes(c.cover));
          forecast.push({
            from: new Date(f.timeFrom * 1000).toISOString(),
            to:   new Date(f.timeTo   * 1000).toISOString(),
            visib: parseVisib(f.visib),
            ceiling: ceil ? ceil.base * 100 : null,
            phenomena: f.wxString ? [f.wxString] : [],
            windSpd:  f.wspd ?? 0,
            windGust: f.wgst ?? null,
          });
        }
      }
    } catch { /* TAF parse failure is non-fatal */ }
  }

  const cToF = (c: number | null) => c == null ? '—' : Math.round(c * 9 / 5 + 32) + '°F';

  return {
    iata, icao,
    obsTime:    new Date(m.obsTime * 1000).toISOString(),
    isSpeci:    m.metar_type === 'SPECI',
    flightCat:  m.fltcat ?? 'VFR',
    visibility: parseVisib(m.visib),
    ceiling:    lowestCeiling(m),
    windDir:    windCardinal(m.wdir),
    windSpd:    m.wspd  ?? 0,
    windGust:   m.wgst  ?? null,
    tempF:      cToF(m.temp),
    dewpointF:  cToF(m.dewp),
    phenomena:  parsePhenomena(m.wxString),
    delayRisk:  delayRisk(m),
    rawMetar:   m.rawOb,
    forecast,
  };
}

// ════════════════════════════════════════════════════════════════
// FAA NAS STATUS — nasstatus.faa.gov
// ════════════════════════════════════════════════════════════════

interface NasGdp   { ARPT: string; Reason: string; Avg: string; Max: string; Trend?: string; }
interface NasGs    { ARPT: string; Reason: string; EndTime?: string; Type?: string; }
interface NasDi    { ARPT: string; Reason: string; Arrival_Departure?: string; Min?: string; Max?: string; Trend?: string; }
interface NasCl    { ARPT: string; Reason: string; BeginTime?: string; EndTime?: string; }
interface NasAfp   { Name: string; Reason: string; AffectedFlows?: string; }
interface NasEnvelope {
  AirportStatusInformation: {
    UpdateTime: string;
    GroundDelayPrograms?:             NasGdp | NasGdp[];
    GroundStops?:                     NasGs  | NasGs[];
    ArrivalDepartureDelayInformation?: NasDi | NasDi[];
    Closures?:                        NasCl  | NasCl[];
    AirspaceFlowPrograms?:            NasAfp | NasAfp[];
  };
}

export interface FaaProgram {
  type:     'ground_delay' | 'ground_stop' | 'arrival_delay' | 'departure_delay' | 'closure' | 'airspace_flow';
  severity: 'warn' | 'crit';
  headline: string;
  detail:   string;
  trend?:   string | undefined;
}

export interface FaaStatusData {
  programs: FaaProgram[];
  hasActivePrograms: boolean;
  updateTime: string;
}

function arr<T>(v: T | T[] | undefined): T[] {
  return !v ? [] : Array.isArray(v) ? v : [v];
}

function hrReason(raw: string): string {
  return raw.replace(/^WEATHER\s*\/\s*/i, '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).trim();
}

function hrDelay(s: string | undefined): string {
  if (!s) return '';
  if (s.includes(':')) {
    const pts = s.split(':');
    const h = Number(pts[0]); const m = Number(pts[1]);
    if (!h || isNaN(h)) return `${isNaN(m) ? 0 : m} min`;
    if (!m || isNaN(m)) return `${h}h`;
    return `${h}h ${m}m`;
  }
  const mins = parseInt(s, 10);
  if (isNaN(mins)) return s;
  if (mins < 60) return `${mins} min`;
  const hh = Math.floor(mins / 60); const mm = mins % 60;
  return mm ? `${hh}h ${mm}m` : `${hh}h`;
}

async function fetchFaaStatus(iata: string): Promise<FaaStatusData> {
  const empty: FaaStatusData = { programs: [], hasActivePrograms: false, updateTime: new Date().toISOString() };
  try {
    const resp = await fetch('https://nasstatus.faa.gov/api/airport-status-information', {
      headers: { 'Accept': 'application/json', 'User-Agent': 'APTSA/1.0 (+https://aptsa.vercel.app)' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return empty;
    const env = (await resp.json()) as NasEnvelope;
    const info = env.AirportStatusInformation;
    const programs: FaaProgram[] = [];

    for (const g of arr(info.GroundDelayPrograms)) {
      if (g.ARPT?.toUpperCase() !== iata) continue;
      const avg = hrDelay(g.Avg); const max = hrDelay(g.Max);
      programs.push({ type: 'ground_delay', severity: 'crit',
        headline: `Ground Delay Program — avg ${avg}`,
        detail:   `Delays avg ${avg}, max ${max}. Cause: ${hrReason(g.Reason)}.${g.Trend ? ' Trend: ' + g.Trend + '.' : ''}`,
        trend:    g.Trend });
    }

    for (const g of arr(info.GroundStops)) {
      if (g.ARPT?.toUpperCase() !== iata) continue;
      const ep = g.EndTime ? ` until ${g.EndTime}` : '';
      programs.push({ type: 'ground_stop', severity: 'crit',
        headline: `Ground Stop${ep}`,
        detail:   `All inbound flights held on ground${ep}. Cause: ${hrReason(g.Reason)}.` });
    }

    for (const d of arr(info.ArrivalDepartureDelayInformation)) {
      if (d.ARPT?.toUpperCase() !== iata) continue;
      const dir  = d.Arrival_Departure ?? 'Arrival/Departure';
      const min  = hrDelay(d.Min); const max = hrDelay(d.Max);
      const type = dir.toLowerCase().includes('depart') ? 'departure_delay' as const : 'arrival_delay' as const;
      programs.push({ type, severity: 'warn',
        headline: `${dir} Delays — ${min} to ${max}`,
        detail:   `${dir} delays of ${min}–${max}. Cause: ${hrReason(d.Reason)}.${d.Trend ? ' Trend: ' + d.Trend + '.' : ''}`,
        trend:    d.Trend });
    }

    for (const c of arr(info.Closures)) {
      if (c.ARPT?.toUpperCase() !== iata) continue;
      const ep = c.EndTime ? ` until ${c.EndTime}` : '';
      programs.push({ type: 'closure', severity: 'crit',
        headline: `Airport Closed${ep}`,
        detail:   `${iata} closed${ep}. Cause: ${hrReason(c.Reason)}.` });
    }

    for (const a of arr(info.AirspaceFlowPrograms)) {
      programs.push({ type: 'airspace_flow', severity: 'warn',
        headline: `Airspace Flow Program — ${a.Name}`,
        detail:   `En-route restrictions may affect flights. Cause: ${hrReason(a.Reason)}.` });
    }

    return { programs, hasActivePrograms: programs.length > 0, updateTime: info.UpdateTime ?? new Date().toISOString() };
  } catch {
    return empty;
  }
}

// ════════════════════════════════════════════════════════════════
// COMBINED RESPONSE
// ════════════════════════════════════════════════════════════════

export interface AirportConditions {
  iata:       string;
  weather:    WeatherData | null;
  faaStatus:  FaaStatusData;
  fetchedAt:  string;
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

  // ── Independent cache keys so each data source refreshes at its own rate
  const wKey = `cond:wx:v1:${iata}`;
  const fKey = `cond:faa:v1:${iata}`;

  // Try cache for both sources in parallel
  const [cachedWx, cachedFaa] = await Promise.all([
    redis.get<WeatherData>(wKey).catch(() => null),
    redis.get<FaaStatusData>(fKey).catch(() => null),
  ]);

  // If both cached, return immediately
  if (cachedWx && cachedFaa) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json({
      iata, weather: cachedWx, faaStatus: cachedFaa, fetchedAt: new Date().toISOString(),
    } satisfies AirportConditions);
  }

  // Fetch whichever is missing in parallel
  const [weather, faaStatus] = await Promise.all([
    cachedWx ? Promise.resolve(cachedWx) : fetchWeather(icao, iata),
    cachedFaa ? Promise.resolve(cachedFaa) : fetchFaaStatus(iata),
  ]);

  // Cache results independently (weather 3 min, FAA 2 min)
  await Promise.all([
    weather   && !cachedWx  ? redis.setex(wKey, 180, weather).catch(() => {})   : Promise.resolve(),
    !cachedFaa               ? redis.setex(fKey, 120, faaStatus).catch(() => {}) : Promise.resolve(),
  ]);

  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json({
    iata, weather, faaStatus, fetchedAt: new Date().toISOString(),
  } satisfies AirportConditions);
}
