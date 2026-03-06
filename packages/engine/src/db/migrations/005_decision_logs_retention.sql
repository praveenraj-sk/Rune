-- Migration 005: Decision Logs Retention
-- Prevents the decision_logs table from growing unbounded.
--
-- At 1,000 req/sec, this table grows by 86 million rows per day.
-- Without cleanup, queries slow down and disk fills up within weeks.
--
-- This migration adds:
-- 1. A composite index for fast date-range queries + cleanup
-- 2. A reusable cleanup function that deletes rows older than N days
--
-- HOW TO USE:
--   Schedule this daily via cron, Render Cron Job, or pg_cron:
--     SELECT cleanup_old_decision_logs(90);  -- keep last 90 days
--
-- Run: psql $DATABASE_URL -f 005_decision_logs_retention.sql

-- ─── Index for fast date-range scans ─────────────────────────────────────────
-- Used by: GET /v1/logs (recent logs), stats aggregation, cleanup function.
-- Descending so "most recent first" queries use the index naturally.
CREATE INDEX IF NOT EXISTS idx_logs_tenant_created
    ON decision_logs (tenant_id, created_at DESC);

-- ─── Cleanup function ────────────────────────────────────────────────────────
-- Deletes decision_logs older than `retention_days`.
-- Batches deletes in chunks of 10,000 to avoid long locks.
-- Returns the total number of rows deleted.
--
-- Example: SELECT cleanup_old_decision_logs(90);

CREATE OR REPLACE FUNCTION cleanup_old_decision_logs(retention_days INTEGER DEFAULT 90)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    cutoff     TIMESTAMPTZ := now() - (retention_days || ' days')::INTERVAL;
    batch_size INTEGER     := 10000;
    deleted    BIGINT      := 0;
    batch      BIGINT;
BEGIN
    LOOP
        DELETE FROM decision_logs
        WHERE id IN (
            SELECT id FROM decision_logs
            WHERE created_at < cutoff
            LIMIT batch_size
        );

        GET DIAGNOSTICS batch = ROW_COUNT;
        deleted := deleted + batch;

        -- Exit when no more rows to delete
        EXIT WHEN batch = 0;

        -- Brief pause between batches to reduce lock contention
        PERFORM pg_sleep(0.1);
    END LOOP;

    RETURN deleted;
END;
$$;
