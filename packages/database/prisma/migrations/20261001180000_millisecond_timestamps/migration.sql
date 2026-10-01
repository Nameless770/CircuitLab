-- Timestamps are stored to the millisecond, the precision of a JavaScript Date.
--
-- Found while connecting Prisma (phase 6): PostgreSQL keeps microseconds, but values reach the
-- application as JavaScript Dates, which keep milliseconds. A list cursor holds the last circuit's
-- created_at as such a Date, so a circuit created later within the same millisecond compared as
-- "newer than the cursor", and the next page skipped it. Storing only what the application can
-- represent makes cursors exact. (Prisma's own default for DateTime columns is the same precision.)
-- Existing values are rounded; rounding never changes their order.

ALTER TABLE users
  ALTER COLUMN created_at TYPE timestamptz(3),
  ALTER COLUMN updated_at TYPE timestamptz(3);

ALTER TABLE circuits
  ALTER COLUMN created_at TYPE timestamptz(3),
  ALTER COLUMN updated_at TYPE timestamptz(3);

ALTER TABLE simulation_runs
  ALTER COLUMN created_at TYPE timestamptz(3),
  ALTER COLUMN started_at TYPE timestamptz(3),
  ALTER COLUMN finished_at TYPE timestamptz(3);
