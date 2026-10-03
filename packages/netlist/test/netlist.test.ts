import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { simulate, truthTable } from "@circuitlab/engine";
import { NetlistError, formatNetlist, importNetlist, importNetlistFile, parseNetlist, type NetlistIssue } from "@circuitlab/netlist";
import { describe, expect, it } from "vitest";
import { random, randomCircuit } from "../../engine/test/fixtures";

const NETLISTS = join(__dirname, "..", "..", "..", "examples", "netlists");
const EXAMPLES = ["half-adder.net", "full-adder.net", "c17.net", "sr-latch.net"];
const text = (file: string): string => readFileSync(join(NETLISTS, file), "utf8");

/** Bytes delivered in chunks of the given sizes, as a network upload would. */
function chunked(bytes: Uint8Array, sizes: (k: number) => number): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (let k = 0, at = 0; at < bytes.length; k++) {
      const size = Math.max(1, sizes(k));
      yield bytes.subarray(at, at + size);
      at += size;
    }
  })();
}

async function issuesOf(promise: Promise<unknown>): Promise<Omit<NetlistIssue, "message">[]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof NetlistError) return error.issues.map(({ message: _, ...rest }) => rest);
    throw error;
  }
  throw new Error("expected a NetlistError");
}

describe("reading netlists", () => {
  it("reads the half adder: names, types, pin order, and labels", () => {
    expect(parseNetlist(text("half-adder.net"))).toEqual({
      name: "Half adder",
      gates: [
        { id: "A", type: "INPUT" },
        { id: "B", type: "INPUT" },
        { id: "sum", type: "XOR" },
        { id: "carry", type: "AND" },
        { id: "S", type: "OUTPUT", label: "Sum" },
        { id: "C", type: "OUTPUT", label: "Carry" },
      ],
      wires: [
        { from: "A", to: "sum", toPin: 0 },
        { from: "B", to: "sum", toPin: 1 },
        { from: "A", to: "carry", toPin: 0 },
        { from: "B", to: "carry", toPin: 1 },
        { from: "sum", to: "S", toPin: 0 },
        { from: "carry", to: "C", toPin: 0 },
      ],
    });
  });

  it.each(EXAMPLES)("streams %s from disk to the same circuit as parsing it whole", async (file) => {
    expect(await importNetlistFile(join(NETLISTS, file))).toEqual(parseNetlist(text(file)));
  });

  it("gives the same circuit however the bytes are split into chunks, even inside a character", async () => {
    // Labels with multi-byte UTF-8 characters, so some chunk boundaries fall inside one.
    const source = 'A = INPUT "entrée"\nB = INPUT "B 🔌"\nx = XOR(A, B) "ouvert ⊕"\nY = OUTPUT(x)\n';
    const expected = parseNetlist(source);
    const bytes = new TextEncoder().encode(source);
    for (const size of [1, 2, 3, 5, 7, 64]) expect(await importNetlist(chunked(bytes, () => size))).toEqual(expected);
    const next = random(3);
    for (let n = 0; n < 20; n++) expect(await importNetlist(chunked(bytes, () => 1 + Math.floor(next() * 9)))).toEqual(expected);
  });

  it("accepts Windows line endings and a byte-order mark", async () => {
    const lf = text("full-adder.net").replaceAll("\r\n", "\n"); // whatever Git checked the file out as
    const windows = `\uFEFF${lf.replaceAll("\n", "\r\n")}`; // CRLF line endings, after a byte-order mark
    expect(parseNetlist(windows)).toEqual(parseNetlist(lf));
    expect(await importNetlist(Readable.from([Buffer.from(windows)]))).toEqual(parseNetlist(lf));
  });

  it("decompresses gzip on the fly", async () => {
    const gzipped = gzipSync(Buffer.from(text("c17.net")));
    expect(await importNetlist(chunked(gzipped, () => 10), { gzip: true })).toEqual(parseNetlist(text("c17.net")));
  });
});

