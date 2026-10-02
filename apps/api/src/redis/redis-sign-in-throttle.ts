import { createHash } from "node:crypto";
import { LIMITS, tooManySignInAttempts } from "@circuitlab/api-contract";
import { Injectable } from "@nestjs/common";
import { SignInThrottle } from "../auth/sign-in-throttle";
import { Clock } from "../common/clock";
import { RedisService } from "./redis.service";

/**
 * Counts a failure, atomically: Redis runs a script without interleaving other commands, so two
 * API instances counting at once can't lose a failure between reading the count and writing it.
 *
 * KEYS[1] the key, ARGV[1] now (ms), ARGV[2] the window (ms). A failure opens a new window when
 * there is none or the last one is over, and otherwise counts towards the current one.
 */
const COUNT_FAILURE = `
local since = tonumber(redis.call("HGET", KEYS[1], "since"))
if since == nil or tonumber(ARGV[1]) - since >= tonumber(ARGV[2]) then
  redis.call("HSET", KEYS[1], "count", 1, "since", ARGV[1])
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
  return 1
end
return redis.call("HINCRBY", KEYS[1], "count", 1)
`;

/**
 * The throttle in Redis: a hash per key (`count`, and `since`, when the window opened), shared by
 * every API instance.
 *
 * Two clocks are involved, on purpose. Whether a window is over is decided with the app's Clock,
 * like everywhere else, so the time-travel tests hold here too. Redis's own expiry (PEXPIRE) only
 * cleans up: it deletes a key once its window is over, so abandoned keys never pile up.
 */
@Injectable()
export class RedisSignInThrottle extends SignInThrottle {
  private readonly window = LIMITS.signIn.windowSeconds * 1000;

  constructor(
    private readonly redis: RedisService,
    private readonly clock: Clock,
  ) {
    super();
  }

  async check(key: string): Promise<void> {
    const [count, since] = (await this.redis.client.hmget(this.key(key), "count", "since")).map(Number);
    const now = this.clock.now().getTime();
    if (count === undefined || since === undefined || !(count >= LIMITS.signIn.maxFailures)) return;
    if (now - since < this.window) throw tooManySignInAttempts((since + this.window - now) / 1000);
  }

  async failed(key: string): Promise<void> {
    await this.redis.client.eval(COUNT_FAILURE, 1, this.key(key), this.clock.now().getTime(), this.window);
  }

  async succeeded(key: string): Promise<void> {
    await this.redis.client.del(this.key(key));
  }

  /** Hashed, so email addresses aren't kept in Redis as they are. */
  private key(key: string): string {
    return this.redis.key("sign-in", createHash("sha256").update(key).digest("base64url"));
  }
}
