import { ApiError, LIMITS } from "@circuitlab/api-contract";
import { isRedisUnavailable } from "../redis/redis-errors";
import { isDatabaseUnavailable } from "../storage/database-errors";

/**
 * The database or Redis being down, in the contract's terms: 503 `server-unavailable`, worth
 * retrying, rather than a 500 that would suggest a bug. Anything else is returned as it is.
 *
 * Used for HTTP answers (ProblemFilter), and for jobs, which record the problem code they failed with.
 */
export function outageAsProblem(error: unknown): unknown {
  const retryAfter = { "Retry-After": String(LIMITS.retryAfterSeconds.unavailable) };
  if (isDatabaseUnavailable(error)) return new ApiError("server-unavailable", "The database is unavailable. Try again shortly.", { headers: retryAfter });
  if (isRedisUnavailable(error)) return new ApiError("server-unavailable", "Redis is unavailable. Try again shortly.", { headers: retryAfter });
  return error;
}
