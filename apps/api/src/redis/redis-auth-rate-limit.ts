import { createHash } from "node:crypto";
import { tooManyAuthRequests } from "@circuitlab/api-contract";
import { Injectable } from "@nestjs/common";
import { AUTH_RATE_WINDOW_SECONDS, AuthRateLimit } from "../auth/auth-rate-limit";
import { Clock } from "../common/clock";
import { AppConfig } from "../config/app-config";
import { RedisService } from "./redis.service";

const WINDOW_MS = AUTH_RATE_WINDOW_SECONDS * 1000;

/**
 * Counts an attempt, atomically (Redis runs a script without interleaving other commands, so two
 * API instances counting at once can't lose one), and returns the count and when its window
 * opened. A new window opens when there is none or the last one is over.
 *
 * KEYS[1] the key, ARGV[1] now (ms), ARGV[2] the window (ms).
 */
const COUNT_ATTEMPT = `
local since = tonumber(redis.call("HGET", KEYS[1], "since"))
if since == nil or tonumber(ARGV[1]) - since >= tonumber(ARGV[2]) then
  redis.call("HSET", KEYS[1], "count", 1, "since", ARGV[1])
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
  return {1, ARGV[1]}
end
return {redis.call("HINCRBY", KEYS[1], "count", 1), since}
`;

/**
 * The limit in Redis: a hash per address (`count`, and `since`, when the window opened), shared by
 * every API instance. As in the sign-in throttle, whether a window is over is decided with the
 * app's Clock (so the time-travel tests hold here too), and Redis's own expiry only cleans up.
 * Like the throttle it fails closed: with Redis down, registering and signing in answer 503
 * rather than skip a security control.
 */
@Injectable()
export class RedisAuthRateLimit extends AuthRateLimit {
  constructor(
    private readonly redis: RedisService,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {
    super();
  }

  async hit(address: string): Promise<void> {
    const limit = this.config.authRateLimit;
    if (limit === 0) return;
    const now = this.clock.now().getTime();
    const reply = (await this.redis.client.eval(COUNT_ATTEMPT, 1, this.key(address), now, WINDOW_MS)) as [number, number | string];
    const [count, since] = reply.map(Number);
    if (count !== undefined && since !== undefined && count > limit) throw tooManyAuthRequests((since + WINDOW_MS - now) / 1000);
  }

  /** Hashed, so addresses aren't kept in Redis as they are. */
  private key(address: string): string {
    return this.redis.key("auth-rate", createHash("sha256").update(address).digest("base64url"));
  }
}
