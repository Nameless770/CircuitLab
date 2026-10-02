import { describeApi } from "./suites/all";

// The same tests as production runs: PostgreSQL (a fresh PGlite, migrated as in production) for
// what must last, and Redis (a fresh one in Docker) for the cache, the sign-in throttle, and the
// BullMQ job queue.
describeApi({ storage: "postgresql", redis: true });
