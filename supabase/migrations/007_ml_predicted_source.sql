-- ============================================================
-- SwiftClear — Migration 007: Add ml_predicted source
-- Expands the wait_time_snapshots.source CHECK constraint to
-- allow 'ml_predicted' for rows computed by the ML predictor.
-- ============================================================

ALTER TABLE wait_time_snapshots
  DROP CONSTRAINT IF EXISTS wait_time_snapshots_source_check;

ALTER TABLE wait_time_snapshots
  ADD CONSTRAINT wait_time_snapshots_source_check
  CHECK (source IN ('tsa_official', 'crowd_aggregate', 'hybrid', 'ml_predicted'));

-- Index to support the ML predictor's historical queries:
-- fetch non-zero snapshots for a terminal ordered by time
CREATE INDEX IF NOT EXISTS wait_time_snapshots_ml_idx
  ON wait_time_snapshots (terminal_id, captured_at DESC)
  WHERE wait_minutes > 0;
