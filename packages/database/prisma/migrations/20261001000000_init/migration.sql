-- CircuitLab database schema, for PostgreSQL 18: the first migration.
--
-- Written by hand (phase 5) rather than generated, because Prisma's schema language can't express
-- CHECK constraints, partial indexes, or collations. prisma/schema.prisma describes the same
-- tables for Prisma Client, and `npm run db:check` verifies that the two agree.
--
-- Design notes: docs/database-design.md. `npm run db:check` also applies this file to a real
-- (embedded) PostgreSQL and tests every constraint and index below.
--
-- Rule of thumb: the database guarantees that stored data is well-formed and consistent, using
-- keys, foreign keys, and CHECK constraints that look at one row. Rules about a circuit as a whole
-- (pin counts per gate type, unconnected pins, feedback loops) stay in the engine, which
-- validates every circuit before it is written.

CREATE EXTENSION IF NOT EXISTS pg_trgm; -- trigram indexes, for searching circuit names

CREATE TYPE gate_type AS ENUM ('INPUT', 'OUTPUT', 'CONST', 'BUF', 'NOT', 'AND', 'OR', 'NAND', 'NOR', 'XOR', 'XNOR');
CREATE TYPE run_kind AS ENUM ('simulate', 'truth_table');
CREATE TYPE run_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');


-- users ----------------------------------------------------------------------------------------
-- Accounts. Logging in arrives in phase 7; the table exists now so circuits and runs can refer to it.

CREATE TABLE users (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  email         text        NOT NULL,
  display_name  text        NOT NULL,
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Stored in lower case, so a plain unique constraint means one account per address.
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_email_format CHECK (
    email = lower(email) AND char_length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  ),
  CONSTRAINT users_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 100),
  -- Only an Argon2id hash fits here, never a password in plain text.
  CONSTRAINT users_password_hash_format CHECK (password_hash ~ '^\$argon2id\$')
);


-- circuits -------------------------------------------------------------------------------------
-- One row per circuit, holding its current version. Gates and wires are in their own tables.

CREATE TABLE circuits (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),
  owner_id      uuid        REFERENCES users (id) ON DELETE CASCADE, -- NULL until accounts exist (phase 7)
  -- "C" collation: names sort by character code, the same order the API's cursors assume.
  name          text        COLLATE "C" NOT NULL,
  description   text,
  -- Starts at 1, +1 on every change. Writes say which version they expect (optimistic locking),
  -- and the API's ETags are this number.
  version       integer     NOT NULL DEFAULT 1,

  -- Summary of the circuit, computed by the engine and written in the same transaction as the
  -- gates and wires. Derived data, kept here so a list page reads only this table.
  gate_count    integer     NOT NULL,
  wire_count    integer     NOT NULL,
  input_keys    text[]      NOT NULL, -- INPUT gate keys, in position order
  output_keys   text[]      NOT NULL, -- OUTPUT gate keys, in position order
  feedback_loop text[],               -- a loop of gate keys, first repeated at the end; NULL if none

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT circuits_name_valid CHECK (char_length(name) BETWEEN 1 AND 200 AND name ~ '\S'),
  CONSTRAINT circuits_description_length CHECK (char_length(description) <= 2000),
  CONSTRAINT circuits_version_positive CHECK (version >= 1),
  CONSTRAINT circuits_counts_valid CHECK (gate_count BETWEEN 0 AND 10000 AND wire_count BETWEEN 0 AND 50000),
  CONSTRAINT circuits_feedback_loop_closed CHECK (feedback_loop IS NULL OR cardinality(feedback_loop) >= 2)
);

-- One index per list order, for cursor (keyset) pagination: "the rows after (value, id) in this
-- order" is a single index lookup, however deep the page. Scanned backwards for newest-first.
CREATE INDEX circuits_created_at_id_idx ON circuits (created_at, id);
CREATE INDEX circuits_updated_at_id_idx ON circuits (updated_at, id);
CREATE INDEX circuits_name_id_idx ON circuits (name, id);
-- Name search, `name ILIKE '%adder%'`: a B-tree can't help with a leading wildcard; a trigram
-- index can.
CREATE INDEX circuits_name_trgm_idx ON circuits USING gin (name gin_trgm_ops);
-- A user's circuits (phase 7), and deleting a user (the foreign key).
CREATE INDEX circuits_owner_id_idx ON circuits (owner_id);


-- gates ----------------------------------------------------------------------------------------

CREATE TABLE gates (
  circuit_id  uuid      NOT NULL REFERENCES circuits (id) ON DELETE CASCADE,
  key         text      COLLATE "C" NOT NULL, -- the gate's id in the API and netlists, e.g. "A" or "sum[3]"
  -- Declaration order. It matters: it orders a truth table's columns, breaks ties in evaluation
  -- order, and makes the API return a circuit exactly as it was sent.
  position    integer   NOT NULL,
  type        gate_type NOT NULL,
  label       text,
  const_value smallint, -- CONST gates only

  -- Keys are unique within a circuit, and wires refer to gates by (circuit_id, key).
  PRIMARY KEY (circuit_id, key),
  CONSTRAINT gates_position_key UNIQUE (circuit_id, position),
  CONSTRAINT gates_key_format CHECK (char_length(key) <= 64 AND key ~ '^[A-Za-z0-9_][]A-Za-z0-9_.$[]*$'),
  CONSTRAINT gates_position_valid CHECK (position >= 0),
  CONSTRAINT gates_label_length CHECK (char_length(label) <= 200),
  -- A value exactly when the gate is a CONST, and then 0 or 1.
  CONSTRAINT gates_const_value CHECK ((type = 'CONST') = (const_value IS NOT NULL) AND const_value IN (0, 1))
);


