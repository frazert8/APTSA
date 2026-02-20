-- ============================================================
-- SwiftClear — Migration 004: Complete Terminal Seed
-- Adds missing airports + terminals for all 15 dropdown airports
-- ============================================================

-- ── Missing airports ─────────────────────────────────────────
INSERT INTO airports (iata_code, icao_code, name, city, country_code, location, timezone)
VALUES
  ('MIA', 'KMIA', 'Miami Intl',                    'Miami',        'US', ST_MakePoint(-80.2870, 25.7959)::GEOGRAPHY, 'America/New_York'),
  ('BOS', 'KBOS', 'Logan Intl',                    'Boston',       'US', ST_MakePoint(-71.0052, 42.3656)::GEOGRAPHY, 'America/New_York'),
  ('PHX', 'KPHX', 'Phoenix Sky Harbor Intl',       'Phoenix',      'US', ST_MakePoint(-112.0080, 33.4373)::GEOGRAPHY, 'America/Phoenix'),
  ('CLT', 'KCLT', 'Charlotte Douglas Intl',        'Charlotte',    'US', ST_MakePoint(-80.9431, 35.2140)::GEOGRAPHY, 'America/New_York'),
  ('MSP', 'KMSP', 'Minneapolis-Saint Paul Intl',   'Minneapolis',  'US', ST_MakePoint(-93.2218, 44.8848)::GEOGRAPHY, 'America/Chicago')
