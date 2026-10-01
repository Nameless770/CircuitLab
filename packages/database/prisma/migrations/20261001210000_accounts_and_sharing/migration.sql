-- Accounts, private and public circuits, and sharing (phase 7).
--
-- Every circuit now has an owner, who decides who else may see it: nobody (private, the default),
-- particular people (shares, each as viewer or editor), or everyone (public). Who may do what with
-- each kind of access is decided by the API (apps/api/src/circuits/circuit-access.ts); the database
-- keeps the facts it is based on consistent.

CREATE TYPE circuit_visibility AS ENUM ('private', 'public');
CREATE TYPE share_role AS ENUM ('viewer', 'editor');


-- circuits: an owner and a visibility -----------------------------------------------------------

ALTER TABLE circuits ADD COLUMN visibility circuit_visibility NOT NULL DEFAULT 'private';

-- Every circuit written from now on must have an owner. Circuits stored before accounts existed
-- have none, and NOT VALID applies the rule to new and changed rows without checking those, so this
-- migration neither fails because of them nor deletes them. They are private, so nobody can see
-- them. Once each has been given an owner or deleted, `VALIDATE CONSTRAINT` followed by
-- `ALTER COLUMN owner_id SET NOT NULL` completes the change.
ALTER TABLE circuits ADD CONSTRAINT circuits_owner_required CHECK (owner_id IS NOT NULL) NOT VALID;

-- Every list is now either one person's circuits or the public ones (queries.sql), so each list
-- order gets an index for each. The old indexes over all circuits serve no query any more. The
-- owner indexes start with owner_id, so they also serve the foreign key (deleting a user).
DROP INDEX circuits_created_at_id_idx, circuits_updated_at_id_idx, circuits_name_id_idx, circuits_owner_id_idx;

CREATE INDEX circuits_owner_created_at_idx ON circuits (owner_id, created_at, id);
CREATE INDEX circuits_owner_updated_at_idx ON circuits (owner_id, updated_at, id);
CREATE INDEX circuits_owner_name_idx ON circuits (owner_id, name, id);

-- Partial indexes: only public circuits are in them, so they stay small however many private
-- circuits there are, and a list of public circuits never has to skip over private ones.
CREATE INDEX circuits_public_created_at_idx ON circuits (created_at, id) WHERE visibility = 'public';
CREATE INDEX circuits_public_updated_at_idx ON circuits (updated_at, id) WHERE visibility = 'public';
CREATE INDEX circuits_public_name_idx ON circuits (name, id) WHERE visibility = 'public';


-- circuit_shares -------------------------------------------------------------------------------
-- A circuit's owner gives another account access to it: `viewer` (read and simulate) or `editor`
-- (also change it). The owner can't be one of the recipients; the API checks that, since a CHECK
-- can only look at one row.

CREATE TABLE circuit_shares (
  circuit_id uuid           NOT NULL REFERENCES circuits (id) ON DELETE CASCADE,
  user_id    uuid           NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       share_role     NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),

  -- At most one share per person and circuit: sharing again changes the role.
  PRIMARY KEY (circuit_id, user_id)
);

-- "Circuits shared with me", and deleting a user (the foreign key).
CREATE INDEX circuit_shares_user_idx ON circuit_shares (user_id, circuit_id);


-- sessions -------------------------------------------------------------------------------------
-- One row per signed-in device. The client holds a refresh token, "<session id>.<secret>"; only a
-- SHA-256 hash of the secret is stored, so a copy of this table can't be used to sign in. Every
-- refresh replaces the secret, and presenting a replaced one ends the session (see
-- docs/auth-design.md). Signing out deletes the row.

CREATE TABLE sessions (
  id           uuid           PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid           NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  secret_hash  bytea          NOT NULL,
  created_at   timestamptz(3) NOT NULL DEFAULT now(),
  refreshed_at timestamptz(3) NOT NULL DEFAULT now(),
  expires_at   timestamptz(3) NOT NULL,

  -- A SHA-256 hash is 32 bytes: a secret stored as it is would almost never be.
  CONSTRAINT sessions_secret_hash_length CHECK (octet_length(secret_hash) = 32),
  CONSTRAINT sessions_times_ordered CHECK (created_at <= refreshed_at AND refreshed_at < expires_at)
);

-- A user's sessions ("sign out everywhere", deleting a user), and removing expired ones.
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
