// ============================================================
// SwiftClear — Live Aircraft Traffic (OpenSky Network)
//
// GET /api/live-traffic?airportIata=ATL
//
// Fetches all airborne aircraft within a ~150 mi radius of the
// airport using the OpenSky Network REST API (free, no key).
// Results cached 45 s in Redis to respect rate limits.
//
// OpenSky state vector indices:
//  [0] icao24  [1] callsign  [5] lon  [6] lat
//  [7] baro_alt_m  [8] on_ground  [9] velocity_ms
//  [10] true_track  [13] geo_alt_m
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { redis } from '../src/lib/redis.js';

// 35 supported airports with lat/lon for bounding-box calculation
const AIRPORT_COORDS: Record<string, { lat: number; lon: number }> = {
  // Original 15
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
  // Expanded 20
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

export interface Aircraft {
  icao24:   string;
  callsign: string;
  lat:      number;
  lon:      number;
  altFt:    number;
  speedKts: number;
  heading:  number;
  onGround: boolean;
  airline:  string;   // 3-letter ICAO prefix from callsign
}

export interface LiveTrafficData {
  iata:       string;
  aircraft:   Aircraft[];
  fetchedAt:  string;
  count:      number;
}

function parseState(s: unknown[]): Aircraft | null {
  if (!Array.isArray(s)) return null;
  const lon    = s[5] as number | null;
  const lat    = s[6] as number | null;
  if (lon == null || lat == null) return null;

  const icao24   = String(s[0] ?? '');
  const callsign = String(s[1] ?? '').trim();
  const altM     = (s[7] as number | null) ?? (s[13] as number | null) ?? 0;
  const onGround = Boolean(s[8]);
  const velMs    = (s[9] as number | null) ?? 0;
  const track    = (s[10] as number | null) ?? 0;

  // Extract 3-letter ICAO airline code (first 3 alpha chars of callsign)
  const match   = callsign.match(/^([A-Z]{2,3})\d/);
  const airline = match ? match[1] : '';

  return {
    icao24,
    callsign,
    lat,
    lon,
    altFt:    Math.round(altM * 3.28084),
    speedKts: Math.round(velMs * 1.94384),
    heading:  Math.round(track),
    onGround,
    airline,
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
    return res.status(400).json({ error: 'airportIata required' });
  }

  const coords = AIRPORT_COORDS[iata];
  if (!coords) {
    return res.status(400).json({ error: `Unknown airport: ${iata}` });
  }

  // ── Cache check ───────────────────────────────────────────
  const cacheKey = `livetraffic:${iata}`;
  const cached   = await redis.get<LiveTrafficData>(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  // ── Bounding box: ±2.0° ≈ 140 mi radius ─────────────────
  const R    = 2.0;
  const lamin = coords.lat - R;
  const lamax = coords.lat + R;
  const lomin = coords.lon - R;
  const lomax = coords.lon + R;

  try {
    const url  = `https://opensky-network.org/api/states/all`
      + `?lamin=${lamin}&lamax=${lamax}&lomin=${lomin}&lomax=${lomax}`;

    const resp = await fetch(url, {
      headers: { 'User-Agent': 'SwiftClear/1.0' },
      signal:  AbortSignal.timeout(8_000),
    });

    if (!resp.ok) throw new Error(`OpenSky HTTP ${resp.status}`);

    const json = (await resp.json()) as { states?: unknown[][] };
    const states = json.states ?? [];

    const aircraft: Aircraft[] = states
      .map(parseState)
      .filter((a): a is Aircraft => a !== null)
      .filter(a => !a.onGround || a.altFt < 500) // mostly airborne
      .slice(0, 120); // cap at 120 planes for performance

    const result: LiveTrafficData = {
      iata,
      aircraft,
      fetchedAt: new Date().toISOString(),
      count:     aircraft.length,
    };

    // Cache 45 s
    await redis.setex(cacheKey, 45, result);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(result);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[live-traffic] OpenSky failed: ${msg}`);
    return res.status(502).json({ error: 'Live traffic temporarily unavailable', aircraft: [], count: 0 });
  }
}
