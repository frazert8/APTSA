// ============================================================
// APTSA -- Live Aircraft Traffic
//
// GET /api/live-traffic?airportIata=ATL
//
// Priority chain (first live source wins — NO simulation fallback):
//   1. ADS-B Exchange   — best real-time ADS-B (ADSBX_API_KEY, paid)
//   2. airplanes.live   — free community ADS-B, no key, AWS-safe ✓
//   3. FlightAware      — airport arrivals + departures with last_position
//                         (FLIGHTAWARE_API_KEY) — works from Vercel/AWS
//   4. OpenSky Network  — free tier, authenticated preferred
//                         (blocked from some cloud IPs — last resort)
//
// Bounding box: ±1.5° ≈ 105 mi radius — covers final approach,
// departure, and nearby en-route without pulling in the whole US.
// Hard cap: 100 aircraft sorted by proximity to airport.
//
// OpenSky state vector indices:
//  [0]  icao24          [1]  callsign       [2]  origin_country
//  [3]  time_position   [4]  last_contact   [5]  longitude
//  [6]  latitude        [7]  baro_altitude  [8]  on_ground
//  [9]  velocity (m/s)  [10] true_track     [11] vertical_rate (m/s)
//  [12] sensors         [13] geo_altitude   [14] squawk
//  [15] spi             [16] position_source
//
// Env: ADSBX_API_KEY (optional), FLIGHTAWARE_API_KEY (optional),
//      OPENSKY_USER / OPENSKY_PASS (optional)
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { redis } from '../src/lib/redis.js';

// ── Airport coordinates (35 supported) ───────────────────────
const AIRPORT_COORDS: Record<string, { lat: number; lon: number }> = {
  ATL: { lat: 33.6407,  lon: -84.4277  },
  BOS: { lat: 42.3656,  lon: -71.0096  },
  CLT: { lat: 35.2271,  lon: -80.9431  },
  ORD: { lat: 41.9742,  lon: -87.9073  },
  DFW: { lat: 32.8998,  lon: -97.0403  },
  DEN: { lat: 39.8561,  lon: -104.6737 },
  LAS: { lat: 36.0840,  lon: -115.1537 },
  LAX: { lat: 33.9425,  lon: -118.4081 },
  MIA: { lat: 25.7959,  lon: -80.2870  },
  MSP: { lat: 44.8848,  lon: -93.2223  },
  JFK: { lat: 40.6413,  lon: -73.7781  },
  MCO: { lat: 28.4312,  lon: -81.3081  },
  PHX: { lat: 33.4373,  lon: -112.0078 },
  SFO: { lat: 37.6213,  lon: -122.3790 },
  SEA: { lat: 47.4502,  lon: -122.3088 },
  AUS: { lat: 30.1945,  lon: -97.6699  },
  BWI: { lat: 39.1774,  lon: -76.6684  },
  BNA: { lat: 36.1263,  lon: -86.6774  },
  DCA: { lat: 38.8512,  lon: -77.0402  },
  DTW: { lat: 42.2162,  lon: -83.3554  },
  EWR: { lat: 40.6895,  lon: -74.1745  },
  FLL: { lat: 26.0726,  lon: -80.1527  },
  HOU: { lat: 29.6454,  lon: -95.2789  },
  IAD: { lat: 38.9531,  lon: -77.4565  },
  IAH: { lat: 29.9902,  lon: -95.3368  },
  LGA: { lat: 40.7769,  lon: -73.8740  },
  MCI: { lat: 39.2976,  lon: -94.7130  },
  MDW: { lat: 41.7868,  lon: -87.7522  },
  PDX: { lat: 45.5898,  lon: -122.5951 },
  PHL: { lat: 39.8744,  lon: -75.2424  },
  RDU: { lat: 35.8801,  lon: -78.7880  },
  SAN: { lat: 32.7338,  lon: -117.1933 },
  SJC: { lat: 37.3626,  lon: -121.9290 },
  SLC: { lat: 40.7899,  lon: -111.9791 },
  TPA: { lat: 27.9755,  lon: -82.5332  },
};

