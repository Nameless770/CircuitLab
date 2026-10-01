-- "No feedback loop" becomes an empty array instead of NULL.
--
-- Found while connecting Prisma (phase 6): Prisma Client treats array columns as never NULL. It
-- reads NULL back as [] and won't write NULL, so the original rule (NULL, or a loop of at least two
-- gate keys) left no way to clear a loop through Prisma. Applied migrations are never edited;
-- changes come as new migrations like this one.

UPDATE circuits SET feedback_loop = '{}' WHERE feedback_loop IS NULL;

ALTER TABLE circuits
  ALTER COLUMN feedback_loop SET DEFAULT '{}',
  ALTER COLUMN feedback_loop SET NOT NULL,
  DROP CONSTRAINT circuits_feedback_loop_closed,
  -- Empty (no loop), or a closed loop: at least two entries, the first repeated at the end.
  ADD CONSTRAINT circuits_feedback_loop_closed CHECK (cardinality(feedback_loop) <> 1);
