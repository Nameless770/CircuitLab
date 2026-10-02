-- The statements behind the API, one per access path, against the schema in prisma/migrations.
-- `npm run db:check` executes every one of them, so they are tested, not just documented. The API
-- (apps/api/src/storage) does the same through Prisma Client: the list queries exactly as written
-- here, through $queryRaw, and the rest through Prisma's query API, which issues equivalent SQL.
--
-- Each block starts with `-- name:`; parameters are $1, $2, ... as listed.


-- Reading circuits -----------------------------------------------------------------------------
-- Every list is one of three (the API's `scope`): the caller's own circuits, the circuits shared
-- with them, or the public ones. Each list order has an index for "owned" and one for "public";
-- a person's shared circuits are few enough to sort after the join.

-- name: list_owned
-- The first page of someone's circuits, newest first. $1: page size + 1 (an extra row means
-- "there is a next page", which saves counting); $2: the owner's id.
SELECT c.id, c.name, c.description, c.version, c.visibility, c.owner_id, u.display_name AS owner_name,
       c.gate_count, c.wire_count, c.input_keys, c.output_keys, c.feedback_loop, c.created_at, c.updated_at
FROM circuits AS c JOIN users AS u ON u.id = c.owner_id
WHERE c.owner_id = $2
ORDER BY c.created_at DESC, c.id DESC
LIMIT $1;

-- name: list_owned_after
-- The page after a cursor. $1: page size + 1; $2: owner id; $3, $4: the cursor (created_at and id
-- of the last circuit on the previous page). The row comparison matches the index (owner_id,
-- created_at, id), so this is one index lookup however deep the page, unlike OFFSET, which reads
-- and discards every earlier row.
SELECT c.id, c.name, c.version, c.created_at
FROM circuits AS c
WHERE c.owner_id = $2 AND (c.created_at, c.id) < ($3, $4)
ORDER BY c.created_at DESC, c.id DESC
LIMIT $1;

-- name: list_public_after
-- Public circuits, newest first, after a cursor. $1: page size + 1; $2, $3: the cursor. Served by
-- the partial index circuits_public_created_at_idx.
SELECT c.id, c.name, c.version, c.created_at
FROM circuits AS c
WHERE c.visibility = 'public' AND (c.created_at, c.id) < ($2, $3)
ORDER BY c.created_at DESC, c.id DESC
LIMIT $1;

-- name: list_public_by_name_after
-- The same pattern for sort=name (ascending): every sort order has its own index.
-- $1: page size + 1; $2, $3: the cursor (name and id).
SELECT c.id, c.name, c.version, c.created_at
FROM circuits AS c
WHERE c.visibility = 'public' AND (c.name, c.id) > ($2, $3)
ORDER BY c.name, c.id
LIMIT $1;

-- name: list_shared_with
-- Circuits other people have shared with $2, newest first. $1: page size + 1.
SELECT c.id, c.name, c.version, c.created_at, s.role
FROM circuit_shares AS s JOIN circuits AS c ON c.id = s.circuit_id
WHERE s.user_id = $2
ORDER BY c.created_at DESC, c.id DESC
LIMIT $1;