// ── ICAO telephony designator → canonical airline ICAO code ──
// Resolves IATA-style 2-letter callsign prefixes (e.g. "WN" for
// some Southwest flights) and normalises known aliases so every
// aircraft maps to the same key used in the frontend AIRLINE_INFO.
const CALLSIGN_PREFIX_MAP: Record<string, string> = {
  // ── US Majors ──────────────────────────────────────────────
  AAL: 'AAL',  // American Airlines
  UAL: 'UAL',  // United Airlines
  DAL: 'DAL',  // Delta Air Lines
  SWA: 'SWA',  // Southwest Airlines (ICAO)
  WN:  'SWA',  // Southwest IATA alias — occasional OpenSky occurrence
  JBU: 'JBU',  // JetBlue Airways
  ASA: 'ASA',  // Alaska Airlines
  NKS: 'NKS',  // Spirit Airlines
  NK:  'NKS',  // Spirit IATA alias
  FFT: 'FFT',  // Frontier Airlines
  F9:  'FFT',  // Frontier IATA alias
  AAY: 'AAY',  // Allegiant Air
  G4:  'AAY',  // Allegiant IATA alias
  SCX: 'SCX',  // Sun Country Airlines
  SY:  'SCX',  // Sun Country IATA alias
  BZE: 'BZE',  // Breeze Airways
  VXP: 'VXP',  // Avelo Airlines
  HAL: 'HAL',  // Hawaiian Airlines
  HA:  'HAL',  // Hawaiian IATA alias
  // ── US Regionals ──────────────────────────────────────────
  SKW: 'SKW',  // SkyWest Airlines
  ENY: 'ENY',  // Envoy Air (American Eagle)
  RPA: 'RPA',  // Republic Airways
  PDT: 'PDT',  // Horizon Air (Alaska)
  ASH: 'ASH',  // Mesa Air
  SIL: 'SIL',  // Silver Airways
  CPZ: 'CPZ',  // Compass Airlines
  // ── US Cargo ──────────────────────────────────────────────
  FDX: 'FDX',  // FedEx Express
  UPS: 'UPS',  // UPS Airlines
  GTI: 'GTI',  // Atlas Air
  ABX: 'ABX',  // ABX Air (DHL)
  PAC: 'PAC',  // Polar Air Cargo
  KFS: 'KFS',  // Kalitta Air
  // ── Canada ────────────────────────────────────────────────
  ACA: 'ACA',  // Air Canada
  WJA: 'WJA',  // WestJet
  // ── Europe ────────────────────────────────────────────────
  BAW: 'BAW',  // British Airways
  DLH: 'DLH',  // Lufthansa
  AFR: 'AFR',  // Air France
  KLM: 'KLM',  // KLM Royal Dutch Airlines
  IBE: 'IBE',  // Iberia
  EIN: 'EIN',  // Aer Lingus
  VIR: 'VIR',  // Virgin Atlantic
  EZY: 'EZY',  // easyJet
  RYR: 'RYR',  // Ryanair
  SAS: 'SAS',  // Scandinavian Airlines
  AZA: 'AZA',  // Alitalia / ITA Airways
  TAP: 'TAP',  // TAP Air Portugal
  // ── Middle East ───────────────────────────────────────────
  UAE: 'UAE',  // Emirates
  ETD: 'ETD',  // Etihad Airways
  QTR: 'QTR',  // Qatar Airways
  // ── Asia-Pacific ──────────────────────────────────────────
  QFA: 'QFA',  // Qantas
  SIA: 'SIA',  // Singapore Airlines
  JAL: 'JAL',  // Japan Airlines
  ANA: 'ANA',  // All Nippon Airways
  CPA: 'CPA',  // Cathay Pacific
  KAL: 'KAL',  // Korean Air
  AAR: 'AAR',  // Asiana Airlines
  MAS: 'MAS',  // Malaysia Airlines
  THA: 'THA',  // Thai Airways
  // ── Latin America ────────────────────────────────────────
  AMX: 'AMX',  // Aeromexico
  TAM: 'TAM',  // LATAM Airlines (Brazil)
  LAN: 'LAN',  // LATAM Airlines (Chile/Peru)
  GLO: 'GLO',  // Gol Airlines
  VOI: 'VOI',  // Volaris
  VIV: 'VIV',  // VivaAerobus
  CMP: 'CMP',  // Copa Airlines
  CM:  'CMP',  // Copa IATA alias
  AVA: 'AVA',  // Avianca
  AV:  'AVA',  // Avianca IATA alias
  CBV: 'CBV',  // Cubana de Aviacion
  // ── Caribbean ─────────────────────────────────────────────
  BHS: 'BHS',  // Bahamas Air
  CAY: 'CAY',  // Cayman Airways
  BWA: 'BWA',  // Caribbean Airlines
};

