-- ============================================================
-- SwiftClear — Migration 006: Expand airport coverage
-- Adds 20 high-traffic US airports with real TSA checkpoint
-- names and coordinates. Existing airports are untouched.
-- ============================================================

-- ── New airports ─────────────────────────────────────────────
INSERT INTO airports (iata_code, icao_code, name, city, country_code, location, timezone)
VALUES
  ('EWR', 'KEWR', 'Newark Liberty Intl',                  'Newark',          'US', ST_MakePoint(-74.1745, 40.6895)::GEOGRAPHY, 'America/New_York'),
  ('LGA', 'KLGA', 'LaGuardia Airport',                    'New York',        'US', ST_MakePoint(-73.8740, 40.7769)::GEOGRAPHY, 'America/New_York'),
  ('IAH', 'KIAH', 'George Bush Intercontinental',         'Houston',         'US', ST_MakePoint(-95.3368, 29.9902)::GEOGRAPHY, 'America/Chicago'),
  ('HOU', 'KHOU', 'William P. Hobby Airport',             'Houston',         'US', ST_MakePoint(-95.2789, 29.6454)::GEOGRAPHY, 'America/Chicago'),
  ('SAN', 'KSAN', 'San Diego Intl',                       'San Diego',       'US', ST_MakePoint(-117.1933, 32.7338)::GEOGRAPHY, 'America/Los_Angeles'),
  ('TPA', 'KTPA', 'Tampa Intl',                           'Tampa',           'US', ST_MakePoint(-82.5332, 27.9755)::GEOGRAPHY, 'America/New_York'),
  ('MDW', 'KMDW', 'Chicago Midway Intl',                  'Chicago',         'US', ST_MakePoint(-87.7522, 41.7868)::GEOGRAPHY, 'America/Chicago'),
  ('BWI', 'KBWI', 'Baltimore/Washington Intl Thurgood Marshall', 'Baltimore', 'US', ST_MakePoint(-76.6684, 39.1774)::GEOGRAPHY, 'America/New_York'),
  ('DCA', 'KDCA', 'Ronald Reagan Washington National',    'Washington',      'US', ST_MakePoint(-77.0402, 38.8512)::GEOGRAPHY, 'America/New_York'),
  ('IAD', 'KIAD', 'Washington Dulles Intl',               'Washington',      'US', ST_MakePoint(-77.4565, 38.9531)::GEOGRAPHY, 'America/New_York'),
  ('PHL', 'KPHL', 'Philadelphia Intl',                    'Philadelphia',    'US', ST_MakePoint(-75.2424, 39.8744)::GEOGRAPHY, 'America/New_York'),
  ('DTW', 'KDTW', 'Detroit Metro Wayne County',           'Detroit',         'US', ST_MakePoint(-83.3554, 42.2162)::GEOGRAPHY, 'America/Detroit'),
  ('FLL', 'KFLL', 'Fort Lauderdale-Hollywood Intl',       'Fort Lauderdale', 'US', ST_MakePoint(-80.1527, 26.0726)::GEOGRAPHY, 'America/New_York'),
  ('BNA', 'KBNA', 'Nashville Intl',                       'Nashville',       'US', ST_MakePoint(-86.6774, 36.1263)::GEOGRAPHY, 'America/Chicago'),
  ('AUS', 'KAUS', 'Austin-Bergstrom Intl',                'Austin',          'US', ST_MakePoint(-97.6699, 30.1945)::GEOGRAPHY, 'America/Chicago'),
  ('PDX', 'KPDX', 'Portland Intl',                        'Portland',        'US', ST_MakePoint(-122.5951, 45.5898)::GEOGRAPHY, 'America/Los_Angeles'),
  ('SLC', 'KSLC', 'Salt Lake City Intl',                  'Salt Lake City',  'US', ST_MakePoint(-111.9791, 40.7899)::GEOGRAPHY, 'America/Denver'),
  ('SJC', 'KSJC', 'Norman Y. Mineta San Jose Intl',       'San Jose',        'US', ST_MakePoint(-121.9290, 37.3626)::GEOGRAPHY, 'America/Los_Angeles'),
  ('RDU', 'KRDU', 'Raleigh-Durham Intl',                  'Raleigh',         'US', ST_MakePoint(-78.7880, 35.8801)::GEOGRAPHY, 'America/New_York'),
  ('MCI', 'KMCI', 'Kansas City Intl',                     'Kansas City',     'US', ST_MakePoint(-94.7130, 39.2976)::GEOGRAPHY, 'America/Chicago')
ON CONFLICT (iata_code) DO NOTHING;

