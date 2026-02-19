-- ============================================================
-- SwiftClear — Migration 003: Seed Major US Airports
-- ============================================================

-- Airports
INSERT INTO airports (iata_code, icao_code, name, city, country_code, location, timezone)
VALUES
  ('ATL', 'KATL', 'Hartsfield-Jackson Atlanta Intl',  'Atlanta',       'US', ST_MakePoint(-84.4277, 33.6407)::GEOGRAPHY, 'America/New_York'),
  ('LAX', 'KLAX', 'Los Angeles Intl',                  'Los Angeles',   'US', ST_MakePoint(-118.4085, 33.9425)::GEOGRAPHY, 'America/Los_Angeles'),
  ('ORD', 'KORD', 'O''Hare Intl',                      'Chicago',       'US', ST_MakePoint(-87.9073, 41.9742)::GEOGRAPHY, 'America/Chicago'),
  ('DFW', 'KDFW', 'Dallas/Fort Worth Intl',            'Dallas',        'US', ST_MakePoint(-97.0403, 32.8998)::GEOGRAPHY, 'America/Chicago'),
  ('DEN', 'KDEN', 'Denver Intl',                       'Denver',        'US', ST_MakePoint(-104.6737, 39.8561)::GEOGRAPHY, 'America/Denver'),
  ('JFK', 'KJFK', 'John F. Kennedy Intl',              'New York',      'US', ST_MakePoint(-73.7789, 40.6413)::GEOGRAPHY, 'America/New_York'),
  ('SFO', 'KSFO', 'San Francisco Intl',                'San Francisco', 'US', ST_MakePoint(-122.3789, 37.6213)::GEOGRAPHY, 'America/Los_Angeles'),
  ('LAS', 'KLAS', 'Harry Reid Intl',                   'Las Vegas',     'US', ST_MakePoint(-115.1523, 36.0840)::GEOGRAPHY, 'America/Los_Angeles'),
  ('SEA', 'KSEA', 'Seattle-Tacoma Intl',               'Seattle',       'US', ST_MakePoint(-122.3088, 47.4502)::GEOGRAPHY, 'America/Los_Angeles'),
  ('MCO', 'KMCO', 'Orlando Intl',                      'Orlando',       'US', ST_MakePoint(-81.3090, 28.4312)::GEOGRAPHY, 'America/New_York')
ON CONFLICT (iata_code) DO NOTHING;

-- ATL Terminals — abbreviated sample (real geofences would be loaded from GeoJSON)
-- ST_Buffer produces a rough circular polygon at ~100m radius
WITH atl AS (SELECT id FROM airports WHERE iata_code = 'ATL')
INSERT INTO terminals (airport_id, terminal_code, checkpoint_name, geofence, is_precheck, walk_to_gate_avg_minutes)
SELECT
  atl.id,
  tc.terminal_code,
  tc.checkpoint_name,
  ST_Buffer(ST_MakePoint(tc.lng, tc.lat)::GEOGRAPHY, tc.radius_m)::GEOGRAPHY,
  tc.is_precheck,
  tc.walk_mins
FROM atl, (VALUES
  ('T-South', 'South Security — Domestic',      -84.4300, 33.6380, 120, FALSE, 14),
  ('T-South', 'South Security — TSA PreCheck',  -84.4295, 33.6382, 80,  TRUE,  10),
  ('T-North', 'North Security — Domestic',      -84.4265, 33.6430, 120, FALSE, 18),
  ('T-North', 'North Security — TSA PreCheck',  -84.4262, 33.6433, 80,  TRUE,  12),
  ('T-Intl',  'International Terminal',          -84.4310, 33.6360, 150, FALSE, 22)
) AS tc(terminal_code, checkpoint_name, lng, lat, radius_m, is_precheck, walk_mins)
ON CONFLICT DO NOTHING;