describe("reporting problems", () => {
  it("lists every mistake in broken.net, each at its line, in file order", async () => {
    const issues = await issuesOf(importNetlistFile(join(NETLISTS, "broken.net")));
    // broken.net marks each of its mistakes with a "# <--" comment after the code.
    const marked = text("broken.net").split("\n").flatMap((line, k) => (/^[^#].*#\s*<--/.test(line) ? [k + 1] : []));
    expect(marked).toHaveLength(9);
    expect(issues.map(({ code, line }) => [code, line])).toEqual([
      ["UNKNOWN_DIRECTIVE", 3],
      ["DUPLICATE_GATE_ID", 7],
      ["INVALID_CONST_VALUE", 8],
      ["UNKNOWN_GATE_TYPE", 9],
      ["WRONG_INPUT_COUNT", 10],
      ["UNDEFINED_SIGNAL", 11],
      ["OUTPUT_AS_SOURCE", 13],
      ["SYNTAX_ERROR", 14],
      ["SYNTAX_ERROR", 15],
    ]);
    expect(issues.map((issue) => issue.line)).toEqual(marked); // exactly the marked lines, nothing else
  });

  it("points at the column of a syntax error", async () => {
    expect(await issuesOf(Promise.resolve().then(() => parseNetlist("A = INPUT\nx = AND(A,, A)\nY = OUTPUT(x)")))).toEqual([
      { code: "SYNTAX_ERROR", line: 2, column: 11 },
      // x was never defined, so using it on line 3 is a problem too.
      { code: "UNDEFINED_SIGNAL", line: 3, column: 12 },
    ]);
  });

  it("stops at a line longer than the limit, without reading the rest into memory", async () => {
    const endless = (async function* () {
      yield "A = INPUT\n";
      for (;;) yield "x".repeat(64 * 1024); // no line break, ever
    })();
    expect(await issuesOf(importNetlist(endless, { maxLineLength: 1000 }))).toEqual([{ code: "LINE_TOO_LONG", line: 2 }]);
  });

  it("stops at the gate limit", async () => {
    const issues = await issuesOf(Promise.resolve().then(() => parseNetlist("A = INPUT\nB = INPUT\nC = INPUT\nD = INPUT", { maxGates: 3 })));
    expect(issues.at(-1)).toEqual({ code: "TOO_MANY_GATES", line: 4 });
  });

  it("passes stream errors through unchanged: a missing file, a corrupt gzip", async () => {
    await expect(importNetlistFile(join(NETLISTS, "missing.net"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(importNetlist(Readable.from([Buffer.from("not gzip at all")]), { gzip: true })).rejects.toMatchObject({ code: "Z_DATA_ERROR" });
  });

  it("can be cancelled", async () => {
    const endless = (async function* () {
      for (;;) {
        yield "A = INPUT\n".repeat(100).replaceAll("A", () => `g${Math.random().toString(36).slice(2)}`);
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    await expect(importNetlist(endless, { signal: AbortSignal.timeout(50) })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("writing netlists", () => {
  it.each(EXAMPLES)("writes %s so that reading it back gives the same circuit", (file) => {
    const circuit = parseNetlist(text(file));
    expect(parseNetlist([...formatNetlist(circuit)].join(""))).toEqual(circuit);
  });

  it("round-trips 50 random circuits, which also behave the same", () => {
    const next = random(11);
    for (let n = 0; n < 50; n++) {
      const circuit = randomCircuit(next, 1 + Math.floor(next() * 4), 1 + Math.floor(next() * 30));
      const back = parseNetlist([...formatNetlist(circuit)].join(""));
      expect(back.gates).toEqual(circuit.gates);
      expect(back.wires).toEqual(circuit.wires);
      expect(truthTable(back)).toEqual(truthTable(circuit));
    }
  });

  it("refuses ids a netlist can't express", () => {
    const circuit = { gates: [{ id: "has space", type: "INPUT" }, { id: "Y", type: "OUTPUT" }], wires: [{ from: "has space", to: "Y", toPin: 0 }] };
    expect(() => formatNetlist(circuit)).toThrow(RangeError);
    expect(simulate(circuit as never, { "has space": 1 }).outputs).toEqual({ Y: 1 }); // the engine itself is fine with it
  });
});