ON CONFLICT (iata_code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- Helper: each block inserts terminals for one airport using
-- approximate checkpoint coordinates (100 m buffer geofence).
-- ON CONFLICT DO NOTHING keeps the seed idempotent.
-- ─────────────────────────────────────────────────────────────

-- ── ATL — Hartsfield-Jackson ──────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'ATL')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('T-South', 'South Security',           -84.4300, 33.6380, 120, FALSE, 14, 1),
  ('T-South', 'South Security — PreCheck',-84.4295, 33.6382,  80, TRUE,  10, 2),
  ('T-North', 'North Security',           -84.4265, 33.6430, 120, FALSE, 18, 3),
  ('T-North', 'North Security — PreCheck',-84.4262, 33.6433,  80, TRUE,  12, 4),
  ('T-Intl',  'International Terminal',   -84.4310, 33.6360, 150, FALSE, 22, 5)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── LAX — Los Angeles ─────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'LAX')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('TBIT',  'Tom Bradley International',         -118.4082, 33.9433, 150, FALSE, 20, 1),
  ('TBIT',  'Tom Bradley — PreCheck',            -118.4079, 33.9430,  80, TRUE,  16, 2),
  ('T1-3',  'Terminals 1–3 (West)',              -118.4045, 33.9416, 130, FALSE, 14, 3),
  ('T1-3',  'Terminals 1–3 — PreCheck',          -118.4042, 33.9413,  80, TRUE,  12, 4),
  ('T4-8',  'Terminals 4–8 (East)',              -118.4098, 33.9416, 130, FALSE, 14, 5),
  ('T4-8',  'Terminals 4–8 — PreCheck',          -118.4095, 33.9413,  80, TRUE,  12, 6)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── ORD — Chicago O'Hare ─────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'ORD')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('T1',  'Terminal 1 (United)',              -87.9068, 41.9783, 120, FALSE, 18, 1),
  ('T1',  'Terminal 1 — PreCheck',            -87.9065, 41.9780,  80, TRUE,  14, 2),
  ('T2',  'Terminal 2',                       -87.9042, 41.9760, 110, FALSE, 16, 3),
  ('T3',  'Terminal 3 (American)',            -87.9018, 41.9755, 120, FALSE, 16, 4),
  ('T3',  'Terminal 3 — PreCheck',            -87.9015, 41.9752,  80, TRUE,  12, 5),
  ('T5',  'Terminal 5 (International)',       -87.9090, 41.9762, 130, FALSE, 20, 6)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── DFW — Dallas/Fort Worth ───────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'DFW')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('A',  'Terminal A',                      -97.0355, 32.8992, 110, FALSE, 14, 1),
  ('B',  'Terminal B',                      -97.0382, 32.8998, 110, FALSE, 14, 2),
  ('C',  'Terminal C',                      -97.0405, 32.9010, 110, FALSE, 16, 3),
  ('C',  'Terminal C — PreCheck',           -97.0402, 32.9007,  80, TRUE,  12, 4),
  ('D',  'Terminal D (International)',      -97.0430, 32.9010, 130, FALSE, 20, 5),
  ('E',  'Terminal E',                      -97.0457, 32.8990, 110, FALSE, 16, 6)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── DEN — Denver ─────────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'DEN')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Main', 'Main Security (Level 6)',        -104.6730, 39.8560, 150, FALSE, 22, 1),
  ('Main', 'Main Security — PreCheck',       -104.6727, 39.8557,  80, TRUE,  18, 2),
  ('Intl', 'International Security (A)',     -104.6742, 39.8565, 120, FALSE, 20, 3)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── JFK — New York ────────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'JFK')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('T1',  'Terminal 1 (International)',     -73.7905, 40.6435, 120, FALSE, 18, 1),
  ('T2',  'Terminal 2',                    -73.7882, 40.6428, 100, FALSE, 14, 2),
  ('T4',  'Terminal 4 (Delta)',             -73.7818, 40.6424, 130, FALSE, 18, 3),
  ('T4',  'Terminal 4 — PreCheck',         -73.7815, 40.6421,  80, TRUE,  14, 4),
  ('T5',  'Terminal 5 (JetBlue)',          -73.7795, 40.6418, 110, FALSE, 14, 5),
  ('T5',  'Terminal 5 — PreCheck',         -73.7792, 40.6415,  80, TRUE,  12, 6),
  ('T8',  'Terminal 8 (American)',         -73.7755, 40.6407, 120, FALSE, 16, 7),
  ('T8',  'Terminal 8 — PreCheck',         -73.7752, 40.6404,  80, TRUE,  12, 8)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── SFO — San Francisco ───────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'SFO')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('T1',    'Terminal 1',                  -122.3848, 37.6188, 110, FALSE, 16, 1),
  ('T2',    'Terminal 2',                  -122.3832, 37.6180, 110, FALSE, 14, 2),
  ('T2',    'Terminal 2 — PreCheck',       -122.3829, 37.6177,  80, TRUE,  12, 3),
  ('T3',    'Terminal 3',                  -122.3818, 37.6175, 110, FALSE, 16, 4),
  ('Intl',  'International Terminal G',    -122.3765, 37.6150, 130, FALSE, 22, 5),
  ('Intl',  'International — PreCheck',    -122.3762, 37.6147,  80, TRUE,  18, 6)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── LAS — Las Vegas ───────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'LAS')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('T1',  'Terminal 1 (B/C Gates)',        -115.1543, 36.0828, 120, FALSE, 16, 1),
  ('T1',  'Terminal 1 — PreCheck',         -115.1540, 36.0825,  80, TRUE,  12, 2),
  ('T3',  'Terminal 3 (D Gates)',          -115.1496, 36.0842, 120, FALSE, 16, 3),
  ('T3',  'Terminal 3 — PreCheck',         -115.1493, 36.0839,  80, TRUE,  12, 4)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── SEA — Seattle-Tacoma ──────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'SEA')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Main', 'Checkpoint C (Main)',           -122.3100, 47.4490, 120, FALSE, 16, 1),
  ('Main', 'Checkpoint C — PreCheck',       -122.3097, 47.4487,  80, TRUE,  12, 2),
  ('North','Checkpoint D (North)',          -122.3088, 47.4500, 110, FALSE, 18, 3),
  ('North','Checkpoint D — PreCheck',       -122.3085, 47.4497,  80, TRUE,  14, 4)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── MCO — Orlando ─────────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'MCO')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('A',     'Terminal A (Gates 1–29)',      -81.3105, 28.4305, 120, FALSE, 16, 1),
  ('A',     'Terminal A — PreCheck',        -81.3102, 28.4302,  80, TRUE,  12, 2),
  ('B',     'Terminal B (Gates 70–129)',    -81.3082, 28.4300, 120, FALSE, 16, 3),
  ('B',     'Terminal B — PreCheck',        -81.3079, 28.4297,  80, TRUE,  12, 4),
  ('C',     'Terminal C (International)',   -81.3083, 28.4312, 130, FALSE, 20, 5)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── MIA — Miami ───────────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'MIA')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('North', 'North Terminal (Concourse D/E)', -80.2882, 25.7968, 130, FALSE, 18, 1),
  ('North', 'North Terminal — PreCheck',      -80.2878, 25.7965,  80, TRUE,  14, 2),
  ('South', 'South Terminal (Concourse J/K)', -80.2858, 25.7950, 120, FALSE, 16, 3),
  ('South', 'South Terminal — PreCheck',      -80.2855, 25.7947,  80, TRUE,  12, 4)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── BOS — Boston Logan ────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'BOS')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('A',   'Terminal A',                    -71.0065, 42.3660, 100, FALSE, 14, 1),
  ('B',   'Terminal B',                    -71.0048, 42.3655, 110, FALSE, 14, 2),
  ('B',   'Terminal B — PreCheck',         -71.0045, 42.3652,  80, TRUE,  12, 3),
  ('C',   'Terminal C',                    -71.0040, 42.3660, 110, FALSE, 14, 4),
  ('C',   'Terminal C — PreCheck',         -71.0037, 42.3657,  80, TRUE,  12, 5),
  ('E',   'Terminal E (International)',    -71.0033, 42.3648, 120, FALSE, 18, 6)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── PHX — Phoenix Sky Harbor ──────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'PHX')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('T2',  'Terminal 2',                    -112.0065, 33.4368, 100, FALSE, 14, 1),
  ('T3',  'Terminal 3',                    -112.0077, 33.4372, 110, FALSE, 16, 2),
  ('T3',  'Terminal 3 — PreCheck',         -112.0074, 33.4369,  80, TRUE,  12, 3),
  ('T4',  'Terminal 4 (American)',         -112.0093, 33.4380, 130, FALSE, 18, 4),
  ('T4',  'Terminal 4 — PreCheck',         -112.0090, 33.4377,  80, TRUE,  14, 5)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── CLT — Charlotte Douglas ───────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'CLT')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Main', 'Main Security (A/B/C)',         -80.9445, 35.2148, 140, FALSE, 16, 1),
  ('Main', 'Main Security — PreCheck',      -80.9441, 35.2145,  80, TRUE,  12, 2),
  ('D',    'Concourse D (International)',   -80.9425, 35.2135, 120, FALSE, 20, 3)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── MSP — Minneapolis-Saint Paul ─────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'MSP')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('T1',  'Terminal 1 Lindbergh',          -93.2228, 44.8855, 130, FALSE, 18, 1),
  ('T1',  'Terminal 1 — PreCheck',         -93.2224, 44.8852,  80, TRUE,  14, 2),
  ('T2',  'Terminal 2 Humphrey',           -93.2197, 44.8838, 110, FALSE, 16, 3)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;
