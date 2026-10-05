/**
 * Prisma error codes meaning "the database can't be reached right now" rather than "this query is
 * wrong": can't connect (P1001), connection timed out (P1002), operation timed out (P1008), server
 * closed the connection (P1017), no free connection in the pool in time (P2024).
 */
const UNAVAILABLE_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024"]);

/**
 * The same conditions as reported by the driver adapter. Raw queries surface them this way, wrapped
 * in a generic "raw query failed" (P2010) rather than under their own code.
 */
const UNAVAILABLE_KINDS = new Set(["DatabaseNotReachable", "ConnectionClosed", "SocketTimeout", "TooManyConnections"]);

/**
 * PostgreSQL's own words for it (SQLSTATE): class 08 is "connection exception", and 57P01–57P03 are
 * "the server is shutting down / crashed / is starting up".
 */
const UNAVAILABLE_SQLSTATE = /^(08...|57P0[123])$/;

/**
 * What the connection pool (pg-pool) says when no connection came free within the wait limit
 * (DATABASE_POOL_TIMEOUT_MS). Prisma doesn't classify it: it arrives as a plain Error with no code,
 * so the words are all there is to go by. test/database-failures.test.ts makes a pool run dry for
 * real, so a version of pg-pool that words it differently fails there instead of turning into 500s.
 */
const POOL_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";

interface PrismaErrorShape {
  code?: unknown;
  message?: unknown;
  meta?: { driverAdapterError?: { cause?: { kind?: unknown; code?: unknown } } };
}

/**
 * Whether an error means the database is down or overloaded, so the request may well succeed if
 * retried shortly: a 503, not a 500. Duck-typed, so the HTTP layer needn't import Prisma.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message, meta } = error as PrismaErrorShape;
  if (typeof code === "string" && UNAVAILABLE_CODES.has(code)) return true;
  if (message === POOL_TIMEOUT_MESSAGE) return true;
  const cause = meta?.driverAdapterError?.cause;
  if (typeof cause?.kind === "string" && UNAVAILABLE_KINDS.has(cause.kind)) return true;
  return cause?.kind === "postgres" && typeof cause.code === "string" && UNAVAILABLE_SQLSTATE.test(cause.code);
}
