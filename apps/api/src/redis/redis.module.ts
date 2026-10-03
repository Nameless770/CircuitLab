import { Module, type DynamicModule, type Provider } from "@nestjs/common";
import { AuthRateLimit } from "../auth/auth-rate-limit";
import { SignInThrottle } from "../auth/sign-in-throttle";
import { AppConfig } from "../config/app-config";
import { JobResults } from "../jobs/job-results";
import { ResultCache } from "../simulation/result-cache";
import { InMemoryAuthRateLimit } from "./in-memory-auth-rate-limit";
import { InMemoryJobResults } from "./in-memory-job-results";
import { InMemoryResultCache } from "./in-memory-result-cache";
import { InMemorySignInThrottle } from "./in-memory-sign-in-throttle";
import { RedisAuthRateLimit } from "./redis-auth-rate-limit";
import { RedisJobResults } from "./redis-job-results";
import { RedisResultCache } from "./redis-result-cache";
import { RedisSignInThrottle } from "./redis-sign-in-throttle";
import { RedisService } from "./redis.service";

/**
 * The one place that decides where short-lived, shared state lives: the result cache, the sign-in
 * throttle, the address limit on sign-ins and registrations, and job results. With REDIS_URL set, in Redis, where every API instance and worker
 * shares them; without it, in this process's memory, which is enough for one process. (The job
 * queue itself is JobsModule's choice, made the same way.) StorageModule makes the same choice
 * for lasting data, between PostgreSQL and memory.
 */
@Module({})
export class RedisModule {
  static forRoot(config: AppConfig): DynamicModule {
    const providers: Provider[] =
      config.redisUrl === undefined
        ? [
            { provide: ResultCache, useClass: InMemoryResultCache },
            { provide: SignInThrottle, useClass: InMemorySignInThrottle },
            { provide: AuthRateLimit, useClass: InMemoryAuthRateLimit },
            { provide: JobResults, useClass: InMemoryJobResults },
          ]
        : [
            RedisService,
            { provide: ResultCache, useClass: RedisResultCache },
            { provide: SignInThrottle, useClass: RedisSignInThrottle },
            { provide: AuthRateLimit, useClass: RedisAuthRateLimit },
            { provide: JobResults, useClass: RedisJobResults },
          ];
    return {
      module: RedisModule,
      global: true,
      providers,
      exports: [ResultCache, SignInThrottle, AuthRateLimit, JobResults, ...(config.redisUrl === undefined ? [] : [RedisService])],
    };
  }
}
