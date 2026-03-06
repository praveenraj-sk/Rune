exports.up = (pgm) => { pgm.sql(`
-- Rune Database Schema — Phase 1
-- Run once: psql $DATABASE_URL -f schema.sql
-- Uses IF NOT EXISTS on all objects so it's safe to re-run.

-- ─── 1. Tuple Store ───────────────────────────────────────────────────────────
-- Stores every relationship: "user:raj is member of group:billing"
-- This is the ONLY source of truth for permissions.

CREATE TABLE IF NOT EXISTS tuples (
  tenant_id   UUID        NOT NULL,
  subject     TEXT        NOT NULL,
  relation    TEXT        NOT NULL,
  object      TEXT        NOT NULL,
  lvn         BIGINT      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject, relation, object),
  -- Prevent empty strings from slipping in via direct DB access / migrations.
  -- Application layer also validates these, but DB constraints are the last line.
  -- NOTE: relation is intentionally unconstrained to a fixed enum — relations
  -- are config-driven per tenant (rune.config.yml) and vary across deployments.
  CONSTRAINT chk_tuples_subject_nonempty CHECK (subject  <> ''),
  CONSTRAINT chk_tuples_relation_nonempty CHECK (relation <> ''),
  CONSTRAINT chk_tuples_object_nonempty  CHECK (object   <> '')
);

-- Forward lookup: "what can this subject access?"
CREATE INDEX IF NOT EXISTS idx_tuples_tenant   ON tuples (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tuples_subject  ON tuples (tenant_id, subject);

-- Reverse lookup: "who can access this object?" — used by buildSuggestedFix
CREATE INDEX IF NOT EXISTS idx_tuples_object          ON tuples (tenant_id, object);
CREATE INDEX IF NOT EXISTS idx_tuples_relation_object ON tuples (tenant_id, relation, object);

-- ─── 2. LVN Sequence ─────────────────────────────────────────────────────────
-- Logical Version Number — increments on every write.
-- Used to detect cache staleness via the SCT token.
-- Phase 1: one global sequence. Phase 2: partitioned per region.

CREATE SEQUENCE IF NOT EXISTS lvn_seq START 1 INCREMENT 1;

-- ─── 3. Schema Definitions ────────────────────────────────────────────────────
-- Stores the policy DSL (what relations mean, what actions are allowed).
-- Phase 1: not fully wired up — placeholder for Phase 2 policy engine.

CREATE TABLE IF NOT EXISTS schemas (
  tenant_id   UUID        NOT NULL,
  version     INTEGER     NOT NULL,
  dsl_body    TEXT        NOT NULL,
  status      TEXT        NOT NULL CHECK (status IN ('active','shadow','deprecated')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version)
);

-- ─── 4. Decision Logs ────────────────────────────────────────────────────────
-- Append-only audit log of every can() call.
-- NEVER update or delete rows — immutable audit trail.

CREATE TABLE IF NOT EXISTS decision_logs (
  id            UUID        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     UUID        NOT NULL,
  subject       TEXT        NOT NULL,
  action        TEXT        NOT NULL,
  object        TEXT        NOT NULL,
  decision      TEXT        NOT NULL CHECK (decision IN ('allow','deny')),
  status        TEXT        NOT NULL CHECK (status IN ('ALLOW','DENY','CHALLENGE','NOT_FOUND')),
  reason        TEXT,
  trace         JSONB,
  suggested_fix JSONB,
  lvn           BIGINT,
  latency_ms    NUMERIC,
  cache_hit     BOOLEAN     NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_logs_tenant  ON decision_logs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_logs_subject ON decision_logs (tenant_id, subject);
CREATE INDEX IF NOT EXISTS idx_logs_object  ON decision_logs (tenant_id, object);
-- Descending for the logs feed (most recent first)
CREATE INDEX IF NOT EXISTS idx_logs_created ON decision_logs (tenant_id, created_at DESC);

-- ─── 5. API Keys ─────────────────────────────────────────────────────────────
-- Hashed API keys for authenticating engine requests.
-- key_hash = SHA256(raw_key) — raw key is never stored.

CREATE TABLE IF NOT EXISTS api_keys (
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL,
  key_hash    TEXT        NOT NULL UNIQUE,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used   TIMESTAMPTZ,
  PRIMARY KEY (id)
);

-- ─── 6. Permission Index ──────────────────────────────────────────────────────
-- Materialised O(1) lookup table — pre-computes implied permissions from tuples.
-- Most can() calls hit this before ever reaching the BFS graph traversal.
-- Each row means: for this tenant, subject CAN perform action ON object.
-- granted_by tracks which source tuple caused this entry (for clean deletion).
--
-- NOTE: The PRIMARY KEY on (tenant_id, subject, action, object) already creates
-- a B-tree index covering the primary lookup. A separate idx_perm_lookup on the
-- same four columns would be an exact duplicate and is intentionally omitted here.

CREATE TABLE IF NOT EXISTS permission_index (
  tenant_id   UUID    NOT NULL,
  subject     TEXT    NOT NULL,
  action      TEXT    NOT NULL,
  object      TEXT    NOT NULL,
  granted_by  TEXT    NOT NULL,  -- "{subject}|{relation}|{object}" of the source tuple
  PRIMARY KEY (tenant_id, subject, action, object)
);

-- Cleanup index: find and remove all index entries derived from a specific tuple
-- when that tuple is deleted. Different columns from the PRIMARY KEY — not redundant.
CREATE INDEX IF NOT EXISTS idx_perm_granted_by
  ON permission_index (tenant_id, granted_by);
`); };
exports.down = (pgm) => { pgm.sql(`DROP TABLE IF EXISTS permission_index, api_keys, decision_logs, schemas, tuples; DROP SEQUENCE IF EXISTS lvn_seq;`); };
