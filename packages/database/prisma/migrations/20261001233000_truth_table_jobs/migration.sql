-- Background truth-table jobs (phase 10).
--
-- A job is a simulation run of kind 'truth_table': queued, running, then succeeded, failed or
-- cancelled. The table was designed for that in phase 5 (row_offset, row_limit, and the statuses),
-- so jobs need no new columns. The rows a job computes are not stored here: they are kept in Redis
-- for a day, and can always be computed again from the circuit.
--
-- What is new is a question asked whenever someone starts a job: "which jobs has this user
-- started lately?" It sets their allowance (2 unfinished, 20 a day) and finds an identical
-- unfinished job to hand back instead of starting another. The index on (user_id, created_at)
-- would answer it while also reading every simulation the user ran; this one is partial, so it
-- holds only jobs, however many simulations there are.

CREATE INDEX simulation_runs_user_jobs_idx ON simulation_runs (user_id, created_at DESC) WHERE kind = 'truth_table';
