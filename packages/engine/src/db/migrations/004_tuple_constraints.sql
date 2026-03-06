-- Migration 004: Add non-empty CHECK constraints to tuples table
-- Fixes: M3 — empty strings could be inserted via direct DB access
--
-- Run against your live DB:
--   psql $DATABASE_URL -f 004_tuple_constraints.sql
--
-- Safe to run multiple times (IF NOT EXISTS pattern via DO block).

DO $$
BEGIN

  -- Prevent empty subject
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_tuples_subject_nonempty'
  ) THEN
    ALTER TABLE tuples
      ADD CONSTRAINT chk_tuples_subject_nonempty CHECK (subject <> '');
  END IF;

  -- Prevent empty relation
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_tuples_relation_nonempty'
  ) THEN
    ALTER TABLE tuples
      ADD CONSTRAINT chk_tuples_relation_nonempty CHECK (relation <> '');
  END IF;

  -- Prevent empty object
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_tuples_object_nonempty'
  ) THEN
    ALTER TABLE tuples
      ADD CONSTRAINT chk_tuples_object_nonempty CHECK (object <> '');
  END IF;

END $$;
