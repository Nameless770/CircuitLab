-- Simulation modes (phase 9): how each run was computed.
--
-- A combinational run evaluates every gate once. A sequential run lets feedback loops settle,
-- starting from a state the client sends, so its outputs depend on more than its inputs. The
-- history has to say which kind a run was. Every run recorded before this migration was
-- combinational, which is the column's default.

CREATE TYPE simulation_mode AS ENUM ('combinational', 'sequential');

ALTER TABLE simulation_runs
  ADD COLUMN mode simulation_mode NOT NULL DEFAULT 'combinational',
  -- A truth table lists every input combination of a circuit without memory: combinational only.
  ADD CONSTRAINT simulation_runs_truth_tables_combinational CHECK (kind = 'simulate' OR mode = 'combinational');