export interface Aircraft {
  icao24:    string;
  callsign:  string;
  lat:       number;
  lon:       number;
  altFt:     number;
  speedKts:  number;
  heading:   number;
  vertRate:  number;   // m/s — positive = climbing, negative = descending
  onGround:  boolean;
  airline:   string;   // resolved ICAO code (from CALLSIGN_PREFIX_MAP)
  squawk:    string;   // transponder squawk code
}

export interface LiveTrafficData {
  iata:      string;
  aircraft:  Aircraft[];
  fetchedAt: string;
  count:     number;
  source:    'opensky' | 'flightaware' | 'adsbexchange' | 'error';
}

// ── Callsign → normalised ICAO airline code ───────────────────
// Handles standard 3-letter ICAO designators AND the less-common
// 2-letter IATA style that occasionally appears in OpenSky data.
function resolveAirline(callsign: string): string {
  if (!callsign) return '';

  // Try 3-letter prefix first (standard ICAO telephony designator)
  const three = callsign.slice(0, 3).toUpperCase();
  if (/^[A-Z]{3}$/.test(three) && CALLSIGN_PREFIX_MAP[three]) {
    return CALLSIGN_PREFIX_MAP[three]!;
  }

  // Try 2-letter IATA prefix fallback (WN, NK, F9, G4, etc.)
  const two = callsign.slice(0, 2).toUpperCase();
  if (/^[A-Z]{2}$/.test(two) && CALLSIGN_PREFIX_MAP[two]) {
    return CALLSIGN_PREFIX_MAP[two]!;
  }

  // Unknown — return the raw 3-letter prefix so the frontend can
  // still display the code even if it's not in AIRLINE_INFO.
  if (/^[A-Z]{3}\d/.test(callsign)) return three;
  return '';
}

