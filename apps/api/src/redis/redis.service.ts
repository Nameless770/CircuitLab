import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import type { RedisOptions as BullConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { AppConfig } from "../config/app-config";
import { StartupError } from "../config/startup-error";

/** How long a connection attempt, or a command, may take before it counts as failed. */
const TIMEOUT_MS = 2000;

/**
 * The app's connections to Redis, with their lifecycle tied to the app's. Requests must fail fast
 * when Redis is down, rather than wait for it, so commands aren't queued while disconnected
 * (`enableOfflineQueue: false`) and give up after two seconds without an answer. The client keeps
 * reconnecting in the background, so the API recovers on its own when Redis is back.
 *
 * BullMQ opens its own connections from `bullConnection()`.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnApplicationShutdown {
  /** For the app's own commands: the sign-in throttle and job results. */
  readonly client: Redis;
  /** For the cache: its own Redis when REDIS_CACHE_URL names one, otherwise the same connection. */
  readonly cache: Redis;
  private readonly logger = new Logger("Redis");
  private readonly urls: { readonly main: string; readonly cache: string | undefined };

  constructor(private readonly config: AppConfig) {
    if (config.redisUrl === undefined) throw new Error("RedisService needs REDIS_URL");
    const separateCache = config.redisCacheUrl !== undefined && config.redisCacheUrl !== config.redisUrl;
    this.urls = { main: config.redisUrl, cache: separateCache ? config.redisCacheUrl : undefined };
    this.client = this.connect(this.urls.main, "Redis");
    this.cache = this.urls.cache === undefined ? this.client : this.connect(this.urls.cache, "The cache's Redis");
  }

  /** A key in the app's namespace, e.g. key("cache", "sim", id) is "circuitlab:cache:sim:<id>". */
  key(...parts: readonly (string | number)[]): string {
    return [this.config.redisPrefix, ...parts].join(":");
  }

  /**
   * Connection options for BullMQ. A queue, used while answering requests, fails fast like the
   * app's own client. A worker blocks while waiting for jobs, so its commands must have no time
   * limit and be retried for as long as it takes (BullMQ insists on `maxRetriesPerRequest: null`).
   */
  bullConnection(role: "queue" | "worker"): BullConnectionOptions {
    // Reconnect as quickly as the app's own clients do (BullMQ's default waits up to 20 seconds).
    const retryStrategy = (attempt: number): number => Math.min(attempt * 100, TIMEOUT_MS);
    return role === "queue"
      ? { url: this.urls.main, enableOfflineQueue: false, connectTimeout: TIMEOUT_MS, commandTimeout: TIMEOUT_MS, retryStrategy }
      : { url: this.urls.main, maxRetriesPerRequest: null, connectTimeout: TIMEOUT_MS, retryStrategy };
  }

  /** BullMQ's key prefix, inside the app's namespace. */
  get bullPrefix(): string {
    return this.key("bull");
  }

  /**
   * Fails at startup, with a clear message, if Redis can't be reached: better than failing on the
   * first request that needs it.
   */
  async onModuleInit(): Promise<void> {
    for (const [client, url] of this.clients()) {
      try {
        await client.connect();
      } catch (error) {
        this.disconnectAll();
        throw new StartupError(`Cannot reach Redis at ${location(url)}. Is it running? (A local one starts with: npm run redis:start)`, { cause: error });
      }
      this.logger.log(`Using Redis at ${location(url)}${client === this.cache && this.urls.cache !== undefined ? " for the cache" : ""}`);
    }
  }

  async isReachable(): Promise<boolean> {
    try {
      await Promise.all(this.clients().map(([client]) => client.ping()));
      return true;
    } catch {
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.clients().map(([client]) => client.quit().catch(() => client.disconnect())));
  }

  private clients(): [Redis, string][] {
    return this.urls.cache === undefined ? [[this.client, this.urls.main]] : [[this.client, this.urls.main], [this.cache, this.urls.cache]];
  }

  private disconnectAll(): void {
    for (const [client] of this.clients()) client.disconnect();
  }

  /** A client that reports losing Redis once, and finding it again once, rather than on every retry. */
  private connect(url: string, name: string): Redis {
    const client = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: TIMEOUT_MS, commandTimeout: TIMEOUT_MS });
    // Before the first connection, onModuleInit reports a failure itself.
    let state: "starting" | "up" | "lost" = "starting";
    client.on("error", (error: Error) => {
      if (state !== "up") return;
      state = "lost";
      this.logger.warn(`${name} at ${location(url)} is unreachable (${error.message}); requests that need it get 503 until it is back`);
    });
    client.on("ready", () => {
      if (state === "lost") this.logger.log(`${name} at ${location(url)} is back`);
      state = "up";
    });
    return client;
  }
}

/** Where Redis is, for messages: never the password. */
function location(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || "6379"}`;
}
