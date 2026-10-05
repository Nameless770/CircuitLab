import { AppConfig } from "@circuitlab/api";
import { describe, expect, it } from "vitest";
import { RETENTION_BATCH, RETENTION_BATCHES_PER_RUN, Housekeeping } from "../../dist/jobs/housekeeping.service";
import { DAY, FakeClock } from "../support/clock";

const NOW = new Date("2026-10-05T12:00:00Z");

/** Housekeeping with stand-in repositories: sessions and jobs have nothing to clean, and each batch of old runs answers from a list. */
function housekeepingWith(batches: number[], retentionDays = 30): { housekeeping: Housekeeping; asked: { cutoff: Date; limit: number }[]; unused: () => number } {
  const asked: { cutoff: Date; limit: number }[] = [];
  const runs = {
    deleteFinishedBefore: async (cutoff: Date, limit: number): Promise<number> => {
      asked.push({ cutoff, limit });
      return batches.shift() ?? 0;
    },
  };
  const housekeeping = new Housekeeping({ deleteExpired: async () => 0 } as never, { failAbandoned: async () => [] } as never, runs as never, new AppConfig({ runRetentionDays: retentionDays }), new FakeClock(NOW));
  return { housekeeping, asked, unused: () => batches.length };
}

describe("housekeeping: retention of the history", () => {
  it("asks for the runs older than the retention period, a batch at a time, until a batch comes back short", async () => {
    const { housekeeping, asked } = housekeepingWith([RETENTION_BATCH, RETENTION_BATCH, 300]);
    expect((await housekeeping.run()).deletedRuns).toBe(2_300);
    expect(asked).toHaveLength(3);
    expect(asked.every((request) => request.limit === RETENTION_BATCH)).toBe(true);
    expect(asked.every((request) => request.cutoff.getTime() === NOW.getTime() - 30 * DAY)).toBe(true);
  });

  it("asks once more after a batch that was exactly full, since more may be waiting", async () => {
    const { housekeeping, asked } = housekeepingWith([RETENTION_BATCH, 0]);
    expect((await housekeeping.run()).deletedRuns).toBe(RETENTION_BATCH);
    expect(asked).toHaveLength(2);
  });

  it("asks once and stops when there is nothing old", async () => {
    const { housekeeping, asked } = housekeepingWith([]);
    expect((await housekeeping.run()).deletedRuns).toBe(0);
    expect(asked).toHaveLength(1);
  });

  it(`stops after ${RETENTION_BATCHES_PER_RUN} batches in one run, so one run never keeps the database busy for long, and leaves the rest for the next`, async () => {
    const { housekeeping, asked, unused } = housekeepingWith(Array.from({ length: RETENTION_BATCHES_PER_RUN + 10 }, () => RETENTION_BATCH));
    expect((await housekeeping.run()).deletedRuns).toBe(RETENTION_BATCHES_PER_RUN * RETENTION_BATCH);
    expect(asked).toHaveLength(RETENTION_BATCHES_PER_RUN);
    expect(unused()).toBe(10);
  });

  it("uses the number of days it is configured with", async () => {
    const { housekeeping, asked } = housekeepingWith([1], 7);
    await housekeeping.run();
    expect(asked[0]?.cutoff.getTime()).toBe(NOW.getTime() - 7 * DAY);
  });

  it("keeps the history for ever when the retention is 0 days, and doesn't even ask", async () => {
    const { housekeeping, asked } = housekeepingWith([RETENTION_BATCH], 0);
    expect((await housekeeping.run()).deletedRuns).toBe(0);
    expect(asked).toEqual([]);
  });
});
