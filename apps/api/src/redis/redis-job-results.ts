import { LIMITS } from "@circuitlab/api-contract";
import { Injectable } from "@nestjs/common";
import type { ChainableCommander } from "ioredis";
import { JobResults, type ResultHeader, type StoredResult } from "../jobs/job-results";
import type { StoredRows } from "../simulation/packed-rows";
import { RedisService } from "./redis.service";

/** A result still being written disappears this long after its last chunk, if its job never finishes. */
const UNFINISHED_TTL_SECONDS = 60 * 60;

/**
 * Results in Redis: one hash per job, with a field per chunk ("0", "1", ...) and, once complete,
 * a "header" field. A chunk is its first row number and row count (12 bytes), then its bits.
 *
 * Redis deletes the hash itself when it expires: an hour after the last chunk while the job runs
 * (so an abandoned result never lingers), and LIMITS.truthTableJobs.resultHours after it finished.
 * Whether a result has expired is still decided with the app's Clock (ResultHeader.expiresAt);
 * Redis's expiry only cleans up.
 */
@Injectable()
export class RedisJobResults extends JobResults {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async append(jobId: string, index: number, rows: StoredRows): Promise<void> {
    const prefix = Buffer.alloc(12);
    prefix.writeDoubleBE(rows.offset, 0);
    prefix.writeUInt32BE(rows.rowCount, 8);
    await all(this.redis.client.multi().hset(this.key(jobId), String(index), Buffer.concat([prefix, rows.bits])).expire(this.key(jobId), UNFINISHED_TTL_SECONDS));
  }

  async finish(jobId: string, header: ResultHeader): Promise<void> {
    await all(this.redis.client.multi().hset(this.key(jobId), "header", JSON.stringify(header)).expire(this.key(jobId), LIMITS.truthTableJobs.resultHours * 3600));
  }

  async open(jobId: string): Promise<StoredResult | undefined> {
    const text = await this.redis.client.hget(this.key(jobId), "header");
    if (text === null) return undefined;
    const parsed = JSON.parse(text) as Omit<ResultHeader, "expiresAt"> & { expiresAt: string };
    const header: ResultHeader = { ...parsed, expiresAt: new Date(parsed.expiresAt) };
    const read = (index: number): Promise<Buffer | null> => this.redis.client.hgetBuffer(this.key(jobId), String(index));
    return {
      header,
      async *chunks() {
        for (let index = 0; index < header.chunks; index++) {
          const chunk = await read(index);
          if (chunk === null) throw new Error(`Chunk ${index} of job ${jobId}'s result is missing (it expired while being read)`);
          yield { offset: chunk.readDoubleBE(0), rowCount: chunk.readUInt32BE(8), bits: chunk.subarray(12) };
        }
      },
    };
  }

  async delete(jobId: string): Promise<void> {
    await this.redis.client.del(this.key(jobId));
  }

  private key(jobId: string): string {
    return this.redis.key("results", jobId);
  }
}

/**
 * Runs a MULTI block. Redis reports a command that failed inside it (out of memory, say) among the
 * results instead of failing the whole call, so each result is checked.
 */
async function all(block: ChainableCommander): Promise<void> {
  const results = await block.exec();
  if (results === null) throw new Error("The Redis transaction was aborted");
  for (const [error] of results) if (error !== null) throw error;
}
