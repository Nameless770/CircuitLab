import { describeApi } from "./suites/all";

// The whole API over HTTP, with everything in memory: accounts and circuits, the cache, the
// sign-in throttle, and the job queue.
describeApi({ storage: "memory", redis: false });
