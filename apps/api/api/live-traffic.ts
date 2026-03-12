// ============================================================
// SwiftClear — Live Aircraft Traffic (OpenSky Network)
//
// GET /api/live-traffic?airportIata=ATL
//
// Uses authenticated OpenSky Network REST API for 10× the
// request quota vs anonymous. Results cached 20 s.
//
// OpenSky state vector indices (all/v2):
//  [0]  icao24          [1]  callsign       [2]  origin_country
//  [3]  time_position   [4]  last_contact   [5]  longitude
//  [6]  latitude        [7]  baro_altitude  [8]  on_ground
//  [9]  velocity (m/s)  [10] true_track     [11] vertical_rate (m/s)
//  [12] sensors         [13] geo_altitude   [14] squawk
//  [15] spi             [16] position_source
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
  TAM: 'TAM',  // LATAM Airlines
  GLO: 'GLO',  // Gol Airlines
  VOI: 'VOI',  // Volaris
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
  source:    'opensky' | 'error';
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

  const altFt    = Math.round(altM * 3.28084);
  const speedKts = Math.round(velMs * 1.94384);

  // Filter strategy:
  //  - Keep all airborne aircraft (onGround === false)
  //  - Keep moving ground traffic (taxi/takeoff roll: speedKts >= 20)
  //  - Drop parked / fully stationary ground traffic (clutters the map)
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
    airline:  resolveAirline(callsign),
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

  // ── Bounding box: ±3.0° ≈ 210 mi radius ─────────────────────
  // Wide enough to capture aircraft on long final approach tracks,
  // holding patterns, and en-route traffic transitioning the airspace.
  const R     = 3.0;
  const lamin = coords.lat - R;
  const lamax = coords.lat + R;
  const lomin = coords.lon - R;
  const lomax = coords.lon + R;

  try {
    const url = `https://opensky-network.org/api/states/all`
      + `?lamin=${lamin}&lamax=${lamax}&lomin=${lomin}&lomax=${lomax}`;

    // Use credentials when available — authenticated tier: 4000 req/day
    // vs anonymous: 400 req/day.  The env vars are set in Vercel.
    const osUser = process.env['OPENSKY_USER'];
    const osPass = process.env['OPENSKY_PASS'];
    const headers: Record<string, string> = {
      'User-Agent': 'SwiftClear/1.0 (+https://aptsa.vercel.app)',
    };
    if (osUser && osPass) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${osUser}:${osPass}`).toString('base64');
    }

    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(9_000),
    });

    if (!resp.ok) throw new Error(`OpenSky HTTP ${resp.status}`);

    const json   = (await resp.json()) as { states?: unknown[][] };
    const states = json.states ?? [];

    const now = Date.now();

    // Parse all states — pass current timestamp for freshness filtering.
    const parsed = states
      .map((s) => parseState(s, now))
      .filter((a): a is Aircraft => a !== null);

    // Sort: airborne first, then by proximity to the airport.
    // No hard cap — return every valid aircraft in the bounding box.
    const aircraft = parsed.sort((a, b) => {
      const aDist = Math.hypot(a.lat - coords.lat, a.lon - coords.lon);
      const bDist = Math.hypot(b.lat - coords.lat, b.lon - coords.lon);
      if (a.onGround !== b.onGround) return a.onGround ? 1 : -1;
      return aDist - bDist;
    });

    const result: LiveTrafficData = {
      iata,
      aircraft,
      fetchedAt: new Date().toISOString(),
      count:     aircraft.length,
      source:    'opensky',
    };

    // 20 s cache — OpenSky state vectors update every ~10–15 s.
    // Short enough to feel live; long enough to protect the quota.
    await redis.setex(cacheKey, 20, result);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(result);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[live-traffic] OpenSky failed: ${msg}`);
    return res.status(502).json({
      error:    'Live traffic temporarily unavailable',
      aircraft: [],
      count:    0,
      source:   'error',
    });
  }
}
