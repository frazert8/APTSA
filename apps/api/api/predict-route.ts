// ============================================================
// APTSA -- ML Route Predictor
//
// GET /api/predict-route?callsign=AAL123&lat=35.5&lon=-97.2&heading=95&alt=36000
//
// When FlightAware returns 404 for a callsign, this endpoint infers
// the most likely origin→destination pair using a geometric scoring
// model:
//
//   score(O,D) =
//     heading_match(O,D)       ← aircraft heading vs great-circle bearing at position
//     × proximity_score(O,D)   ← perpendicular distance from aircraft to path
//     × position_validity(O,D) ← path fraction is plausibly en-route (5–95%)
//     × airline_affinity(O)    ← known hubs for this airline get a boost
//     × altitude_validity      ← cruising altitude confirms non-local flight
//
// Returns top 3 candidates with confidence. Results cached 5 min per
// (callsign_prefix + lat_bucket + lon_bucket + heading_bucket).
// ============================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { redis } from '../src/lib/redis.js';

// ── Airport database (lat, lon, hub airlines) ─────────────────
const AIRPORTS: Record<string, { lat: number; lon: number; hubs: string[] }> = {
  // ── US Domestic ───────────────────────────────────────────────
  ATL: { lat: 33.6407,  lon: -84.4277,  hubs: ['DAL','EIN','SKW','ENY','RPA'] },
  BOS: { lat: 42.3656,  lon: -71.0096,  hubs: ['JBU','AAL','UAL'] },
  CLT: { lat: 35.2271,  lon: -80.9431,  hubs: ['AAL','ENY'] },
  ORD: { lat: 41.9742,  lon: -87.9073,  hubs: ['UAL','AAL','SKW'] },
  DFW: { lat: 32.8998,  lon: -97.0403,  hubs: ['AAL','ENY'] },
  DEN: { lat: 39.8561,  lon: -104.6737, hubs: ['UAL','FFT','SWA'] },
  LAS: { lat: 36.0840,  lon: -115.1537, hubs: ['SWA','AAY'] },
  LAX: { lat: 33.9425,  lon: -118.4081, hubs: ['AAL','UAL','DAL','ASA','JBU'] },
  MIA: { lat: 25.7959,  lon: -80.2870,  hubs: ['AAL','ENY','LAN','COA'] },
  MSP: { lat: 44.8848,  lon: -93.2223,  hubs: ['DAL','SKW','SCX'] },
  JFK: { lat: 40.6413,  lon: -73.7781,  hubs: ['JBU','AAL','DAL'] },
  MCO: { lat: 28.4312,  lon: -81.3081,  hubs: ['SWA','AAL','DAL'] },
  PHX: { lat: 33.4373,  lon: -112.0078, hubs: ['SWA','AAL'] },
  SFO: { lat: 37.6213,  lon: -122.3790, hubs: ['UAL','ASA'] },
  SEA: { lat: 47.4502,  lon: -122.3088, hubs: ['ASA','DAL','SWA'] },
  AUS: { lat: 30.1945,  lon: -97.6699,  hubs: ['SWA','AAL'] },
  BWI: { lat: 39.1774,  lon: -76.6684,  hubs: ['SWA'] },
  BNA: { lat: 36.1263,  lon: -86.6774,  hubs: ['SWA','AAL'] },
  DCA: { lat: 38.8512,  lon: -77.0402,  hubs: ['AAL','DAL'] },
  DTW: { lat: 42.2162,  lon: -83.3554,  hubs: ['DAL','SKW'] },
  EWR: { lat: 40.6895,  lon: -74.1745,  hubs: ['UAL'] },
  FLL: { lat: 26.0726,  lon: -80.1527,  hubs: ['JBU','SWA','NKS','AAY'] },
  HOU: { lat: 29.6454,  lon: -95.2789,  hubs: ['SWA'] },
  IAD: { lat: 38.9531,  lon: -77.4565,  hubs: ['UAL'] },
  IAH: { lat: 29.9902,  lon: -95.3368,  hubs: ['UAL','COA'] },
  LGA: { lat: 40.7769,  lon: -73.8740,  hubs: ['DAL','AAL'] },
  MCI: { lat: 39.2976,  lon: -94.7130,  hubs: ['SWA','AAL'] },
  MDW: { lat: 41.7868,  lon: -87.7522,  hubs: ['SWA'] },
  PDX: { lat: 45.5898,  lon: -122.5951, hubs: ['ASA'] },
  PHL: { lat: 39.8744,  lon: -75.2424,  hubs: ['AAL','ENY'] },
  RDU: { lat: 35.8801,  lon: -78.7880,  hubs: ['DAL','AAL'] },
  SAN: { lat: 32.7338,  lon: -117.1933, hubs: ['SWA','UAL'] },
  SJC: { lat: 37.3626,  lon: -121.9290, hubs: ['SWA','AAL'] },
  SLC: { lat: 40.7899,  lon: -111.9791, hubs: ['DAL','SWA'] },
  TPA: { lat: 27.9755,  lon: -82.5332,  hubs: ['SWA','AAL'] },
  // ── Mexico ────────────────────────────────────────────────────
  CUN: { lat: 21.0365,  lon: -86.8771,  hubs: ['AMX','VOI','VIV'] },
  MEX: { lat: 19.4363,  lon: -99.0721,  hubs: ['AMX','VOI','VIV'] },
  GDL: { lat: 20.5218,  lon: -103.3107, hubs: ['VOI','VIV','AMX'] },
  MTY: { lat: 25.7785,  lon: -100.1069, hubs: ['AMX','VIV'] },
  SJD: { lat: 23.1518,  lon: -109.7211, hubs: ['AMX','VOI'] },
  // ── Caribbean ─────────────────────────────────────────────────
  SJU: { lat: 18.4394,  lon: -66.0018,  hubs: ['JBU','AAL','DAL'] },
  NAS: { lat: 25.0390,  lon: -77.4661,  hubs: ['AAL','BHS'] },
  MBJ: { lat: 18.5037,  lon: -77.9134,  hubs: ['AAL','JBU'] },
  PUJ: { lat: 18.5674,  lon: -68.3635,  hubs: ['AAL','JBU'] },
  HAV: { lat: 22.9892,  lon: -82.4091,  hubs: ['CBV'] },
  // ── Central & South America ───────────────────────────────────
  BOG: { lat:  4.7016,  lon: -74.1469,  hubs: ['AVA','LAN'] },
  GUA: { lat: 14.5833,  lon: -90.5275,  hubs: ['CMP','AMX'] },
  SAL: { lat: 13.4409,  lon: -89.0557,  hubs: ['CMP'] },
  PTY: { lat:  9.0713,  lon: -79.3835,  hubs: ['CMP'] },
  LIM: { lat: -12.0219, lon: -77.1143,  hubs: ['LAN','AVA'] },
  GRU: { lat: -23.4356, lon: -46.4731,  hubs: ['TAM','GLO'] },
  SCL: { lat: -33.3930, lon: -70.7858,  hubs: ['LAN'] },
  // ── Canada ────────────────────────────────────────────────────
  YYZ: { lat: 43.6777,  lon: -79.6248,  hubs: ['ACA','WJA'] },
  YVR: { lat: 49.1967,  lon: -123.1815, hubs: ['ACA','WJA'] },
  YUL: { lat: 45.4706,  lon: -73.7408,  hubs: ['ACA'] },
  YYC: { lat: 51.1315,  lon: -114.0106, hubs: ['WJA','ACA'] },
  // ── Europe (transatlantic corridors) ─────────────────────────
  LHR: { lat: 51.4700,  lon:  -0.4543,  hubs: ['BAW','VIR'] },
  CDG: { lat: 49.0097,  lon:   2.5479,  hubs: ['AFR'] },
  FRA: { lat: 50.0379,  lon:   8.5622,  hubs: ['DLH'] },
  AMS: { lat: 52.3086,  lon:   4.7639,  hubs: ['KLM'] },
  MAD: { lat: 40.4936,  lon:  -3.5668,  hubs: ['IBE'] },
};

