import type { PoolStats } from "@circuitlab/runner";
import { Controller, Get, Module, Optional, Res, VERSION_NEUTRAL } from "@nestjs/common";
import type { Response } from "express";
import { RedisService } from "../redis/redis.service";
import { SimulationModule } from "../simulation/simulation.module";
import { SimulationPoolService } from "../simulation/simulation-pool.service";
import { PrismaService } from "../storage/prisma.service";

export interface Health {
  /** "unavailable" (with HTTP 503) when the database or Redis can't be reached. */
  readonly status: "ok" | "unavailable";
  readonly storage: { readonly kind: "postgresql"; readonly reachable: boolean } | { readonly kind: "memory" };
  /** Where the cache, the throttle, and jobs live. */
  readonly redis: { readonly kind: "redis"; readonly reachable: boolean } | { readonly kind: "memory" };
  readonly simulationPool: PoolStats & { readonly size: number };
}

/**
 * `GET /health`, for load balancers and container orchestration (phase 11), outside the versioned
 * API. Answers 503 when the database or Redis is unreachable, so traffic is routed elsewhere until
 * they're back.
 */
@Controller({ path: "health", version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly pool: SimulationPoolService,
    @Optional() private readonly database?: PrismaService, // only exists when DATABASE_URL is set
    @Optional() private readonly redisService?: RedisService, // only exists when REDIS_URL is set
  ) {}

  @Get()
  async health(@Res({ passthrough: true }) response: Response): Promise<Health> {
    const [storage, redis] = await Promise.all([
      this.database === undefined ? { kind: "memory" as const } : this.database.isReachable().then((reachable) => ({ kind: "postgresql" as const, reachable })),
      this.redisService === undefined ? { kind: "memory" as const } : this.redisService.isReachable().then((reachable) => ({ kind: "redis" as const, reachable })),
    ]);
    const healthy = (storage.kind === "memory" || storage.reachable) && (redis.kind === "memory" || redis.reachable);
    if (!healthy) response.status(503);
    return { status: healthy ? "ok" : "unavailable", storage, redis, simulationPool: this.pool.stats };
  }
}

@Module({
  imports: [SimulationModule],
  controllers: [HealthController],
})
export class HealthModule {}