-- ── EWR — Newark Liberty ──────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'EWR')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal A', 'Terminal A Security',        -74.1823, 40.6887, 130, FALSE, 14, 1),
  ('Terminal B', 'Terminal B Security',        -74.1770, 40.6902, 130, FALSE, 14, 2),
  ('Terminal C', 'Terminal C Security',        -74.1712, 40.6930, 140, FALSE, 18, 3)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── LGA — LaGuardia ───────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'LGA')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal B', 'Terminal B Security — North', -73.8724, 40.7764, 120, FALSE, 12, 1),
  ('Terminal B', 'Terminal B Security — South', -73.8720, 40.7758, 120, FALSE, 12, 2),
  ('Terminal C', 'Terminal C Security',         -73.8762, 40.7749, 120, FALSE, 12, 3),
  ('Terminal D', 'Terminal D Security',         -73.8785, 40.7743, 120, FALSE, 12, 4)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── IAH — Houston Bush Intercontinental ───────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'IAH')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal A', 'Terminal A Security',          -95.3413, 29.9912, 120, FALSE, 14, 1),
  ('Terminal B', 'Terminal B Security',          -95.3390, 29.9905, 120, FALSE, 14, 2),
  ('Terminal C', 'Terminal C Security',          -95.3362, 29.9898, 130, FALSE, 16, 3),
  ('Terminal D', 'Terminal D International',     -95.3338, 29.9890, 140, FALSE, 20, 4),
  ('Terminal E', 'Terminal E Security',          -95.3315, 29.9882, 120, FALSE, 14, 5)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── HOU — Houston Hobby ────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'HOU')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal MAIN', 'East Checkpoint (Concourses 1–2)',  -95.2793, 29.6462, 120, FALSE, 12, 1),
  ('Terminal MAIN', 'West Checkpoint (Concourses 3–5)',  -95.2780, 29.6445, 120, FALSE, 12, 2)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── SAN — San Diego ────────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'SAN')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal 1', 'Terminal 1 Security (Gates 1–9)',       -117.1920, 32.7330, 120, FALSE, 12, 1),
  ('Terminal 2', 'Terminal 2 East Security (Gates 20–29)',-117.1952, 32.7345, 120, FALSE, 12, 2),
  ('Terminal 2', 'Terminal 2 West Security (Gates 30–39)',-117.1968, 32.7355, 120, FALSE, 14, 3)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── TPA — Tampa ────────────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'TPA')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Airside A', 'Airside A Security',  -82.5355, 27.9760, 120, FALSE, 14, 1),
  ('Airside C', 'Airside C Security',  -82.5340, 27.9752, 120, FALSE, 14, 2),
  ('Airside E', 'Airside E Security',  -82.5325, 27.9745, 120, FALSE, 16, 3),
  ('Airside F', 'Airside F Security',  -82.5310, 27.9738, 120, FALSE, 14, 4)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── MDW — Chicago Midway ───────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'MDW')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal MAIN', 'Blue Checkpoint',   -87.7530, 41.7872, 130, FALSE, 14, 1),
  ('Terminal MAIN', 'Orange Checkpoint', -87.7522, 41.7865, 130, FALSE, 14, 2),
  ('Terminal MAIN', 'Green Checkpoint',  -87.7515, 41.7858, 120, FALSE, 14, 3)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── BWI — Baltimore/Washington ─────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'BWI')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Pier A/B', 'A/B Checkpoint',  -76.6655, 39.1768, 120, FALSE, 14, 1),
  ('Pier C',   'C Checkpoint',    -76.6672, 39.1778, 120, FALSE, 14, 2),
  ('Pier D',   'D Checkpoint',    -76.6688, 39.1785, 120, FALSE, 16, 3),
  ('Pier E',   'E Checkpoint',    -76.6705, 39.1790, 120, FALSE, 16, 4),
  ('Pier F',   'F Checkpoint',    -76.6720, 39.1796, 110, FALSE, 18, 5)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── DCA — Reagan National ─────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'DCA')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal A',   'Terminal A Security',        -77.0418, 38.8528, 110, FALSE, 12, 1),
  ('Terminal B/C', 'Terminal B/C North Security', -77.0398, 38.8515, 130, FALSE, 14, 2),
  ('Terminal B/C', 'Terminal B/C South Security', -77.0392, 38.8508, 130, FALSE, 14, 3)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── IAD — Washington Dulles ────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'IAD')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Main Terminal', 'Checkpoint A (Gates A1–A12)',       -77.4558, 38.9538, 130, FALSE, 16, 1),
  ('Main Terminal', 'Checkpoint B (Gates B40–B60)',      -77.4548, 38.9530, 130, FALSE, 16, 2),
  ('Main Terminal', 'Checkpoint C/D (Gates C1–D40)',     -77.4535, 38.9522, 130, FALSE, 18, 3),
  ('Main Terminal', 'International Checkpoint (Z)',      -77.4520, 38.9515, 140, FALSE, 22, 4)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── PHL — Philadelphia ─────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'PHL')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal A-West', 'A-West Checkpoint (Gates A1–A23)',   -75.2402, 39.8762, 130, FALSE, 14, 1),
  ('Terminal B/C',    'B/C Main Checkpoint (Gates B4–C30)', -75.2418, 39.8752, 130, FALSE, 16, 2),
  ('Terminal D/E',    'D/E Checkpoint (Gates D1–E10)',      -75.2435, 39.8742, 130, FALSE, 16, 3),
  ('Terminal F',      'F Checkpoint (Gates F1–F38)',        -75.2450, 39.8730, 120, FALSE, 18, 4)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── DTW — Detroit Metro ────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'DTW')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('McNamara Terminal', 'North Checkpoint (Gates A1–A75)',  -83.3535, 42.2148, 140, FALSE, 18, 1),
  ('McNamara Terminal', 'South Checkpoint (Gates B1–B35)', -83.3528, 42.2140, 130, FALSE, 16, 2),
  ('North Terminal',    'Smith Terminal Checkpoint',        -83.3618, 42.2200, 120, FALSE, 14, 3)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── FLL — Fort Lauderdale ─────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'FLL')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal 1', 'Terminal 1 Security (Gates 1–12)',   -80.1555, 26.0718, 120, FALSE, 12, 1),
  ('Terminal 2', 'Terminal 2 Security (Gates 13–20)',  -80.1538, 26.0724, 120, FALSE, 12, 2),
  ('Terminal 3', 'Terminal 3 Security (Gates 21–28)',  -80.1520, 26.0730, 120, FALSE, 12, 3),
  ('Terminal 4', 'Terminal 4 Security (Gates 29–33)',  -80.1502, 26.0736, 110, FALSE, 14, 4)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── BNA — Nashville ───────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'BNA')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Concourse A', 'Concourse A Security (Gates A1–A25)',    -86.6788, 36.1258, 120, FALSE, 12, 1),
  ('Concourse B', 'Concourse B/C Security (Gates B1–C18)',  -86.6772, 36.1265, 130, FALSE, 14, 2),
  ('Concourse D', 'Concourse D Security (Gates D1–D15)',    -86.6758, 36.1272, 120, FALSE, 16, 3)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── AUS — Austin-Bergstrom ─────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'AUS')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Barbara Jordan Terminal', 'North Security Checkpoint',  -97.6712, 30.1952, 130, FALSE, 14, 1),
  ('Barbara Jordan Terminal', 'South Security Checkpoint',  -97.6698, 30.1938, 130, FALSE, 14, 2)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── PDX — Portland ─────────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'PDX')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Main Terminal', 'Checkpoint A/B (Gates A1–B15)',  -122.5965, 45.5892, 130, FALSE, 14, 1),
  ('Main Terminal', 'Checkpoint C/D (Gates C1–D15)',  -122.5948, 45.5904, 130, FALSE, 14, 2)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── SLC — Salt Lake City ───────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'SLC')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal MAIN', 'North Checkpoint (Gates A1–A22)',   -111.9805, 40.7908, 130, FALSE, 16, 1),
  ('Terminal MAIN', 'Central Checkpoint (Gates B1–B22)', -111.9795, 40.7900, 130, FALSE, 16, 2),
  ('Terminal MAIN', 'South Checkpoint (Gates C1–C22)',   -111.9782, 40.7892, 130, FALSE, 16, 3)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── SJC — San Jose ─────────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'SJC')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal A', 'Terminal A Security (Gates 1–14)',   -121.9302, 37.3622, 120, FALSE, 12, 1),
  ('Terminal B', 'Terminal B Security (Gates 20–31)',  -121.9278, 37.3630, 120, FALSE, 12, 2)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── RDU — Raleigh-Durham ──────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'RDU')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal 1', 'Terminal 1 Security (Gates A1–A19)',     -78.7895, 35.8808, 120, FALSE, 14, 1),
  ('Terminal 2', 'Terminal 2 Security (Gates B1–D14)',     -78.7868, 35.8795, 130, FALSE, 16, 2)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── MCI — Kansas City ─────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'MCI')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal MAIN', 'North Checkpoint (Gates A1–A30)',  -94.7145, 39.2982, 130, FALSE, 14, 1),
  ('Terminal MAIN', 'South Checkpoint (Gates B1–B28)', -94.7128, 39.2970, 130, FALSE, 14, 2)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;