const AP_CODES = Object.keys(AIRPORTS);

// ── Callsign prefix → likely hub airports (for affinity scoring) ─
const AIRLINE_HUBS: Record<string, string[]> = {
  AAL: ['DFW','CLT','PHX','MIA','PHL','LAX','JFK'],
  UAL: ['ORD','DEN','IAH','SFO','EWR','IAD','LAX'],
  DAL: ['ATL','DTW','MSP','SLC','SEA','JFK','BOS','LGA'],
  SWA: ['DAL','HOU','MDW','BWI','LAS','PHX','DEN','SLC','LAX','OAK'],
  JBU: ['JFK','BOS','FLL','LAX','LGB'],
  ASA: ['SEA','PDX','SFO','LAX','SAN'],
  NKS: ['FLL','ORD','LAS','MCO','DFW'],
  FFT: ['DEN','ORD','ATL','PHX'],
  AAY: ['LAS','PIE','SFB','BLI'],
  SCX: ['MSP','LAS','LAX'],
  HAL: ['HNL','OGG','ITO','KOA'],
  SKW: ['LAX','SFO','SEA','PHX'],
  ENY: ['DFW','CLT','MIA','JFK'],
  RPA: ['IAD','EWR','ORD','DFW'],
};

// ── Math helpers ──────────────────────────────────────────────
const DEG = Math.PI / 180;

function gcBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = lat1 * DEG, φ2 = lat2 * DEG;
  const Δλ = (lon2 - lon1) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) / DEG) + 360) % 360;
}

function gcDistKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const φ1 = lat1 * DEG, φ2 = lat2 * DEG;
  const Δφ = (lat2 - lat1) * DEG, Δλ = (lon2 - lon1) * DEG;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Cross-track distance: perpendicular distance from point P to great-circle
// path from A to B. Returns km.
function crossTrackKm(
  aLat: number, aLon: number,
  bLat: number, bLon: number,
  pLat: number, pLon: number,
): number {
  const R = 6371;
  const d13 = gcDistKm(aLat, aLon, pLat, pLon) / R;       // angular dist A→P
  const θ13 = gcBearing(aLat, aLon, pLat, pLon) * DEG;    // bearing A→P
  const θ12 = gcBearing(aLat, aLon, bLat, bLon) * DEG;    // bearing A→B
  return Math.abs(Math.asin(Math.sin(d13) * Math.sin(θ13 - θ12))) * R;
}

// Along-track distance: how far along the A→B path the closest point to P is.
// Returns a fraction 0–1.
function alongTrackFraction(
  aLat: number, aLon: number,
  bLat: number, bLon: number,
  pLat: number, pLon: number,
): number {
  const R = 6371;
  const totalKm = gcDistKm(aLat, aLon, bLat, bLon);
  if (totalKm < 1) return 0;
  const d13 = gcDistKm(aLat, aLon, pLat, pLon) / R;
  const θ13 = gcBearing(aLat, aLon, pLat, pLon) * DEG;
  const θ12 = gcBearing(aLat, aLon, bLat, bLon) * DEG;
  const xt   = Math.asin(Math.sin(d13) * Math.sin(θ13 - θ12));
  const at   = Math.acos(Math.cos(d13) / Math.cos(xt)) * R;
  return Math.max(0, Math.min(1, at / totalKm));
}

