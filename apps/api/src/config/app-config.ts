import { StartupError } from "./startup-error";

/** The app's settings. */
export interface AppSettings {
  /** HTTP port. `PORT`, default 3000. */
  readonly port: number;
  /** Simulation worker threads. `SIMULATION_WORKERS`, default one less than the number of CPUs. */
  readonly simulationWorkers: number | undefined;
  /** Simulations that may wait for a free worker before the API answers 503. `SIMULATION_QUEUE`, default 100. */
  readonly simulationQueue: number;
  /** Heap limit per worker thread. `WORKER_MEMORY_MB`, default 512. */
  readonly workerMemoryMb: number;
  /** On shutdown, how long running simulations may take to finish before they are stopped. `SHUTDOWN_GRACE_MS`, default 10,000. */
  readonly shutdownGraceMs: number;
  /** PostgreSQL connection string. `DATABASE_URL`; without it, circuits are kept in memory. */
  readonly databaseUrl: string | undefined;
  /** Most open database connections. `DATABASE_POOL_SIZE`, default 10. */
  readonly databasePoolSize: number;
  /**
   * The key that signs access tokens. `JWT_SECRET`, at least 32 characters. Without it, a random
   * key is made at startup: fine for a demo, but every token dies when the API restarts, and two
   * API instances wouldn't accept each other's tokens.
   */
  readonly jwtSecret: string | undefined;
  /**
   * Redis connection string (redis:// or rediss://). `REDIS_URL`. With it, the result cache, the
   * sign-in throttle, the job queue (BullMQ), and job results live in Redis, shared by every API
   * instance and worker. Without it, they live in this process's memory.
   */
  readonly redisUrl: string | undefined;
  /**
   * A separate Redis for the cache. `REDIS_CACHE_URL`, default the same as REDIS_URL. Worth it in
   * production: a cache should evict old entries when memory runs out (maxmemory-policy
   * allkeys-lru), but the job queue must never lose a key (noeviction), and one Redis has one policy.
   */
  readonly redisCacheUrl: string | undefined;
  /** Prefix of every Redis key, so several apps or test runs can share one Redis. `REDIS_PREFIX`, default "circuitlab". */
  readonly redisPrefix: string;
  /** How long results stay cached, in seconds; 0 turns the cache off. `CACHE_TTL_SECONDS`, default 3,600. */
  readonly cacheTtlSeconds: number;
  /**
   * Truth-table jobs this process computes at once. `JOB_CONCURRENCY`, default 1. With Redis, 0
   * makes an API-only instance, leaving the jobs to workers (`npm run start:worker`).
   */
  readonly jobConcurrency: number;
  /**
   * How many reverse proxies stand between the internet and the API, for Express's "trust proxy"
   * setting. `TRUST_PROXY`, default 0. Behind one proxy (Caddy, nginx, a platform's load balancer)
   * it is 1: the client's address, which the sign-in throttle and the address limit count by, is
   * then read from the proxy's X-Forwarded-For header instead of being the proxy's own. Never more
   * than the real number: a client could then make up its address.
   */
  readonly trustProxy: number;
  /**
   * Most sign-ins and registrations one address may make in a minute; 0 turns the limit off.
   * `AUTH_RATE_LIMIT`, default 0. Both cost a full password hash, and the sign-in throttle only
   * counts failures per account, so without this a client making up email addresses can keep the
   * API's CPUs busy hashing (measured in docs/system-design.md). Only meaningful with the right
   * TRUST_PROXY behind a proxy: otherwise every client counts as the proxy's one address.
   */
  readonly authRateLimit: number;
}

/**
 * The settings as an injectable class: Nest needs a runtime value as the injection token, and a
 * class is both that token and the type. Created once at startup, so a bad setting stops the app
 * immediately instead of failing at the first request that needs it.
 */
export class AppConfig implements AppSettings {
  readonly port: number;
  readonly simulationWorkers: number | undefined;
  readonly simulationQueue: number;
  readonly workerMemoryMb: number;
  readonly shutdownGraceMs: number;
  readonly databaseUrl: string | undefined;
  readonly databasePoolSize: number;
  readonly jwtSecret: string | undefined;
  readonly redisUrl: string | undefined;
  readonly redisCacheUrl: string | undefined;
  readonly redisPrefix: string;
  readonly cacheTtlSeconds: number;
  readonly jobConcurrency: number;
  readonly trustProxy: number;
  readonly authRateLimit: number;

