import { Injectable } from "@nestjs/common";
import { AppConfig } from "../config/app-config";
import { ResultCache } from "../simulation/result-cache";
import { RedisService } from "./redis.service";

/**
 * The cache in Redis, shared by every API instance: a result computed by one is a hit for all.
 * Each entry expires after CACHE_TTL_SECONDS; a cache Redis with `maxmemory-policy allkeys-lru`
 * also evicts the least recently used entries when it fills up.
 */
@Injectable()
export class RedisResultCache extends ResultCache {
  constructor(
    private readonly redis: RedisService,
    private readonly config: AppConfig,
  ) {
    super();
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.redis.cache.get(this.redis.key("cache", key))) ?? undefined;
  }

  async set(key: string, value: string): Promise<boolean> {
    if (this.config.cacheTtlSeconds === 0) return false;
    await this.redis.cache.set(this.redis.key("cache", key), value, "EX", this.config.cacheTtlSeconds);
    return true;
  }
}
