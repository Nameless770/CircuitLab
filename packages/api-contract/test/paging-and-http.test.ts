import {
  CIRCUIT_SORTS,
  checkExpectedVersion,
  checkTruthTableAllowed,
  circuitETag,
  circuitPage,
  circuitResource,
  compareCircuits,
  decodeCursor,
  encodeCursor,
  encodeTruthTable,
  ifMatchPasses,
  isAfterCursor,
  isNotModified,
  linkHeader,
  parseListCircuitsQuery,
  requestMediaType,
  responseMediaType,
  summarizeCircuit,
  toProblem,
  truthTableETag,
  truthTablePage,
  truthTableRange,
  type CircuitRecord,
} from "@circuitlab/api-contract";
import { truthTable } from "@circuitlab/engine";
import { describe, expect, it } from "vitest";
import { rippleCarryAdder } from "../../engine/test/fixtures";
import { expectConforms, issuesAt, problemOf, record, thrown } from "./helpers";

describe("cursor pagination", () => {
  const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 1, 12, minute));

  it.each(CIRCUIT_SORTS)("pages through sort=%s with no skips or repeats, while circuits are added between pages", (sort) => {
    // Many ties (same name, same time), so the id tie-break matters.
    let store: CircuitRecord[] = Array.from({ length: 25 }, (_, k) =>
      record({ id: `c${String(k).padStart(2, "0")}`, name: `Circuit ${k % 7}`, createdAt: at(k % 10), updatedAt: at(k) }),
    );
    const fetchPage = (query: ReturnType<typeof parseListCircuitsQuery>): CircuitRecord[] =>
      store.filter((item) => query.cursor === undefined || isAfterCursor(item, query.cursor)).sort(compareCircuits(query.sort)).slice(0, query.limit + 1);
    const seen: string[] = [];
    let query = parseListCircuitsQuery({ limit: "4", sort });
    for (let pages = 0; ; pages++) {
      const page = circuitPage(fetchPage(query), { ...query, scope: "owned" }, "/v1/circuits");
      expectConforms("CircuitPage", page);
      seen.push(...page.items.map((item) => item.id));
      if (pages === 1) store = [...store, record({ id: "zz-new", name: "Circuit 0", createdAt: at(59), updatedAt: at(59) })];
      if (page.links.next === null) {
        expect(page.page.nextCursor).toBeNull();
        break;
      }
      const next = new URL(page.links.next, "http://x").searchParams;
      expect(next.get("scope")).toBe("owned"); // the next link keeps listing the same circuits
      query = parseListCircuitsQuery(Object.fromEntries(next));
    }
    const original = seen.filter((id) => id !== "zz-new");
    expect(original).toEqual(store.filter((item) => item.id !== "zz-new").sort(compareCircuits(sort)).map((item) => item.id));
  });

  it("validates cursors as untrusted input", () => {
    const good = encodeCursor({ sort: "name", value: "x", id: "c1" });
    expect(decodeCursor(good, "name")).toEqual({ sort: "name", value: "x", id: "c1" });
    for (const bad of ["abc", Buffer.from('[2,"name","x","c"]').toString("base64url"), Buffer.from('{"a":1}').toString("base64url"), Buffer.from('[1,"name",5,"c"]').toString("base64url")]) {
      expect(issuesAt(toProblem(thrown(() => decodeCursor(bad, "name"))))).toEqual(["INVALID_CURSOR@cursor"]);
    }
    expect(toProblem(thrown(() => decodeCursor(good, "-createdAt"))).body.issues?.[0]?.message).toMatch(/made for sort=name/);
    expect(issuesAt(problemOf(() => parseListCircuitsQuery({ cursor: "not base64!" })))).toEqual(["INVALID_FORMAT@cursor"]);
  });

  it("writes RFC 8288 Link headers", () => {
    expect(linkHeader({ next: "/v1/circuits?cursor=abc", prev: null })).toBe('</v1/circuits?cursor=abc>; rel="next"');
  });
});

