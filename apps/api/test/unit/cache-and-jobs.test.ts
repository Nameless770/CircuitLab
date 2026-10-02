// Phase 10's smaller parts, tested directly (from the build, like everything else).

import { ApiError, toProblem } from "@circuitlab/api-contract";
import { AppConfig } from "@circuitlab/api";
import type { PackedTruthTable } from "@circuitlab/runner";
import { describe, expect, it } from "vitest";
import { outageAsProblem } from "../../dist/common/outages";
import { pageRows } from "../../dist/jobs/truth-table-job.processor";
import { InMemoryResultCache } from "../../dist/redis/in-memory-result-cache";
import { isConnectionError, isRedisUnavailable } from "../../dist/redis/redis-errors";
import { packRows, slices, unpackRows } from "../../dist/simulation/packed-rows";
import { FakeClock, MINUTE } from "../support/clock";

/** The same "random" numbers on every run (a linear congruential generator). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe("packed rows", () => {
  const page = (rowCount: number, width: number, next: () => number): PackedTruthTable => ({
    inputIds: ["A", "B"],
    outputIds: Array.from({ length: width }, (_, k) => `Y${k}`),
    totalRows: 1024,
    offset: 40,
    rowCount,
    outputs: Uint8Array.from({ length: rowCount * width }, () => (next() < 0.5 ? 0 : 1)),
  });

  it("keeps every output value in one bit, and gives every one back", () => {
    const next = random(10);
    for (const [rowCount, width] of [[0, 3], [1, 1], [7, 1], [9, 7], [100, 0], [333, 13]] as const) {
      const original = page(rowCount, width, next);
      const stored = packRows(original);
      expect(stored.bits.length).toBe(Math.ceil((rowCount * width) / 8));
      expect(unpackRows(stored, original)).toEqual(original);
    }
  });

  it("puts the first value in the highest bit", () => {
    const stored = packRows({ ...page(1, 3, () => 0), outputs: Uint8Array.from([1, 0, 1]) });
    expect([...stored.bits]).toEqual([0b1010_0000]);
  });

  it("slices a page into smaller ones that share its memory", () => {
    const original = page(10, 2, random(11));
    const parts = [...slices(original, 4)];
    expect(parts.map((part) => [part.offset, part.rowCount])).toEqual([[40, 4], [44, 4], [48, 2]]);
    expect(parts.flatMap((part) => [...part.outputs])).toEqual([...original.outputs]);
    expect(parts[1]?.outputs.buffer).toBe(original.outputs.buffer);
  });
});

describe("the in-memory result cache", () => {
  const cache = (clock: FakeClock, cacheTtlSeconds = 3600) => new InMemoryResultCache(new AppConfig({ cacheTtlSeconds }), clock);

  it("forgets an entry when its time is up", async () => {
    const clock = new FakeClock();
    const results = cache(clock);
    expect(await results.set("k", "v")).toBe(true);
    clock.advance(60 * MINUTE - 1);
    expect(await results.get("k")).toBe("v");
    clock.advance(1);
    expect(await results.get("k")).toBeUndefined();
  });

  it("keeps nothing when caching is off (CACHE_TTL_SECONDS=0)", async () => {
    const results = cache(new FakeClock(), 0);
    expect(await results.set("k", "v")).toBe(false);
    expect(await results.get("k")).toBeUndefined();
  });

  it("drops the least recently used entries when it holds too much (32 MiB)", async () => {
    const results = cache(new FakeClock());
    const big = (letter: string): string => letter.repeat(12 * 1024 * 1024);
    await results.set("a", big("a"));
    await results.set("b", big("b"));
    await results.get("a"); // now "b" is the least recently used
    await results.set("c", big("c"));
    expect([await results.get("a"), await results.get("b"), await results.get("c")].map((value) => value?.[0])).toEqual(["a", undefined, "c"]);
    expect(await results.set("huge", big("h").repeat(3))).toBe(false); // larger than the whole cache
  });
});

describe("Redis errors", () => {
  const named = (name: string, message = "x"): Error => Object.assign(new Error(message), { name });
  it.each<[string, unknown, boolean, boolean]>([
    ["disconnected, commands not queued", new Error("Stream isn't writeable and enableOfflineQueue options is false"), true, true],
    ["no answer in time", new Error("Command timed out"), true, true],
    ["retried too often", named("MaxRetriesPerRequestError"), true, true],
    ["BullMQ's closed connection", named("ConnectionClosedError", "Connection is closed."), true, true],
    ["out of memory (noeviction)", new Error("OOM command not allowed when used memory > 'maxmemory'."), true, true],
    ["still loading after a restart", new Error("LOADING Redis is loading the dataset in memory"), true, true],
    ["refused connection, while reconnecting", Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6379"), { code: "ECONNREFUSED" }), false, true],
    ["a wrong command", new Error("ERR unknown command 'NOPE'"), false, false],
    ["not an error at all", "Command timed out", false, false],
  ])("%s: unavailable %s, connection trouble %s", (_, error, unavailable, connection) => {
    expect([isRedisUnavailable(error), isConnectionError(error)]).toEqual([unavailable, connection]);
  });

  it("are answered like a database outage: 503 and Retry-After, never a 500", () => {
    const fromRedis = toProblem(outageAsProblem(new Error("Command timed out")));
    const fromDatabase = toProblem(outageAsProblem({ code: "P1001" }));
    expect([fromRedis.status, fromRedis.body.code, fromRedis.headers["Retry-After"], fromRedis.body.detail]).toEqual([503, "server-unavailable", "5", "Redis is unavailable. Try again shortly."]);
    expect([fromDatabase.status, fromDatabase.body.detail]).toEqual([503, "The database is unavailable. Try again shortly."]);
    const other = new ApiError("not-found", "nope");
    expect(outageAsProblem(other)).toBe(other);
  });
});

describe("job pages", () => {
  it.each<[string, number, number, number]>([
    ["a tiny circuit: the most rows a page may hold", 10, 4, 65_536],
    ["30 gates", 30, 4, 34_952],
    ["128 gates: about 60 ms of work", 128, 8, 8192],
    ["10,000 gates", 10_000, 16, 104],
    ["many outputs: a page's values stay under a million", 100, 4096, 256],
    ["more outputs than a page may hold: still one row", 1, 2 ** 21, 1],
  ])("%s", (_, gates, outputs, rows) => {
    expect(pageRows({ gates, outputs: Array.from({ length: outputs }, (__, k) => `Y${k}`) })).toBe(rows);
  });
});