-- name: search_public_by_name
-- q=adder among public circuits. $1: page size + 1; $2: the search text. `%` and `_` in it are
-- escaped so they match themselves rather than acting as wildcards. Served by the trigram index.
SELECT c.id, c.name, c.version, c.created_at
FROM circuits AS c
WHERE c.visibility = 'public'
  AND c.name ILIKE '%' || replace(replace(replace($2, '\', '\\'), '%', '\%'), '_', '\_') || '%'
ORDER BY c.created_at DESC, c.id DESC
LIMIT $1;

-- name: access_of
-- What the API needs to decide what $2 (a user id, or NULL when signed out) may do with circuit
-- $1: its owner, its visibility, and the role it is shared with them, if any.
SELECT c.owner_id, c.visibility, s.role
FROM circuits AS c LEFT JOIN circuit_shares AS s ON s.circuit_id = c.id AND s.user_id = $2
WHERE c.id = $1;

-- name: get_circuit
-- $1: circuit id.
SELECT c.id, c.name, c.description, c.version, c.visibility, c.owner_id, u.display_name AS owner_name,
       c.gate_count, c.wire_count, c.input_keys, c.output_keys, c.feedback_loop, c.created_at, c.updated_at
FROM circuits AS c JOIN users AS u ON u.id = c.owner_id
WHERE c.id = $1;

-- name: get_gates
-- $1: circuit id. In declaration order, served by the (circuit_id, position) unique index.
SELECT key, type, label, const_value
FROM gates
WHERE circuit_id = $1
ORDER BY position;

-- name: get_wires
-- $1: circuit id.
SELECT source_key, target_key, target_pin, key
FROM wires
WHERE circuit_id = $1
ORDER BY position;


-- Writing circuits -----------------------------------------------------------------------------
-- A create or replace is one transaction: the circuit row, then its gates, then its wires.

-- name: insert_circuit
-- A new circuit is private. $1 owner id, $2 name, $3 description, $4 gate count, $5 wire count,
-- $6 input keys, $7 output keys, $8 feedback loop (empty if there is none).
INSERT INTO circuits (owner_id, name, description, gate_count, wire_count, input_keys, output_keys, feedback_loop)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING id, version, created_at, updated_at;

-- name: insert_gates
-- All gates of a circuit in one statement, from parallel arrays; array order becomes `position`.
-- $1 circuit id, $2 keys, $3 types, $4 labels, $5 CONST values (NULL for other gates). Types
-- arrive as text and are cast one by one: database drivers can send a text[], but not an array of
-- a custom enum type.
INSERT INTO gates (circuit_id, key, position, type, label, const_value)
SELECT $1, g.key, g.n - 1, g.type::gate_type, g.label, g.const_value
FROM unnest($2::text[], $3::text[], $4::text[], $5::smallint[]) WITH ORDINALITY AS g (key, type, label, const_value, n);

-- name: insert_wires
-- $1 circuit id, $2 source keys, $3 target keys, $4 target pins, $5 wire keys (NULL when unnamed).
INSERT INTO wires (circuit_id, source_key, target_key, target_pin, position, key)
SELECT $1, w.source_key, w.target_key, w.target_pin, w.n - 1, w.key
FROM unnest($2::text[], $3::text[], $4::smallint[], $5::text[]) WITH ORDINALITY AS w (source_key, target_key, target_pin, key, n);

-- name: replace_circuit_if_version
-- Optimistic locking: applies only if the circuit is still at the version the client edited ($2).
-- No row back means someone else changed it first (or deleted it); the API answers 412. The
-- UPDATE also locks the row until the transaction ends, so two replaces can't interleave.
-- $1 id, $2 expected version, $3 name, $4 description, $5..$9 summary as in insert_circuit.
UPDATE circuits
SET name = $3, description = $4, gate_count = $5, wire_count = $6, input_keys = $7, output_keys = $8,
    feedback_loop = $9, version = version + 1, updated_at = now()
WHERE id = $1 AND version = $2
RETURNING version, updated_at;

-- name: delete_gates
-- Before inserting a replacement's gates and wires. The wires go with them (ON DELETE CASCADE).
-- $1 circuit id.
DELETE FROM gates WHERE circuit_id = $1;

-- name: update_metadata_if_version
-- PATCH: rename, change the description, and/or change the visibility (the owner only; the API
-- checks). $1 id, $2 expected version, $3 new name (NULL: keep), $4 whether to change the
-- description, $5 the new description (NULL removes it), $6 new visibility (NULL: keep).
UPDATE circuits
SET name = coalesce($3, name),
    description = CASE WHEN $4 THEN $5 ELSE description END,
    visibility = coalesce($6::circuit_visibility, visibility),
    version = version + 1, updated_at = now()
WHERE id = $1 AND version = $2
RETURNING version, updated_at;

-- name: delete_circuit_if_version
-- $1 id, $2 expected version. Gates, wires, and runs go with it.
DELETE FROM circuits WHERE id = $1 AND version = $2;


-- Simulation runs ------------------------------------------------------------------------------

-- name: record_simulation
-- A finished, synchronous simulation. $1 circuit id, $2 version, $3 user id (or NULL), $4 inputs,
-- $5 outputs (NULL if failed), $6 error code (NULL if succeeded), $7 mode (combinational, sequential).
INSERT INTO simulation_runs (circuit_id, circuit_version, user_id, kind, mode, status, inputs, outputs, error_code, started_at, finished_at)
VALUES ($1, $2, $3, 'simulate', $7::simulation_mode, CASE WHEN $6::text IS NULL THEN 'succeeded' ELSE 'failed' END::run_status,
        $4, $5, $6, now(), clock_timestamp())
RETURNING id;

-- name: recent_runs
-- What the circuit's owner sees: everyone's runs. $1 circuit id, $2 how many. Served by
-- simulation_runs_circuit_idx.
SELECT id, circuit_version, kind, mode, status, inputs, outputs, row_offset, row_limit, error_code, created_at, finished_at
FROM simulation_runs
WHERE circuit_id = $1
ORDER BY created_at DESC
LIMIT $2;

-- name: recent_runs_by_user
-- What anyone else sees: only their own runs. $1 circuit id, $2 how many, $3 user id.
SELECT id, circuit_version, kind, mode, status, inputs, outputs, row_offset, row_limit, error_code, created_at, finished_at
FROM simulation_runs
WHERE circuit_id = $1 AND user_id = $3
ORDER BY created_at DESC
LIMIT $2;



-- Truth-table jobs (phase 10) ------------------------------------------------------------------
-- A job is a run of kind 'truth_table'. Its status only ever moves forward, and every change is a
-- compare-and-swap on the status, so a cancellation and a finishing worker can't both win.

-- name: lock_user_jobs
-- Starting a job is one transaction: this lock, the allowance, then the insert. The lock (released
-- when the transaction ends) makes two requests from one user take turns, so both can't squeeze
-- under the allowance at once. $1 user id.
SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0));

-- name: job_allowance
-- What a user may still start: jobs started since $2 (24 hours ago), the unfinished ones among
-- them, and when the oldest started (when the allowance next grows). $1 user id. Served by
-- simulation_runs_user_jobs_idx.
SELECT count(*) AS started,
       count(*) FILTER (WHERE status IN ('queued', 'running')) AS unfinished,
       min(created_at) AS oldest
FROM simulation_runs
WHERE user_id = $1 AND kind = 'truth_table' AND created_at > $2;

-- name: identical_unfinished_job
-- The same request again while the first is still waiting or running (a client retrying after a
-- lost answer) gets the first job back. $1 user id, $2 circuit id, $3 version, $4 offset, $5 limit.
-- Served by simulation_runs_user_jobs_idx.
SELECT id FROM simulation_runs
WHERE user_id = $1 AND kind = 'truth_table' AND status IN ('queued', 'running')
  AND circuit_id = $2 AND circuit_version = $3 AND row_offset = $4 AND row_limit = $5
ORDER BY created_at DESC
LIMIT 1;

-- name: insert_job
-- $1 circuit id, $2 version, $3 user id, $4 offset, $5 limit, $6 now.
INSERT INTO simulation_runs (circuit_id, circuit_version, user_id, kind, status, row_offset, row_limit, created_at)
VALUES ($1, $2, $3, 'truth_table', 'queued', $4, $5, $6)
RETURNING id;

-- name: get_job
-- A job, for the person who started it. $1 job id, $2 circuit id, $3 user id.
SELECT id, circuit_id, circuit_version, user_id, status, row_offset, row_limit, error_code, created_at, started_at, finished_at
FROM simulation_runs
WHERE id = $1 AND circuit_id = $2 AND user_id = $3 AND kind = 'truth_table';

-- name: start_job
-- A worker takes the job. Also matches 'running': a retry after a failed attempt starts again.
-- Nothing back means it was cancelled (or deleted with its circuit), and the worker skips it.
-- $1 job id, $2 now.
UPDATE simulation_runs SET status = 'running', started_at = $2
WHERE id = $1 AND kind = 'truth_table' AND status IN ('queued', 'running')
RETURNING circuit_id, circuit_version, row_offset, row_limit;

-- name: job_status
-- Asked by the worker between pages: has someone cancelled the job? $1 job id.
SELECT status FROM simulation_runs WHERE id = $1;

-- name: complete_job
-- Only a running job can succeed. Nothing back means it was cancelled meanwhile, and its result is
-- thrown away. $1 job id, $2 now.
UPDATE simulation_runs SET status = 'succeeded', finished_at = $2
WHERE id = $1 AND status = 'running'
RETURNING id;

-- name: fail_job
-- $1 job id, $2 now, $3 the problem code.
UPDATE simulation_runs SET status = 'failed', finished_at = $2, error_code = $3
WHERE id = $1 AND status IN ('queued', 'running')
RETURNING id;

-- name: cancel_job
-- $1 job id, $2 now.
UPDATE simulation_runs SET status = 'cancelled', finished_at = $2
WHERE id = $1 AND status IN ('queued', 'running')
RETURNING id;

-- name: discard_job
-- A job that couldn't be queued (Redis was down): its request was answered with 503, so, like a
-- simulation turned away, it leaves no trace. Only a job no worker has touched. $1 job id.
DELETE FROM simulation_runs WHERE id = $1 AND kind = 'truth_table' AND status = 'queued';

-- name: fail_abandoned_jobs
-- Housekeeping: a job still unfinished an hour after it was requested has been lost (say its
-- worker's machine died and Redis lost the job too). $1 now, $2 an hour ago. Served by
-- simulation_runs_unfinished_idx, which only holds unfinished runs.
UPDATE simulation_runs SET status = 'failed', finished_at = $1, error_code = 'internal-error'
WHERE status IN ('queued', 'running') AND created_at < $2
RETURNING id;

-- Sharing --------------------------------------------------------------------------------------

-- name: share_circuit
-- Gives $2 (a user id) the role $3 on circuit $1, or changes the role if they already have one.
-- `created` tells the two apart (a fresh row has xmax = 0), so the API can answer 201 or 200.
INSERT INTO circuit_shares (circuit_id, user_id, role)
VALUES ($1, $2, $3)
ON CONFLICT (circuit_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()
RETURNING role, created_at, (xmax = 0) AS created;

-- name: list_shares
-- Who a circuit is shared with, for its owner. $1 circuit id.
SELECT s.user_id, u.display_name, u.email, s.role, s.created_at
FROM circuit_shares AS s JOIN users AS u ON u.id = s.user_id
WHERE s.circuit_id = $1
ORDER BY s.created_at, s.user_id;

-- name: unshare_circuit
-- $1 circuit id, $2 user id.
DELETE FROM circuit_shares WHERE circuit_id = $1 AND user_id = $2;


-- Accounts and sessions ------------------------------------------------------------------------

-- name: insert_user
-- $1 email (already in lower case), $2 display name, $3 Argon2id hash. A taken email fails on
-- users_email_key, which the API answers with 409.
INSERT INTO users (email, display_name, password_hash)
VALUES ($1, $2, $3)
RETURNING id, created_at;

-- name: user_by_email
-- Signing in. $1 email, in lower case. Served by users_email_key.
SELECT id, display_name, password_hash FROM users WHERE email = $1;

-- name: insert_session
-- $1 user id, $2 SHA-256 of the secret, $3 now, $4 when it expires.
INSERT INTO sessions (user_id, secret_hash, created_at, refreshed_at, expires_at)
VALUES ($1, $2, $3, $3, $4)
RETURNING id;

-- name: rotate_session
-- Refreshing: replaces the secret, but only if the client presented the current one ($2) and the
-- session hasn't expired. Compare-and-swap: of two refreshes racing with the same token, one
-- wins and the other finds nothing. $1 session id, $3 new secret hash, $4 now, $5 new expiry.
UPDATE sessions
SET secret_hash = $3, refreshed_at = $4, expires_at = $5
WHERE id = $1 AND secret_hash = $2 AND expires_at > $4
RETURNING user_id;

-- name: delete_session
-- Signing out, or ending a session whose old secret was presented again. $1 session id.
DELETE FROM sessions WHERE id = $1;

-- name: delete_expired_sessions
-- Housekeeping, run every 10 minutes by a scheduled job (phase 10). $1 now. Served by
-- sessions_expires_at_idx.
DELETE FROM sessions WHERE expires_at <= $1;