  constructor(settings: Partial<AppSettings> = {}) {
    this.port = settings.port ?? 3000;
    this.simulationWorkers = settings.simulationWorkers;
    this.simulationQueue = settings.simulationQueue ?? 100;
    this.workerMemoryMb = settings.workerMemoryMb ?? 512;
    this.shutdownGraceMs = settings.shutdownGraceMs ?? 10_000;
    this.databaseUrl = settings.databaseUrl;
    this.databasePoolSize = settings.databasePoolSize ?? 10;
    this.jwtSecret = settings.jwtSecret;
    this.redisUrl = settings.redisUrl;
    this.redisCacheUrl = settings.redisCacheUrl;
    this.redisPrefix = settings.redisPrefix ?? "circuitlab";
    this.cacheTtlSeconds = settings.cacheTtlSeconds ?? 3600;
    this.jobConcurrency = settings.jobConcurrency ?? 1;
    this.trustProxy = settings.trustProxy ?? 0;
    this.authRateLimit = settings.authRateLimit ?? 0;
  }

  /** Reads the settings from environment variables, reporting every invalid one at once. */
  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const problems: string[] = [];
    const whole = (name: string, minimum: number): number | undefined => {
      const text = env[name];
      if (text === undefined || text.trim() === "") return undefined;
      const value = Number(text);
      if (Number.isSafeInteger(value) && value >= minimum) return value;
      problems.push(`${name} must be a whole number of at least ${minimum}, got ${JSON.stringify(text)}`);
      return undefined;
    };
    const connectionString = (name: string, protocols: readonly string[]): string | undefined => {
      const text = env[name]?.trim();
      if (text === undefined || text === "") return undefined;
      try {
        if (protocols.includes(new URL(text).protocol)) return text;
      } catch {
        // reported below
      }
      problems.push(`${name} must be a ${protocols[0]}// connection string`); // never echo it: it may hold a password
      return undefined;
    };
    const postgresUrl = (name: string): string | undefined => connectionString(name, ["postgresql:", "postgres:"]);
    const redisUrl = (name: string): string | undefined => connectionString(name, ["redis:", "rediss:"]);
    const prefix = (name: string): string | undefined => {
      const text = env[name]?.trim();
      if (text === undefined || text === "") return undefined;
      if (/^[A-Za-z0-9_.-]{1,64}$/.test(text)) return text;
      problems.push(`${name} may only hold letters, digits, "_", "." and "-" (at most 64), got ${JSON.stringify(text.slice(0, 80))}`);
      return undefined;
    };
    const secret = (name: string, minimum: number): string | undefined => {
      const text = env[name];
      if (text === undefined || text === "") return undefined;
      if (text.length >= minimum) return text;
      problems.push(`${name} must be at least ${minimum} characters long`); // never echo a secret
      return undefined;
    };
    const config = new AppConfig({
      port: whole("PORT", 0),
      simulationWorkers: whole("SIMULATION_WORKERS", 1),
      simulationQueue: whole("SIMULATION_QUEUE", 0),
      workerMemoryMb: whole("WORKER_MEMORY_MB", 16),
      shutdownGraceMs: whole("SHUTDOWN_GRACE_MS", 0),
      databaseUrl: postgresUrl("DATABASE_URL"),
      databasePoolSize: whole("DATABASE_POOL_SIZE", 1),
      jwtSecret: secret("JWT_SECRET", 32),
      redisUrl: redisUrl("REDIS_URL"),
      redisCacheUrl: redisUrl("REDIS_CACHE_URL"),
      redisPrefix: prefix("REDIS_PREFIX"),
      cacheTtlSeconds: whole("CACHE_TTL_SECONDS", 0),
      jobConcurrency: whole("JOB_CONCURRENCY", 0),
      trustProxy: whole("TRUST_PROXY", 0),
      authRateLimit: whole("AUTH_RATE_LIMIT", 0),
    });
    if (config.jobConcurrency === 0 && config.redisUrl === undefined) {
      problems.push("JOB_CONCURRENCY=0 needs REDIS_URL: without Redis, jobs can only run in this process");
    }
    if (problems.length > 0) throw new StartupError(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    return config;
  }
}
