import type { PoolStats } from "@circuitlab/runner";
import { Controller, Get, Module, Optional, Res, VERSION_NEUTRAL } from "@nestjs/common";
import type { Response } from "express";
import { IgnoresAccessToken } from "../auth/authentication.guard";
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
 * Two questions about this copy of the API, outside the versioned API:
 *
 * - `GET /health/live`: is the process answering? It asks nobody else. This is what a load
 *   balancer should ask: the one that dropped every copy because Redis blinked would turn a
 *   partial outage (simulations work without Redis) into a total one.
 * - `GET /health`: can it do its whole job? That needs the database and Redis, and it answers 503
 *   when either is unreachable. It is for people (`docker compose ps` shows it) and for whatever
 *   decides to restart a container.
 *
 * docs/system-design.md, stage 2, has the reasoning.
 */
@Controller({ path: "health", version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly pool: SimulationPoolService,
    @Optional() private readonly database?: PrismaService, // only exists when DATABASE_URL is set
    @Optional() private readonly redisService?: RedisService, // only exists when REDIS_URL is set
  ) {}

  /** Liveness. Needs no token either: not even a bad one gets in the way. */
  @Get("live")
  @IgnoresAccessToken()
  live(): { readonly status: "ok" } {
    return { status: "ok" };
  }

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