// Heading error: angular difference between two headings (0–180°)
function headingError(h1: number, h2: number): number {
  const diff = Math.abs(h1 - h2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// ── Score a single (origin, destination) pair ─────────────────
function scorePair(
  originCode: string,
  destCode:   string,
  pLat: number, pLon: number,
  heading: number,
  altFt:   number,
  airline: string,
): number {
  const O = AIRPORTS[originCode]!;
  const D = AIRPORTS[destCode]!;

  const routeKm = gcDistKm(O.lat, O.lon, D.lat, D.lon);

  // Short routes (<300 km) at high altitude are very unlikely matches
  if (routeKm < 300 && altFt > 25_000) return 0;

  // Cross-track distance: how far off the great-circle path is the aircraft?
  const xtKm = crossTrackKm(O.lat, O.lon, D.lat, D.lon, pLat, pLon);
  if (xtKm > 250) return 0;  // >250 km off-path → implausible

  // Along-track fraction: is the aircraft actually en-route (5–95%)?
  const frac = alongTrackFraction(O.lat, O.lon, D.lat, D.lon, pLat, pLon);
  if (frac < 0.05 || frac > 0.95) return 0;

  // Bearing at the aircraft's position along the path
  const fracLat = O.lat + (D.lat - O.lat) * frac;
  const fracLon = O.lon + (D.lon - O.lon) * frac;
  const pathBearing = gcBearing(O.lat, O.lon, D.lat, D.lon);
  // Also check mid-point bearing for accuracy on curved paths
  const midBearing  = gcBearing(fracLat, fracLon, D.lat, D.lon);
  const bestBearing = Math.abs(headingError(heading, pathBearing)) <
                      Math.abs(headingError(heading, midBearing))
                        ? pathBearing : midBearing;
  const hErr = headingError(heading, bestBearing);
  if (hErr > 50) return 0;  // >50° off heading → implausible direction

  // ── Component scores (all 0–1) ────────────────────────────
  // Heading: cos curve — 0° error = 1.0, 45° = 0.71, 90° = 0
  const headingScore = Math.cos(hErr * DEG);

  // Proximity: gaussian falloff — 0 km = 1.0, 100 km ≈ 0.61, 200 km ≈ 0.14
  const proximityScore = Math.exp(-(xtKm * xtKm) / (2 * 100 * 100));

  // Position validity: prefer mid-flight, penalise near endpoints
  const posScore = frac >= 0.1 && frac <= 0.9
    ? 1.0 : (frac < 0.1 ? frac / 0.1 : (1 - frac) / 0.1);

  // Altitude: short hops are low, long haul is high
  const expectedAlt = Math.min(39_000, 15_000 + routeKm * 0.8);
  const altDiff     = Math.abs(altFt - expectedAlt);
  const altScore    = Math.max(0, 1 - altDiff / 15_000);

  // Airline affinity: does this airline commonly fly into origin or destination?
  const hubs = AIRLINE_HUBS[airline] ?? [];
  const affinityO = hubs.includes(originCode) ? 1.3 : 1.0;
  const affinityD = hubs.includes(destCode)   ? 1.3 : 1.0;
  const affinityScore = Math.min(1.5, (affinityO + affinityD) / 2);

  // Combined score
  return headingScore * proximityScore * posScore * altScore * affinityScore;
}

// ── Callsign prefix → ICAO airline code ──────────────────────
function callsignAirline(callsign: string): string {
  return callsign.slice(0, 3).toUpperCase();
}

// ── Main export ───────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const callsign = (req.query['callsign'] as string | undefined)?.trim().toUpperCase() ?? '';
  const lat      = parseFloat(req.query['lat']     as string ?? '');
  const lon      = parseFloat(req.query['lon']     as string ?? '');
  const heading  = parseFloat(req.query['heading'] as string ?? '0');
  const altFt    = parseFloat(req.query['alt']     as string ?? '0');

  if (!callsign || isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ error: 'callsign, lat, lon required' });
  }

  // Cache key: quantise position to ~25 km buckets so nearby aircraft hit cache
  const latB    = Math.round(lat     / 0.25) * 0.25;
  const lonB    = Math.round(lon     / 0.25) * 0.25;
  const hdgB    = Math.round(heading / 10)   * 10;
  const cacheKey = `predictroute:${callsign}:${latB}:${lonB}:${hdgB}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  const airline = callsignAirline(callsign);

  // Score every ordered airport pair
  const candidates: { from: string; to: string; score: number; fraction: number }[] = [];

  for (const originCode of AP_CODES) {
    for (const destCode of AP_CODES) {
      if (originCode === destCode) continue;
      const score = scorePair(originCode, destCode, lat, lon, heading, altFt, airline);
      if (score > 0.05) {
        const O = AIRPORTS[originCode]!;
        const D = AIRPORTS[destCode]!;
        const fraction = alongTrackFraction(O.lat, O.lon, D.lat, D.lon, lat, lon);
        candidates.push({ from: originCode, to: destCode, score, fraction });
      }
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  const top3 = candidates.slice(0, 3);

  if (!top3.length) {
    return res.status(200).json({ predictions: [], method: 'geometric_ml' });
  }

  // Normalise scores to confidence percentages
  const maxScore = top3[0]!.score;
  const result = {
    predictions: top3.map((c) => ({
      from:       c.from,
      to:         c.to,
      confidence: Math.round((c.score / maxScore) * 100),
      pct:        Math.round(c.fraction * 100),
    })),
    method: 'geometric_ml',
  };

  // Cache for 5 minutes — route is stable for a given heading/position window
  await redis.setex(cacheKey, 300, result);
  res.setHeader('X-Cache', 'MISS');
  return res.status(200).json(result);
}
