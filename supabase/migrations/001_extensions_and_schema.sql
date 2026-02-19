-- ============================================================
-- SwiftClear — Migration 001: Extensions + Core Schema
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- fuzzy search on airport names

-- ============================================================
-- airports
-- ============================================================
CREATE TABLE airports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  iata_code     TEXT UNIQUE NOT NULL,
  icao_code     TEXT UNIQUE,
  name          TEXT NOT NULL,
  city          TEXT NOT NULL,
  country_code  CHAR(2) NOT NULL DEFAULT 'US',
  location      GEOGRAPHY(POINT, 4326) NOT NULL,
  timezone      TEXT NOT NULL,  -- IANA tz, e.g. "America/New_York"
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX airports_location_idx   ON airports USING GIST(location);
CREATE INDEX airports_iata_code_idx  ON airports (iata_code);
CREATE INDEX airports_name_trgm_idx  ON airports USING GIN(name gin_trgm_ops);

-- ============================================================
-- terminals — each physical checkpoint within an airport
-- ============================================================
CREATE TABLE terminals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  airport_id       UUID NOT NULL REFERENCES airports(id) ON DELETE CASCADE,
  terminal_code    TEXT NOT NULL,          -- e.g. "A", "B", "International"
  checkpoint_name  TEXT NOT NULL,          -- e.g. "North Security", "PreCheck Lane"
  geofence         GEOGRAPHY(POLYGON, 4326) NOT NULL, -- 50–200m radius polygon
  is_precheck      BOOLEAN NOT NULL DEFAULT FALSE,
  walk_to_gate_avg_minutes SMALLINT NOT NULL DEFAULT 12,
  display_order    SMALLINT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (airport_id, terminal_code, checkpoint_name)
);

CREATE INDEX terminals_airport_id_idx ON terminals (airport_id);
CREATE INDEX terminals_geofence_idx   ON terminals USING GIST(geofence);

-- ============================================================
-- wait_time_snapshots — merged official + crowd aggregate
-- Written by the backend trust engine, consumed by clients
-- ============================================================
CREATE TABLE wait_time_snapshots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  terminal_id       UUID NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
  source            TEXT NOT NULL CHECK (source IN ('tsa_official', 'crowd_aggregate', 'hybrid')),
  wait_minutes      SMALLINT NOT NULL CHECK (wait_minutes >= 0 AND wait_minutes <= 240),
  confidence_score  REAL NOT NULL CHECK (confidence_score BETWEEN 0 AND 1),
  sample_size       SMALLINT NOT NULL DEFAULT 0,
  tsa_raw_minutes   SMALLINT,             -- NULL when no TSA API data
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Keep only latest 500 snapshots per terminal (via trigger below)
CREATE INDEX wait_time_snapshots_terminal_captured_idx
  ON wait_time_snapshots (terminal_id, captured_at DESC);

-- ============================================================
-- live_checks — user-submitted crowdsourced reports
-- ============================================================
CREATE TABLE live_checks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  terminal_id     UUID NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wait_minutes    SMALLINT NOT NULL CHECK (wait_minutes >= 0 AND wait_minutes <= 240),
  user_location   GEOGRAPHY(POINT, 4326),  -- NULL if user denied location
  is_geofenced    BOOLEAN NOT NULL DEFAULT FALSE, -- set by backend, not client
  trust_weight    REAL NOT NULL DEFAULT 1.0,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '45 minutes'
);

CREATE INDEX live_checks_terminal_expires_idx
  ON live_checks (terminal_id, expires_at DESC);
CREATE INDEX live_checks_user_id_idx
  ON live_checks (user_id, submitted_at DESC);

-- ============================================================
-- user_trust_profiles — reputation ledger
-- ============================================================
CREATE TABLE user_trust_profiles (
  user_id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  reputation_score REAL NOT NULL DEFAULT 1.0 CHECK (reputation_score BETWEEN 0 AND 5),
  total_checks     INTEGER NOT NULL DEFAULT 0,
  accurate_checks  INTEGER NOT NULL DEFAULT 0,
  flagged_checks   INTEGER NOT NULL DEFAULT 0,
  last_check_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-create profile on user sign-up
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.user_trust_profiles (user_id)
  VALUES (NEW.id)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================
-- Geofence helper: is a point inside a terminal's geofence?
-- ============================================================
CREATE OR REPLACE FUNCTION is_point_in_terminal_geofence(
  p_terminal_id UUID,
  p_lng         DOUBLE PRECISION,
  p_lat         DOUBLE PRECISION
)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM terminals t
    WHERE t.id = p_terminal_id
      AND ST_Within(
            ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::GEOMETRY,
            t.geofence::GEOMETRY
          )
  );
$$;

-- ============================================================
-- Purge expired live_checks automatically (keep DB lean)
-- ============================================================
CREATE OR REPLACE FUNCTION purge_expired_checks()
RETURNS void LANGUAGE sql AS $$
  DELETE FROM live_checks WHERE expires_at < NOW();
$$;
