-- ============================================================
-- SwiftClear — Migration 005: Reseed terminals with real TSA
-- checkpoint names sourced from tsawaittimes.com /checkpoints API
-- ============================================================

-- Clear all existing terminal data (snapshots + checks cascade)
TRUNCATE terminals RESTART IDENTITY CASCADE;

-- ── ATL — Hartsfield-Jackson ──────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'ATL')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal MAIN',  'Main Checkpoint',         -84.4300, 33.6380, 150, FALSE, 16, 1),
  ('Terminal FIS',   'Concourse E Checkpoint',  -84.4310, 33.6360, 150, FALSE, 22, 2),
  ('Terminal MHJIT', 'Concourse F Departure',   -84.4265, 33.6430, 150, FALSE, 18, 3)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── LAX — Los Angeles ─────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'LAX')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal TBIT',   'Tom Bradley Int''l Terminal', -118.4082, 33.9433, 150, FALSE, 20, 1),
  ('Terminal 1',      'Terminal 1 Checkpoint',       -118.4030, 33.9416, 120, FALSE, 14, 2),
  ('Terminal 2',      'Terminal 2 Checkpoint',       -118.4042, 33.9418, 120, FALSE, 14, 3),
  ('Terminal 3',      'Terminal 3 Checkpoint',       -118.4050, 33.9420, 120, FALSE, 14, 4),
  ('Terminal 4',      'Terminal 4A Checkpoint',      -118.4093, 33.9422, 120, FALSE, 14, 5),
  ('Terminal 5',      'Terminal 5 Checkpoint',       -118.4098, 33.9416, 120, FALSE, 14, 6),
  ('Terminal 6',      'Terminal 6 Checkpoint',       -118.4105, 33.9414, 120, FALSE, 14, 7),
  ('Terminal 7 8',    'Terminal 7 Checkpoint',       -118.4112, 33.9412, 120, FALSE, 14, 8)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── ORD — Chicago O'Hare ─────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'ORD')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal 1', 'Checkpoint 2',   -87.9068, 41.9783, 130, FALSE, 18, 1),
  ('Terminal 2', 'Checkpoint 5',   -87.9042, 41.9760, 120, FALSE, 16, 2),
  ('Terminal 3', 'Checkpoint 7A',  -87.9018, 41.9755, 120, FALSE, 16, 3),
  ('Terminal 3', 'Checkpoint 8',   -87.9015, 41.9752, 120, FALSE, 16, 4)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── DFW — Dallas/Fort Worth ───────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'DFW')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal A', 'Checkpoint A21', -97.0355, 32.8992, 120, FALSE, 14, 1),
  ('Terminal B', 'Checkpoint B9',  -97.0382, 32.8998, 120, FALSE, 14, 2),
  ('Terminal B', 'Checkpoint B30', -97.0385, 32.9000, 120, FALSE, 14, 3),
  ('Terminal C', 'Checkpoint C21', -97.0405, 32.9010, 120, FALSE, 16, 4),
  ('Terminal D', 'Checkpoint D30', -97.0430, 32.9010, 130, FALSE, 20, 5),
  ('Terminal E', 'Checkpoint E16', -97.0457, 32.8990, 120, FALSE, 16, 6)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── DEN — Denver ─────────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'DEN')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal MAIN', 'A Bridge Checkpoint', -104.6742, 39.8565, 130, FALSE, 22, 1),
  ('Terminal MAIN', 'North Checkpoint',    -104.6730, 39.8560, 130, FALSE, 18, 2),
  ('Terminal MAIN', 'South Checkpoint',    -104.6727, 39.8555, 130, FALSE, 18, 3)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── JFK — New York ────────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'JFK')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal 1', 'Terminal 1 Checkpoint',      -73.7905, 40.6435, 120, FALSE, 18, 1),
  ('Terminal 2', 'Terminal 2 Checkpoint',      -73.7882, 40.6428, 110, FALSE, 14, 2),
  ('Terminal 4', 'Terminal 4 Main Checkpoint', -73.7818, 40.6424, 130, FALSE, 18, 3),
  ('Terminal 5', 'Terminal 5 Main Checkpoint', -73.7795, 40.6418, 120, FALSE, 14, 4),
  ('Terminal 7', 'Terminal 7 Checkpoint',      -73.7772, 40.6412, 110, FALSE, 14, 5),
  ('Terminal 8', 'Terminal 8 Checkpoint',      -73.7755, 40.6407, 120, FALSE, 16, 6)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── SFO — San Francisco ───────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'SFO')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('International Terminal', 'Boarding Area A Checkpoint', -122.3760, 37.6148, 130, FALSE, 22, 1),
  ('International Terminal', 'Boarding Area G Checkpoint', -122.3768, 37.6152, 130, FALSE, 22, 2),
  ('Terminal 1',             'Boarding Area B Checkpoint', -122.3848, 37.6188, 120, FALSE, 16, 3),
  ('Terminal 1',             'Boarding Area C Checkpoint', -122.3840, 37.6184, 120, FALSE, 16, 4),
  ('Terminal 2',             'Boarding Area D Checkpoint', -122.3832, 37.6180, 120, FALSE, 14, 5),
  ('Terminal 3',             'Boarding Area F1 Checkpoint',-122.3820, 37.6175, 120, FALSE, 16, 6),
  ('Terminal 3',             'Boarding Area F3 Checkpoint',-122.3816, 37.6172, 120, FALSE, 16, 7)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── LAS — Las Vegas ───────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'LAS')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal 1', 'A/B Checkpoint', -115.1543, 36.0828, 130, FALSE, 16, 1),
  ('Terminal 1', 'C Checkpoint',   -115.1540, 36.0824, 120, FALSE, 16, 2),
  ('Terminal 1', 'CX Checkpoint',  -115.1537, 36.0820, 120, FALSE, 16, 3),
  ('Terminal 3', 'E Checkpoint',   -115.1496, 36.0842, 120, FALSE, 16, 4)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── SEA — Seattle-Tacoma ──────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'SEA')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal MAIN', 'Checkpoint 1',        -122.3100, 47.4490, 120, FALSE, 16, 1),
  ('Terminal MAIN', 'Checkpoint 3',        -122.3093, 47.4494, 120, FALSE, 16, 2),
  ('Terminal MAIN', 'Checkpoint 4',        -122.3088, 47.4500, 120, FALSE, 18, 3),
  ('Terminal MAIN', 'Offsite Checkpoint',  -122.3080, 47.4508, 100, FALSE, 20, 4)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── MCO — Orlando ─────────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'MCO')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal EAST', 'East Checkpoint', -81.3082, 28.4312, 130, FALSE, 16, 1),
  ('Terminal WEST', 'West Checkpoint', -81.3100, 28.4305, 130, FALSE, 16, 2)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── MIA — Miami ───────────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'MIA')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal NORTH', 'D Gates Checkpoint 2', -80.2882, 25.7968, 130, FALSE, 18, 1),
  ('Terminal NORTH', 'D Gates Checkpoint 3', -80.2879, 25.7965, 130, FALSE, 18, 2),
  ('Terminal SOUTH', 'H Gates Checkpoint',   -80.2858, 25.7950, 120, FALSE, 16, 3),
  ('Terminal SOUTH', 'JS Gates Checkpoint',  -80.2854, 25.7946, 120, FALSE, 16, 4)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── BOS — Boston Logan ────────────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'BOS')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal A',       'Gates A1-A22 Checkpoint',   -71.0065, 42.3660, 110, FALSE, 14, 1),
  ('Terminal B NORTH', 'Gates B20-B36 Checkpoint',  -71.0052, 42.3657, 110, FALSE, 14, 2),
  ('Terminal B SOUTH', 'Gates B4-B19 Checkpoint',   -71.0048, 42.3653, 110, FALSE, 14, 3),
  ('Terminal C',       'Gates C1-C36 Checkpoint',   -71.0040, 42.3660, 120, FALSE, 14, 4),
  ('Terminal C',       'Gates C40-C42 Checkpoint',  -71.0037, 42.3657, 110, FALSE, 14, 5),
  ('Terminal E',       'Gates E2A-E8B Checkpoint',  -71.0033, 42.3648, 120, FALSE, 18, 6)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── PHX — Phoenix Sky Harbor ──────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'PHX')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal 3', 'North Checkpoint', -112.0077, 33.4372, 120, FALSE, 16, 1),
  ('Terminal 4', 'Checkpoint A',     -112.0098, 33.4382, 130, FALSE, 18, 2),
  ('Terminal 4', 'Checkpoint B',     -112.0093, 33.4379, 130, FALSE, 18, 3),
  ('Terminal 4', 'Checkpoint C',     -112.0088, 33.4376, 130, FALSE, 18, 4),
  ('Terminal 4', 'Checkpoint D',     -112.0083, 33.4373, 130, FALSE, 18, 5)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── CLT — Charlotte Douglas ───────────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'CLT')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('Terminal MAIN', 'B Checkpoint', -80.9448, 35.2148, 130, FALSE, 14, 1),
  ('Terminal MAIN', 'D Checkpoint', -80.9435, 35.2140, 130, FALSE, 20, 2),
  ('Terminal MAIN', 'E Checkpoint', -80.9425, 35.2133, 120, FALSE, 16, 3)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;

-- ── MSP — Minneapolis-Saint Paul ─────────────────────────────
WITH ap AS (SELECT id FROM airports WHERE iata_code = 'MSP')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes, display_order)
SELECT ap.id, v.tc, v.cp,
  ST_Buffer(ST_MakePoint(v.lng, v.lat)::GEOGRAPHY, v.r)::GEOGRAPHY,
  v.pre, v.walk, v.ord
FROM ap, (VALUES
  ('North Checkpoint',   'North Checkpoint',       -93.2228, 44.8860, 130, FALSE, 18, 1),
  ('South Checkpoint',   'South Checkpoint',       -93.2228, 44.8845, 130, FALSE, 14, 2),
  ('Terminal HUMPHREY',  'Humphrey Checkpoint 1',  -93.2197, 44.8838, 120, FALSE, 16, 3)
) AS v(tc, cp, lng, lat, r, pre, walk, ord)
ON CONFLICT DO NOTHING;
