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

  constructor(settings: Partial<AppSettings> = {}) {
    this.port = settings.port ?? 3000;
    this.simulationWorkers = settings.simulationWorkers;
    this.simulationQueue = settings.simulationQueue ?? 100;
    this.workerMemoryMb = settings.workerMemoryMb ?? 512;
    this.shutdownGraceMs = settings.shutdownGraceMs ?? 10_000;
    this.databaseUrl = settings.databaseUrl;
    this.databasePoolSize = settings.databasePoolSize ?? 10;
    this.jwtSecret = settings.jwtSecret;
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
    const postgresUrl = (name: string): string | undefined => {
      const text = env[name]?.trim();
      if (text === undefined || text === "") return undefined;
      try {
        if (["postgres:", "postgresql:"].includes(new URL(text).protocol)) return text;
      } catch {
        // reported below
      }
      problems.push(`${name} must be a postgresql:// connection string`); // never echo it: it may hold a password
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
    });
    if (problems.length > 0) throw new StartupError(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    return config;
  }
}