function parseState(s: unknown[], now: number): Aircraft | null {
  if (!Array.isArray(s)) return null;
  const lon = s[5] as number | null;
  const lat = s[6] as number | null;
  if (lon == null || lat == null) return null;

  // [3] time_position: Unix timestamp of last position fix.
  // [4] last_contact:  Unix timestamp of last any-message contact.
  // Drop vectors whose last position fix is stale (> 2 min old) — these
  // are dead entries OpenSky hasn't pruned yet.
  const timePosRaw   = s[3] as number | null;
  const lastContact  = s[4] as number | null;
  const freshEnough  = timePosRaw != null && (now / 1000 - timePosRaw) < 120;
  const contactFresh = lastContact != null && (now / 1000 - lastContact) < 120;
  if (!freshEnough && !contactFresh) return null;

  const icao24    = String(s[0] ?? '').toLowerCase();
  const callsign  = String(s[1] ?? '').trim().toUpperCase();
  const altM      = (s[7] as number | null) ?? (s[13] as number | null) ?? 0;
  const onGround  = Boolean(s[8]);
  const velMs     = (s[9]  as number | null) ?? 0;
  const track     = (s[10] as number | null) ?? 0;
  const vertRateMs = (s[11] as number | null) ?? 0;
  const squawk    = String(s[14] ?? '');

  // Skip state vectors with no position fix or implausible coordinates
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  // ── Commercial-only filter ────────────────────────────────────
  // Commercial flights always have a structured ICAO callsign:
  //   3-letter airline designator (e.g. AAL, UAL, SWA) + flight number digits.
  // Private jets → registration numbers (N12345, C-FABC, G-ABCD)
  // General aviation → short mixed strings or no callsign
  // Military → non-standard codes (RCH, REACH, etc. but no scheduled service)
  //
  // Rules:
  //  1. Must have a callsign (blank = squitter-only transponder, GA or drone)
  //  2. Must match the ICAO commercial pattern: 3 uppercase letters + digit
  //     OR be resolvable to a known airline via the 2-letter IATA alias map
  //  3. Drop callsigns that are pure registration numbers (contain a hyphen
  //     or start with a country prefix followed by digits: N/C/G/D/VH/etc.)
  if (!callsign) return null;

  const airline = resolveAirline(callsign);
  const isIcaoCommercial  = /^[A-Z]{3}\d/.test(callsign);   // standard ICAO: AAL699
  const isIataAlias       = airline !== '';                   // resolved 2-letter alias: WN→SWA
  const isRegistration    = /^[A-Z]-|^[A-Z]{1,2}\d|^N\d|^VH|^C-|^G-|^D-|^OE-|^PH-/.test(callsign);

  if ((!isIcaoCommercial && !isIataAlias) || isRegistration) return null;

  const altFt    = Math.round(altM * 3.28084);
  const speedKts = Math.round(velMs * 1.94384);

  // ── Movement filter ───────────────────────────────────────────
  //  - Keep all airborne aircraft (onGround === false)
  //  - Keep moving ground traffic (taxi/takeoff roll: speedKts >= 20)
  //  - Drop parked / fully stationary ground traffic
  const isMovingOnGround = onGround && speedKts >= 20;
  const isAirborne       = !onGround;
  if (!isAirborne && !isMovingOnGround) return null;

  return {
    icao24,
    callsign,
    lat,
    lon,
    altFt,
    speedKts,
    heading:  Math.round(track),
    vertRate: Math.round(vertRateMs * 10) / 10,
    onGround,
    airline,
    squawk,
  };
}

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

  const coords = AIRPORT_COORDS[iata];
  if (!coords) {
    return res.status(400).json({ error: `Unknown airport: ${iata}` });
  }

  const cacheKey = `livetraffic:${iata}`;
  const cached   = await redis.get<LiveTrafficData>(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  // ── Bounding box: ±1.5° ≈ 105 mi radius ─────────────────────
  const R     = 1.5;
  const lamin = coords.lat - R;
  const lamax = coords.lat + R;
  const lomin = coords.lon - R;
  const lomax = coords.lon + R;
  // Approx radius in nautical miles for ADS-B Exchange (uses nm, not degrees)
  const radiusNm = Math.round(R * 60);   // 1° lat ≈ 60 nm

  // ── Helper: sort + cap ────────────────────────────────────────
  // Capture coords into a local const so TypeScript can prove it non-null
  // inside the inner sort comparator (the outer guard already narrowed it).
  const airportLat = coords.lat;
  const airportLon = coords.lon;
  function sortAndCap(parsed: Aircraft[]): Aircraft[] {
    return parsed
      .sort((a, b) => {
        const aDist = Math.hypot(a.lat - airportLat, a.lon - airportLon);
        const bDist = Math.hypot(b.lat - airportLat, b.lon - airportLon);
        if (a.onGround !== b.onGround) return a.onGround ? 1 : -1;
        return aDist - bDist;
      })
      .slice(0, 100);
  }

  const now = Date.now();

  // ── 1. ADS-B Exchange (best real-time ADS-B coverage) ────────
  // Register free at https://adsbexchange.com/api-access/
  // Set ADSBX_API_KEY in Vercel environment variables.
  const adsbxKey = process.env['ADSBX_API_KEY'];
  if (adsbxKey) {
    try {
      const adsbxUrl = `https://adsbexchange.com/api/aircraft/v2/lat/${coords.lat}/lon/${coords.lon}/dist/${radiusNm}/`;
      const adsbxResp = await fetch(adsbxUrl, {
        headers: {
          'api-auth':   adsbxKey,
          'User-Agent': 'APTSA/1.0 (+https://aptsa.vercel.app)',
        },
        signal: AbortSignal.timeout(8_000),
      });

      if (adsbxResp.ok) {
        const adsbxJson = (await adsbxResp.json()) as { ac?: any[] };
        const acList = adsbxJson.ac ?? [];

        // ADS-B Exchange aircraft object fields (v2):
        //   hex, flight (callsign), lat, lon, alt_baro, alt_geom,
        //   gs (ground speed kts), track (heading), baro_rate, nic,
        //   r (registration), t (aircraft type), category
        const adsbxParsed: Aircraft[] = acList
          .filter((a: any) => {
            const cs = String(a.flight ?? '').trim().toUpperCase();
            if (!cs) return false;
            if (Math.abs(a.lat ?? 0) > 90 || Math.abs(a.lon ?? 0) > 180) return false;
            // Commercial-only: ICAO callsign pattern or known airline alias
            const airline = resolveAirline(cs);
            const isIcao  = /^[A-Z]{3}\d/.test(cs);
            const isReg   = /^[A-Z]-|^[A-Z]{1,2}\d|^N\d|^VH|^C-|^G-|^D-|^OE-|^PH-/.test(cs);
            return (isIcao || airline !== '') && !isReg;
          })
          .map((a: any): Aircraft => {
            const cs      = String(a.flight ?? '').trim().toUpperCase();
            const altFt   = Number(a.alt_baro  ?? a.alt_geom ?? 0);
            const speedKts= Number(a.gs ?? 0);
            const onGround= a.alt_baro === 'ground' || (altFt < 100 && speedKts < 30);
            return {
              icao24:   String(a.hex ?? '').toLowerCase(),
              callsign: cs,
              lat:      Number(a.lat),
              lon:      Number(a.lon),
              altFt:    isNaN(altFt) ? 0 : Math.round(altFt),
              speedKts: Math.round(speedKts),
              heading:  Math.round(Number(a.track ?? 0)),
              vertRate: Number(a.baro_rate ?? 0) / 60,  // ft/min → approx m/s
              onGround,
              airline:  resolveAirline(cs),
              squawk:   String(a.squawk ?? ''),
            };
          })
          .filter((a): a is Aircraft => {
            const isMoving = a.onGround ? a.speedKts >= 20 : true;
            return isMoving && !isNaN(a.lat) && !isNaN(a.lon);
          });

        const aircraft = sortAndCap(adsbxParsed);
        const result: LiveTrafficData = {
          iata, aircraft,
          fetchedAt: new Date().toISOString(),
          count:     aircraft.length,
          source:    'adsbexchange',
        };
        await redis.setex(cacheKey, 15, result);
        res.setHeader('X-Cache', 'MISS');
        res.setHeader('X-Traffic-Source', 'adsbexchange');
        return res.status(200).json(result);
      }
    } catch (adsbxErr) {
      const msg = adsbxErr instanceof Error ? adsbxErr.message : String(adsbxErr);
      console.warn(`[live-traffic] ADS-B Exchange failed (${msg}), falling back to OpenSky`);
    }
  }

  // ── 2. airplanes.live (free community ADS-B, no key, no IP block) ─
  // Same JSON schema as ADS-B Exchange. Works from any host including AWS.
  // https://airplanes.live — aggregates ADS-B receivers globally.
  try {
    const alUrl = `https://api.airplanes.live/v2/point/${coords.lat}/${coords.lon}/${radiusNm}`;
    const alResp = await fetch(alUrl, {
      headers: { 'User-Agent': 'APTSA/1.0 (+https://aptsa.vercel.app)' },
      signal:  AbortSignal.timeout(8_000),
    });

    if (alResp.ok) {
      const alJson = (await alResp.json()) as { ac?: any[] };
      const acList = alJson.ac ?? [];

      const alParsed: Aircraft[] = acList
        .filter((a: any) => {
          const cs = String(a.flight ?? '').trim().toUpperCase();
          if (!cs) return false;
          if (Math.abs(a.lat ?? 0) > 90 || Math.abs(a.lon ?? 0) > 180) return false;
          // Stale position guard: seen_pos > 120 s means data is > 2 min old
          if ((a.seen_pos ?? 0) > 120) return false;
          const airline = resolveAirline(cs);
          const isIcao  = /^[A-Z]{3}\d/.test(cs);
          const isReg   = /^[A-Z]-|^[A-Z]{1,2}\d|^N\d|^VH|^C-|^G-|^D-|^OE-|^PH-/.test(cs);
          return (isIcao || airline !== '') && !isReg;
        })
        .map((a: any): Aircraft => {
          const cs       = String(a.flight ?? '').trim().toUpperCase();
          const altFt    = Number(a.alt_baro ?? a.alt_geom ?? 0);
          const speedKts = Number(a.gs ?? 0);
          const onGround = a.alt_baro === 'ground' || (altFt < 100 && speedKts < 30);
          // airplanes.live uses geom_rate (ft/min); ADSBX uses baro_rate
          const vertRateFtMin = Number(a.baro_rate ?? a.geom_rate ?? 0);
          return {
            icao24:   String(a.hex ?? '').toLowerCase(),
            callsign: cs,
            lat:      Number(a.lat),
            lon:      Number(a.lon),
            altFt:    isNaN(altFt) ? 0 : Math.round(altFt),
            speedKts: Math.round(speedKts),
            heading:  Math.round(Number(a.track ?? 0)),
            vertRate: vertRateFtMin / 196.85,   // ft/min → m/s
            onGround,
            airline:  resolveAirline(cs),
            squawk:   String(a.squawk ?? ''),
          };
        })
        .filter((a): a is Aircraft => {
          const isMoving = a.onGround ? a.speedKts >= 20 : true;
          return isMoving && !isNaN(a.lat) && !isNaN(a.lon);
        });

      const aircraft = sortAndCap(alParsed);
      if (aircraft.length > 0) {
        const result: LiveTrafficData = {
          iata, aircraft,
          fetchedAt: new Date().toISOString(),
          count:     aircraft.length,
          source:    'opensky',   // frontend compat label (reuse existing badge)
        };
        await redis.setex(cacheKey, 15, result);
        res.setHeader('X-Cache', 'MISS');
        res.setHeader('X-Traffic-Source', 'airplanes.live');
        return res.status(200).json(result);
      }
      console.warn(`[live-traffic] airplanes.live returned 0 commercial aircraft for ${iata}`);
    } else {
      console.warn(`[live-traffic] airplanes.live HTTP ${alResp.status}`);
    }
  } catch (alErr) {
    const msg = alErr instanceof Error ? alErr.message : String(alErr);
    console.warn(`[live-traffic] airplanes.live failed (${msg}), trying FlightAware`);
  }

  // ── 3. FlightAware airport traffic (works from Vercel/AWS) ───
  // Fetches arrivals + departures windows centred on now (±2 h),
  // keeps only flights that have a valid last_position.
  const faKey = process.env['FLIGHTAWARE_API_KEY'];
  if (faKey) {
    try {
      const now2 = new Date();
      const start = new Date(now2.getTime() - 2 * 3_600_000).toISOString();
      const end   = new Date(now2.getTime() + 2 * 3_600_000).toISOString();

      interface FaPos {
        latitude:    number;
        longitude:   number;
        altitude:    number;   // hundreds of feet
        groundspeed: number;   // knots
        heading:     number;
        update_type: string;
      }
      interface FaArrDep {
        ident:         string;
        ident_iata?:   string;
        fa_flight_id?: string;
        operator_iata?: string | null;
        last_position: FaPos | null;
      }

      const [arrResp, depResp] = await Promise.all([
        fetch(
          `https://aeroapi.flightaware.com/aeroapi/airports/${iata}/flights/arrivals`
          + `?type=airline&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&max_pages=1`,
          { headers: { 'x-apikey': faKey }, signal: AbortSignal.timeout(8_000) },
        ),
        fetch(
          `https://aeroapi.flightaware.com/aeroapi/airports/${iata}/flights/departures`
          + `?type=airline&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&max_pages=1`,
          { headers: { 'x-apikey': faKey }, signal: AbortSignal.timeout(8_000) },
        ),
      ]);

      const arrJson = arrResp.ok
        ? ((await arrResp.json()) as { arrivals?: FaArrDep[] })
        : { arrivals: [] };
      const depJson = depResp.ok
        ? ((await depResp.json()) as { departures?: FaArrDep[] })
        : { departures: [] };

      const allFlights: FaArrDep[] = [
        ...(arrJson.arrivals  ?? []),
        ...(depJson.departures ?? []),
      ];

      const faParsed: Aircraft[] = allFlights
        .filter((f) => {
          const pos = f.last_position;
          if (!pos) return false;
          if (Math.abs(pos.latitude) > 90 || Math.abs(pos.longitude) > 180) return false;
          // Must be within our bounding box
          if (pos.latitude  < lamin || pos.latitude  > lamax) return false;
          if (pos.longitude < lomin || pos.longitude > lomax) return false;
          return true;
        })
        .map((f): Aircraft => {
          const pos      = f.last_position!;
          const callsign = (f.ident_iata ?? f.ident).toUpperCase();
          const altFt    = Math.round(pos.altitude * 100);       // hundreds-of-ft → ft
          const onGround = pos.altitude < 1 || pos.update_type === 'GS';
          return {
            icao24:   (f.fa_flight_id ?? f.ident).toLowerCase().replace(/[^a-z0-9]/g, ''),
            callsign,
            lat:      pos.latitude,
            lon:      pos.longitude,
            altFt:    isNaN(altFt) ? 0 : altFt,
            speedKts: Math.round(pos.groundspeed),
            heading:  Math.round(pos.heading),
            vertRate: 0,   // not provided by airport endpoint
            onGround,
            airline:  resolveAirline(callsign),
            squawk:   '',
          };
        })
        .filter((a) => {
          // Apply same movement filter as OpenSky
          const isMoving = a.onGround ? a.speedKts >= 20 : true;
          return isMoving;
        });

      // Deduplicate by callsign (arrivals and departures may overlap)
      const seen = new Set<string>();
      const unique = faParsed.filter((a) => {
        if (seen.has(a.callsign)) return false;
        seen.add(a.callsign);
        return true;
      });

      if (unique.length > 0) {
        const aircraft = sortAndCap(unique);
        const result: LiveTrafficData = {
          iata, aircraft,
          fetchedAt: new Date().toISOString(),
          count:     aircraft.length,
          source:    'flightaware',
        };
        await redis.setex(cacheKey, 90, result);
        res.setHeader('X-Cache', 'MISS');
        res.setHeader('X-Traffic-Source', 'flightaware');
        return res.status(200).json(result);
      }
      // 0 results = no aircraft with position yet; fall through to OpenSky
      console.warn(`[live-traffic] FlightAware returned 0 positioned aircraft for ${iata}, trying OpenSky`);
    } catch (faErr) {
      const msg = faErr instanceof Error ? faErr.message : String(faErr);
      console.warn(`[live-traffic] FlightAware failed (${msg}), trying OpenSky`);
    }
  }

  // ── 4. OpenSky Network (last resort — may be blocked from AWS) ─
  try {
    const url = `https://opensky-network.org/api/states/all`
      + `?lamin=${lamin}&lamax=${lamax}&lomin=${lomin}&lomax=${lomax}`;

    const osUser = process.env['OPENSKY_USER'];
    const osPass = process.env['OPENSKY_PASS'];
    const headers: Record<string, string> = {
      'User-Agent': 'APTSA/1.0 (+https://aptsa.vercel.app)',
    };
    if (osUser && osPass) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${osUser}:${osPass}`).toString('base64');
    }

    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(9_000) });
    if (!resp.ok) throw new Error(`OpenSky HTTP ${resp.status}`);

    const json   = (await resp.json()) as { states?: unknown[][] };
    const states = json.states ?? [];

    const parsed = states
      .map((s) => parseState(s, now))
      .filter((a): a is Aircraft => a !== null);

    const aircraft = sortAndCap(parsed);

    const result: LiveTrafficData = {
      iata, aircraft,
      fetchedAt: new Date().toISOString(),
      count:     aircraft.length,
      source:    'opensky',
    };

    // Cache TTL:
    //   Authenticated  → 20 s  (4,000 req/day quota; 20 s poll is sustainable)
    //   Anonymous      → 60 s  (400 req/day quota; 60 s gives ~400 distinct calls/day)
    const cacheTtl = (osUser && osPass) ? 20 : 60;
    await redis.setex(cacheKey, cacheTtl, result);
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Traffic-Source', 'opensky');
    return res.status(200).json(result);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[live-traffic] OpenSky failed: ${msg}`);

    // Return empty — NEVER simulate. Fake aircraft are worse than no aircraft.
    return res.status(200).json({
      iata,
      aircraft:  [],
      fetchedAt: new Date().toISOString(),
      count:     0,
      source:    'error' as const,
      error:     'Live traffic temporarily unavailable — no simulation fallback',
    });
  }
}