describe("truth-table ranges and pages", () => {
  it("default to 256 JSON rows, and refuse oversized pages and downloads before computing anything", () => {
    expect(truthTableRange({ offset: 0 }, 4, "json")).toEqual({ offset: 0, limit: 256 });
    expect(toProblem(thrown(() => truthTableRange({ offset: 0, limit: 5000 }, 1e6, "json"))).body.issues?.[0]?.parameter).toBe("limit");
    expect(truthTableRange({ offset: 0 }, 2 ** 20, "csv")).toEqual({ offset: 0, limit: 2 ** 20 });
    expect(toProblem(thrown(() => truthTableRange({ offset: 0 }, 2 ** 21, "csv"))).body.issues?.[0]?.message).toMatch(/2,097,152 rows from offset 0/);
  });

  it("link to the first, previous, next, and last pages, pinned to the version", () => {
    const adder = rippleCarryAdder(2); // 5 inputs, 32 rows
    const page = truthTablePage(truthTable(adder, { offset: 8, limit: 8 }), { circuitId: "c9", version: 4, limit: 8, basePath: "/p" });
    expectConforms("TruthTablePage", page);
    expect(page.links).toEqual({
      self: "/p?offset=8&limit=8&version=4",
      first: "/p?offset=0&limit=8&version=4",
      prev: "/p?offset=0&limit=8&version=4",
      next: "/p?offset=16&limit=8&version=4",
      last: "/p?offset=24&limit=8&version=4",
    });
    expect(truthTablePage(truthTable(adder, { offset: 24, limit: 8 }), { circuitId: "c9", version: 4, limit: 8, basePath: "/p" }).links.next).toBeNull();
  });

  it("refuse a changed circuit, a loop, or too many inputs", () => {
    expect(() => checkExpectedVersion(4, 4)).not.toThrow();
    expect(toProblem(thrown(() => checkExpectedVersion(3, 4))).status).toBe(409);
    const loop = summarizeCircuit({ gates: [{ id: "q", type: "NOT" }], wires: [{ from: "q", to: "q", toPin: 0 }] });
    expect(toProblem(thrown(() => checkTruthTableAllowed(loop))).body.code).toBe("feedback-loop");
    const wide = summarizeCircuit({ gates: Array.from({ length: 54 }, (_, k) => ({ id: `i${k}`, type: "INPUT" as const })), wires: [] });
    expect(toProblem(thrown(() => checkTruthTableAllowed(wide))).body.code).toBe("too-many-inputs");
  });

  it("stream as CSV (RFC 4180 line ends) and as NDJSON, each line standing alone", async () => {
    const adder = rippleCarryAdder(2);
    let csv = "";
    for await (const chunk of encodeTruthTable([truthTable(adder, { offset: 5, limit: 2 })], "csv")) csv += chunk;
    expect(csv).toBe("#,a1,a0,b1,b0,cin,cout,s1,s0\r\n5,0,0,1,0,1,0,1,1\r\n6,0,0,1,1,0,0,1,1\r\n");
    let ndjson = "";
    for await (const chunk of encodeTruthTable([truthTable(adder, { offset: 31, limit: 1 })], "ndjson")) ndjson += chunk;
    const line = JSON.parse(ndjson);
    expect(line).toEqual({ index: 31, inputs: { a1: 1, a0: 1, b1: 1, b0: 1, cin: 1 }, outputs: { cout: 1, s1: 1, s0: 1 } });
    expectConforms("TruthTableStreamRow", line);
  });
});

describe("content negotiation", () => {
  it("reads request media types, ignoring case and parameters; anything else is 415", () => {
    expect(requestMediaType("createCircuit", "application/json; charset=utf-8")).toBe("application/json");
    expect(requestMediaType("createCircuit", "TEXT/VND.CIRCUITLAB.NETLIST")).toBe("text/vnd.circuitlab.netlist");
    expect(requestMediaType("register", "application/json")).toBe("application/json");
    expect(toProblem(thrown(() => requestMediaType("simulateCircuit", "text/plain"))).status).toBe(415);
    expect(toProblem(thrown(() => requestMediaType("createCircuit", undefined))).status).toBe(415);
  });

  it.each([
    [undefined, "application/json"],
    ["*/*", "application/json"],
    ["text/csv", "text/csv"],
    ["text/*", "text/csv"],
    ["application/json;q=0.5, application/x-ndjson", "application/x-ndjson"],
    ["text/html, */*;q=0.1", "application/json"],
    ["text/csv;q=0, */*", "application/json"],
  ])("picks the truth-table format for Accept: %s", (accept, expected) => {
    expect(responseMediaType("getTruthTable", accept)).toBe(expected);
  });

  it("answers 406 when nothing acceptable is available", () => {
    expect(toProblem(thrown(() => responseMediaType("getTruthTable", "image/png"))).status).toBe(406);
  });
});

describe("ETags", () => {
  it("name a circuit version, per representation", () => {
    expect(circuitETag(7)).toBe('"7"');
    expect(circuitETag(7, "netlist")).toBe('"7-netlist"');
    expect(truthTableETag(7, 0, 256, "json")).toBe('"7-rows-0-256-json"');
  });

  it.each([
    [undefined, true],
    ["*", true],
    ['"7"', true],
    ['"7-netlist"', true],
    ['"6", "7"', true],
    ['"6"', false],
    ['W/"7"', false], // If-Match compares strongly
    ['"70"', false],
    ["7", false], // not an entity tag without quotes
  ])("If-Match %s against version 7: %s", (header, passes) => {
    expect(ifMatchPasses(header, 7)).toBe(passes);
  });

  it("If-None-Match compares weakly", () => {
    expect(isNotModified('"7"', '"7"')).toBe(true);
    expect(isNotModified('W/"7"', '"7"')).toBe(true);
    expect(isNotModified('"6"', '"7"')).toBe(false);
    expect(isNotModified(undefined, '"7"')).toBe(false);
  });
});

describe("resources", () => {
  it("serialize circuits as the spec says, with owner and visibility", () => {
    const resource = circuitResource(record({ visibility: "public", description: "d" }));
    expectConforms("Circuit", resource);
    expect(resource).toMatchObject({ owner: { id: "u1", displayName: "Ada" }, visibility: "public", version: 3 });
  });
});
