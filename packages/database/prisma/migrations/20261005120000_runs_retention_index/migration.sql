-- Retention for the history (docs/system-design.md, stage 1).
--
-- Housekeeping deletes finished runs older than RUN_RETENTION_DAYS, oldest first, a batch at a
-- time (queries.sql: delete_old_runs). Every batch asks "which are the oldest finished runs?",
-- across all circuits and users. None of the existing indexes starts with created_at alone, so
-- without this one each batch would read the whole table, and the table is the one that grows
-- without end (about 360 bytes a row). With it, a batch reads only the rows it deletes.
--
-- A plain B-tree on a column that only ever grows costs little to keep: new rows land at its
-- right-hand edge.

CREATE INDEX simulation_runs_created_idx ON simulation_runs (created_at);
