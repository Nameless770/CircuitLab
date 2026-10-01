/**
 * Every numeric limit of the API in one place. openapi.yaml states the same numbers for clients,
 * and the contract checks keep the two in agreement.
 */
export const LIMITS = {
  /** Largest request body, JSON or netlist (the web framework enforces it: 413). */
  maxBodyBytes: 5 * 1024 * 1024,
  maxGates: 10_000,
  maxWires: 50_000,
  circuitsPerPage: { default: 20, max: 100 },
  truthTableRowsPerPage: { default: 256, max: 4_096 },
  /** Most rows in one NDJSON or CSV download. */
  maxStreamedRows: 1_048_576,
  /** Validation stops listing problems after this many. */
  maxIssues: 100,
  /** Longest a single simulation request may run, including time waiting for a worker. */
  simulationTimeoutMs: 10_000,
  retryAfterSeconds: { busy: 1, unavailable: 5 },
  /**
   * Passwords, counted in Unicode characters. At least 15: NIST SP 800-63B's minimum for a
   * password that is the only factor. Long passphrases are welcome; no rules about character kinds.
   */
  password: { minLength: 15, maxLength: 256 },
  /** How long an access token (a JWT) is valid. Short, because one can't be revoked before it expires. */
  accessTokenSeconds: 15 * 60,
  /** A session (its refresh token) ends after this many days without being refreshed. */
  sessionDays: 30,
  /** Failed sign-ins for one account from one IP address, within the window, before 429. */
  signIn: { maxFailures: 5, windowSeconds: 15 * 60 },
} as const;
