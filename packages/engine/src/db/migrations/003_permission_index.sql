-- Migration 003: Permission Index
-- Materialised lookup table for O(1) permission checks.
-- Pre-computes implied permissions from tuples so most can() calls
-- hit the index before ever reaching BFS.
--
-- Run: psql $DATABASE_URL -f packages/engine/src/db/migrations/003_permission_index.sql

-- ─── Permission Index ─────────────────────────────────────────────────────────
-- Each row means: for this tenant, subject can perform action on object.
-- granted_by tracks which tuple caused this entry (for clean deletion).

CREATE TABLE IF NOT EXISTS permission_index (
  tenant_id   UUID    NOT NULL,
  subject     TEXT    NOT NULL,
  action      TEXT    NOT NULL,
  object      TEXT    NOT NULL,
  granted_by  TEXT    NOT NULL,  -- "{subject}|{relation}|{object}" of the source tuple
  PRIMARY KEY (tenant_id, subject, action, object)
);

-- NOTE: idx_perm_lookup was removed — it indexed (tenant_id, subject, action, object)
-- which is IDENTICAL to the PRIMARY KEY. PostgreSQL automatically creates a B-tree index
-- for every PRIMARY KEY, so this was an exact duplicate costing double the write I/O.
-- The primary lookup (can this subject do this action on this object?) is served by the PK.

-- Cleanup: remove all entries derived from a specific tuple when it's deleted.
-- Indexes (tenant_id, granted_by) — different columns from the PK, not redundant.
CREATE INDEX IF NOT EXISTS idx_perm_granted_by
  ON permission_index (tenant_id, granted_by);
