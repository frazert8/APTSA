-- ============================================================
-- SwiftClear — Migration 002: Row Level Security Policies
-- ============================================================

ALTER TABLE airports               ENABLE ROW LEVEL SECURITY;
ALTER TABLE terminals              ENABLE ROW LEVEL SECURITY;
ALTER TABLE wait_time_snapshots    ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_checks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_trust_profiles    ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- airports: public read, no writes from client
-- ------------------------------------------------------------
CREATE POLICY "airports_public_read"
  ON airports FOR SELECT USING (true);

-- ------------------------------------------------------------
-- terminals: public read, no writes from client
-- ------------------------------------------------------------
CREATE POLICY "terminals_public_read"
  ON terminals FOR SELECT USING (true);

-- ------------------------------------------------------------
-- wait_time_snapshots: public read, service-role write only
-- ------------------------------------------------------------
CREATE POLICY "snapshots_public_read"
  ON wait_time_snapshots FOR SELECT USING (true);

-- Only the service role (backend) may insert snapshots
CREATE POLICY "snapshots_service_insert"
  ON wait_time_snapshots FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- live_checks: authenticated users read all, insert own only
-- ------------------------------------------------------------
CREATE POLICY "live_checks_authenticated_read"
  ON live_checks FOR SELECT
  USING (auth.role() IN ('authenticated', 'service_role'));

CREATE POLICY "live_checks_own_insert"
  ON live_checks FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated'
    AND auth.uid() = user_id
    -- Rate limit: max 1 check per terminal per 15 minutes
    AND NOT EXISTS (
      SELECT 1 FROM live_checks lc
      WHERE lc.user_id = auth.uid()
        AND lc.terminal_id = terminal_id
        AND lc.submitted_at > NOW() - INTERVAL '15 minutes'
    )
  );

-- Users may delete their own checks
CREATE POLICY "live_checks_own_delete"
  ON live_checks FOR DELETE
  USING (auth.uid() = user_id);

-- Service role can update trust_weight and is_geofenced fields
CREATE POLICY "live_checks_service_update"
  ON live_checks FOR UPDATE
  USING (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- user_trust_profiles: users read their own, service writes all
-- ------------------------------------------------------------
CREATE POLICY "trust_profile_own_read"
  ON user_trust_profiles FOR SELECT
  USING (auth.uid() = user_id OR auth.role() = 'service_role');

CREATE POLICY "trust_profile_service_upsert"
  ON user_trust_profiles FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- Realtime Publications
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE wait_time_snapshots;
ALTER PUBLICATION supabase_realtime ADD TABLE live_checks;