-- wires ----------------------------------------------------------------------------------------

CREATE TABLE wires (
  circuit_id  uuid     NOT NULL,
  target_key  text     COLLATE "C" NOT NULL,
  target_pin  smallint NOT NULL,
  source_key  text     COLLATE "C" NOT NULL,
  position    integer  NOT NULL, -- order in the circuit's wire list
  key         text     COLLATE "C", -- the wire's optional id in the API

  -- One wire per input pin: "a pin driven by two wires" can't even be stored.
  PRIMARY KEY (circuit_id, target_key, target_pin),
  CONSTRAINT wires_position_key UNIQUE (circuit_id, position),
  CONSTRAINT wires_key_key UNIQUE (circuit_id, key), -- NULLs don't collide: unnamed wires are fine
  -- Implied by the two below, but stated directly so Prisma can load a circuit's wires with it.
  CONSTRAINT wires_circuit_id_fkey FOREIGN KEY (circuit_id) REFERENCES circuits (id) ON DELETE CASCADE,
  -- Both ends are gates of the *same* circuit: the circuit id is part of each foreign key.
  CONSTRAINT wires_source_fkey FOREIGN KEY (circuit_id, source_key)
    REFERENCES gates (circuit_id, key) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT wires_target_fkey FOREIGN KEY (circuit_id, target_key)
    REFERENCES gates (circuit_id, key) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT wires_pin_range CHECK (target_pin BETWEEN 0 AND 63),
  CONSTRAINT wires_position_valid CHECK (position >= 0),
  CONSTRAINT wires_key_format CHECK (char_length(key) <= 64 AND key ~ '^[A-Za-z0-9_][]A-Za-z0-9_.$[]*$')
);

-- The primary key serves lookups by target; this one serves lookups by source (fan-out), and
-- the source foreign key when a gate is deleted.
CREATE INDEX wires_source_idx ON wires (circuit_id, source_key);


-- simulation_runs ------------------------------------------------------------------------------
-- A history of simulations: what was asked of which version of which circuit, and how it ended.
-- The statuses cover background jobs too (queued, running), which arrive with BullMQ in phase 10.

CREATE TABLE simulation_runs (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  circuit_id      uuid        NOT NULL REFERENCES circuits (id) ON DELETE CASCADE,
  circuit_version integer     NOT NULL, -- circuits keep only their latest version; this says which one ran
  user_id         uuid        REFERENCES users (id) ON DELETE SET NULL, -- who asked (phase 7)
  kind            run_kind    NOT NULL,
  status          run_status  NOT NULL,

  inputs          jsonb,       -- simulate: the input values, e.g. {"A": 1, "B": 0}
  row_offset      bigint,      -- truth_table: which rows
  row_limit       integer,
  outputs         jsonb,       -- simulate, once succeeded: e.g. {"S": 0, "C": 1}
  error_code      text,        -- once failed: the API's problem code, e.g. "invalid-inputs"

  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,

  CONSTRAINT simulation_runs_version_positive CHECK (circuit_version >= 1),
  -- Each kind of run has its own fields.
  --
  -- A CHECK only rejects a row when its condition is false, and any comparison with NULL is
  -- neither true nor false. So every "must be present" below says IS NOT NULL explicitly: written
  -- as `row_offset >= 0` alone, a missing row_offset would slip through.
  CONSTRAINT simulation_runs_kind_fields CHECK (
    CASE kind
      WHEN 'simulate' THEN inputs IS NOT NULL AND jsonb_typeof(inputs) = 'object' AND row_offset IS NULL AND row_limit IS NULL
      WHEN 'truth_table' THEN inputs IS NULL AND outputs IS NULL
        AND row_offset IS NOT NULL AND row_offset >= 0 AND row_limit IS NOT NULL AND row_limit >= 1
    END
  ),
  -- Each status says which timestamps and results exist.
  CONSTRAINT simulation_runs_status_fields CHECK (
    CASE status
      WHEN 'queued' THEN started_at IS NULL AND finished_at IS NULL AND outputs IS NULL AND error_code IS NULL
      WHEN 'running' THEN started_at IS NOT NULL AND finished_at IS NULL AND outputs IS NULL AND error_code IS NULL
      WHEN 'succeeded' THEN started_at IS NOT NULL AND finished_at IS NOT NULL AND error_code IS NULL
        AND (kind <> 'simulate' OR (outputs IS NOT NULL AND jsonb_typeof(outputs) = 'object'))
      WHEN 'failed' THEN finished_at IS NOT NULL AND error_code IS NOT NULL AND outputs IS NULL
      WHEN 'cancelled' THEN finished_at IS NOT NULL AND outputs IS NULL
    END
  ),
  CONSTRAINT simulation_runs_finished_after_started CHECK (finished_at >= started_at)
);

-- A circuit's recent runs, and a user's (phase 7).
CREATE INDEX simulation_runs_circuit_idx ON simulation_runs (circuit_id, created_at DESC);
CREATE INDEX simulation_runs_user_idx ON simulation_runs (user_id, created_at DESC);
-- Runs still waiting or in progress: a small, partial index that stays small however long the
-- history grows (phase 10's background jobs).
CREATE INDEX simulation_runs_unfinished_idx ON simulation_runs (created_at) WHERE status IN ('queued', 'running');
