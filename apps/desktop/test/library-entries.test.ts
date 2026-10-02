import { describe, expect, it } from "vitest";
import halfAdderText from "../../../examples/netlists/half-adder.net?raw";
import srLatchText from "../../../examples/netlists/sr-latch.net?raw";
import { LIBRARY_FORMAT, MAX_DESCRIPTION, isLibraryId, itemOf, makeEntry, newestFirst, readEntry, type LibraryEntry } from "../electron/library-entries";
import { readNetlist } from "../electron/offline";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const halfAdder = readNetlist(halfAdderText, "x");

function entry(overrides: Partial<LibraryEntry> = {}): LibraryEntry {
  return { ...makeEntry({ id: ID, previous: null, circuit: halfAdder, netlist: halfAdderText, description: undefined, now: "2026-10-02T10:00:00.000Z" }), ...overrides };
}

describe("isLibraryId", () => {
  it("accepts the UUIDs the app makes", () => {
    expect(isLibraryId(ID)).toBe(true);
    expect(isLibraryId(crypto.randomUUID())).toBe(true);
  });

  it("refuses anything else, so a crafted id can't reach other files", () => {
    for (const bad of ["../settings", "..\\..\\secret", "", "x".repeat(36), `${ID}.json`, 42, null]) expect(isLibraryId(bad)).toBe(false);
  });
});

describe("makeEntry", () => {
  it("keeps the netlist and a summary for the Library page", () => {
    const made = entry();
    expect(made).toMatchObject({ format: LIBRARY_FORMAT, id: ID, name: "Half adder", netlist: halfAdderText });
    expect(made.summary).toEqual({ gates: 6, inputs: ["A", "B"], outputs: ["S", "C"], feedbackLoop: null });
    expect(made.createdAt).toBe(made.updatedAt);
  });

  it("keeps the creation time when a circuit is saved again", () => {
    const first = entry();
    const again = makeEntry({ id: ID, previous: first, circuit: halfAdder, netlist: halfAdderText, description: undefined, now: "2026-10-03T08:00:00.000Z" });
    expect(again.createdAt).toBe("2026-10-02T10:00:00.000Z");
    expect(again.updatedAt).toBe("2026-10-03T08:00:00.000Z");
  });

  it("trims the description, cuts it at 2,000 characters, and leaves out a blank one", () => {
    const make = (description: string): LibraryEntry =>
      makeEntry({ id: ID, previous: null, circuit: halfAdder, netlist: halfAdderText, description, now: "2026-10-02T10:00:00.000Z" });
    expect(make("  Adds two bits.  ").description).toBe("Adds two bits.");
    expect(make("   ").description).toBeUndefined();
    expect(make("x".repeat(MAX_DESCRIPTION + 50)).description).toHaveLength(MAX_DESCRIPTION);
  });

  it("records a feedback loop, which the Library page shows", () => {
    const latch = readNetlist(srLatchText, "x");
    const made = makeEntry({ id: ID, previous: null, circuit: latch, netlist: srLatchText, description: undefined, now: "2026-10-02T10:00:00.000Z" });
    expect(made.summary.feedbackLoop).not.toBeNull();
  });
});

describe("readEntry", () => {
  it("reads back what was written", () => {
    const written = entry({ description: "Adds two bits." });
    expect(readEntry(JSON.parse(JSON.stringify(written)))).toEqual(written);
  });

  it("returns null for a damaged file, one edited by hand, or one from a newer app", () => {
    const good = entry();
    expect(readEntry(null)).toBeNull();
    expect(readEntry("text")).toBeNull();
    expect(readEntry({ ...good, format: 2 })).toBeNull();
    expect(readEntry({ ...good, id: "../x" })).toBeNull();
    expect(readEntry({ ...good, netlist: undefined })).toBeNull();
    expect(readEntry({ ...good, description: 7 })).toBeNull();
    expect(readEntry({ ...good, summary: { ...good.summary, inputs: "A" } })).toBeNull();
  });
});

describe("listing", () => {
  it("lists without the netlist, the most recently changed first", () => {
    const older = itemOf(entry({ updatedAt: "2026-10-01T09:00:00.000Z" }));
    const newer = itemOf(entry({ updatedAt: "2026-10-02T09:00:00.000Z" }));
    expect(older).not.toHaveProperty("netlist");
    expect([older, newer].sort(newestFirst)).toEqual([newer, older]);
  });
});
