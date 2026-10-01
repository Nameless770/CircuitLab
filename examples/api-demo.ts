/**
 * Phase 3 demo: what the CircuitLab REST API answers, request by request.
 *
 *   npm run demo:api        (from the repository root)
 *
 * There is no HTTP server yet; that is phase 4. Each exchange below runs the same contract code
 * the server will run (@circuitlab/api-contract, with simulations on a real worker pool) and
 * prints the response it produces. Storage is a plain array here; phases 5 and 6 replace it.
 */
import { STATUS_CODES } from "node:http";
import { join } from "node:path";
import {
  ApiError,
  LIMITS,
  checkExpectedVersion,
  checkTruthTableAllowed,
  circuitETag,
  circuitInputFromNetlist,
  circuitPage,
  circuitResource,
  compareCircuits,
  encodeTruthTable,
  ifMatchPasses,
  isAfterCursor,
  isNotModified,
  linkHeader,
  parseCircuitInput,
  parseCircuitWriteQuery,
  parseListCircuitsQuery,
  parseSimulateQuery,
  parseSimulateRequest,
  parseTruthTableQuery,
  requestMediaType,
  responseMediaType,
  simulationResponse,
  summarizeCircuit,
  toProblem,
  truthTableFormat,
  truthTablePage,
  truthTableRange,
  validationReport,
  type CircuitRecord,
} from "@circuitlab/api-contract";
import { NetlistError, importNetlist, importNetlistFile } from "@circuitlab/netlist";
import { SimulationPool } from "@circuitlab/runner";
import { createReadStream } from "node:fs";
import { rippleCarryAdder, section } from "./circuits";

const netlist = (name: string): string => join(__dirname, "..", "netlists", name);

// ---------------------------------------------------------------------------------------------
// Printing exchanges
// ---------------------------------------------------------------------------------------------

interface Reply {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** Prints a request, runs `handle`, and prints the reply, turning any error into its problem response. */
async function exchange(request: string, path: string, handle: () => Promise<Reply> | Reply): Promise<void> {
  console.log(request.replace(/^/gm, "  > "));
  let reply: Reply;
  try {
    reply = await handle();
  } catch (error) {
    reply = toProblem(error, path);
  }
  const lines = [`${reply.status} ${STATUS_CODES[reply.status] ?? ""}`];
  for (const [name, value] of Object.entries(reply.headers ?? {})) lines.push(`${name}: ${value}`);
  // (CSV lines end in CRLF, as RFC 4180 says; shown here with plain line breaks.)
  if (reply.body !== undefined) lines.push("", typeof reply.body === "string" ? reply.body.replaceAll("\r\n", "\n").trimEnd() : pretty(reply.body));
  console.log(lines.join("\n").replace(/^/gm, "  < "));
  console.log();
}

/** JSON with two-space indents, but short arrays of plain values kept on one line. */
function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_, inner: string) => `[${inner.replace(/\s*\n\s*/g, " ")}]`);
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Reply => ({
  status,
  headers: { "Content-Type": "application/json", ...headers },
  body,
});

// ---------------------------------------------------------------------------------------------
// A stand-in for storage (phases 5 and 6), holding a few circuits
// ---------------------------------------------------------------------------------------------

const store: CircuitRecord[] = [];

/** Every circuit needs an owner (phase 7). The stored ones are public, as for a signed-out visitor. */
const ADA = { id: "u1", displayName: "Ada" };

async function seed(): Promise<void> {
  const sources = [
    await importNetlistFile(netlist("half-adder.net")),
    await importNetlistFile(netlist("full-adder.net")),
    await importNetlistFile(netlist("c17.net")),
    await importNetlistFile(netlist("sr-latch.net")),
    rippleCarryAdder(4),
  ];
  sources.forEach((circuit, k) => {
    const at = new Date(Date.UTC(2026, 9, 1, 9, 0) + k * 60_000);
    store.push({
      ...circuit,
      id: `c${k + 1}`,
      name: circuit.name ?? "Untitled",
      description: null,
      owner: ADA,
      visibility: "public",
      version: 1,
      createdAt: at,
      updatedAt: at,
      summary: summarizeCircuit(circuit),
    });
  });
}

function find(id: string): CircuitRecord {
  const record = store.find((candidate) => candidate.id === id);
  if (record === undefined) throw new ApiError("not-found", `No circuit has the id "${id}".`);
  return record;
}

// ---------------------------------------------------------------------------------------------
// The exchanges
// ---------------------------------------------------------------------------------------------

async function listing(): Promise<void> {
  section("1. Listing circuits: cursor pagination");
  const list = (query: Record<string, string>): Reply => {
    // A signed-out visitor sees the public circuits.
    const parsed = { scope: "public" as const, ...parseListCircuitsQuery(query) };
    // What storage does: the rows after the cursor, in order, one more than the page size.
    const fetched = store
      .filter((record) => parsed.cursor === undefined || isAfterCursor(record, parsed.cursor))
      .sort(compareCircuits(parsed.sort))
      .slice(0, parsed.limit + 1);
    const page = circuitPage(fetched, parsed, "/v1/circuits");
    return json(200, page, page.links.next === null ? {} : { Link: linkHeader({ next: page.links.next }) });
  };

  await exchange("GET /v1/circuits?limit=2", "/v1/circuits", () => list({ limit: "2" }));

  const firstPage = { scope: "public" as const, ...parseListCircuitsQuery({ limit: "2" }) };
  const next = circuitPage(store.slice().sort(compareCircuits("-createdAt")).slice(0, 3), firstPage, "/v1/circuits").page.nextCursor ?? "";
  await exchange(`GET /v1/circuits?limit=2&cursor=${next}   (the next link from above)`, "/v1/circuits", () => list({ limit: "2", cursor: next }));

  await exchange("GET /v1/circuits?limit=500&sort=oldest&cursor=not-a-cursor", "/v1/circuits", () =>
    list({ limit: "500", sort: "oldest", cursor: "not-a-cursor" }),
  );
}

async function creating(): Promise<void> {
  section("2. Creating circuits: every problem at once, each one located");
  const create = async (contentType: string, body: unknown, query: Record<string, string> = {}): Promise<Reply> => {
    const mediaType = requestMediaType("createCircuit", contentType);
    const kind = mediaType === "application/json" ? "json" : "netlist";
    const options = parseCircuitWriteQuery("createCircuit", query, kind);
    const input =
      kind === "json"
        ? parseCircuitInput(body)
        : circuitInputFromNetlist(await importNetlist(createReadStream(String(body)), { maxGates: LIMITS.maxGates }), options);
    if (options.dryRun) return json(200, validationReport(input));
    const now = new Date(Date.UTC(2026, 9, 1, 12, 0));
    const record: CircuitRecord = {
      ...input,
      id: "c6",
      description: input.description ?? null,
      owner: ADA,
      visibility: "private",
      version: 1,
      createdAt: now,
      updatedAt: now,
      summary: summarizeCircuit(input),
    };
    return json(201, circuitResource(record), { Location: `/v1/circuits/${record.id}`, ETag: circuitETag(record.version) });
  };

  const shapeProblems = {
    name: "  ",
    colour: "blue",
    gates: [
      { id: "A", type: "INPUT" },
      { id: "one", type: "CONST" },
      { id: "x", type: "XOR", value: 1 },
      { id: "maj", type: "MAJORITY" },
      { id: "out put", type: "OUTPUT" },
    ],
    wires: [{ from: "A", to: "x", toPin: 64 }],
  };
  await exchange(`POST /v1/circuits\nContent-Type: application/json\n\n${JSON.stringify(shapeProblems)}`, "/v1/circuits", () =>
    create("application/json", shapeProblems),
  );

  const logicProblems = {
    name: "Wiring mistakes",
    gates: [
      { id: "A", type: "INPUT" },
      { id: "g", type: "AND" },
      { id: "Y", type: "OUTPUT" },
    ],
    wires: [
      { from: "A", to: "g", toPin: 0 },
      { from: "ghost", to: "Y", toPin: 0 },
    ],
  };
  await exchange(`POST /v1/circuits\nContent-Type: application/json\n\n${JSON.stringify(logicProblems)}`, "/v1/circuits", () =>
    create("application/json", logicProblems),
  );

  await exchange("POST /v1/circuits\nContent-Type: text/vnd.circuitlab.netlist\n\n<contents of examples/netlists/broken.net>", "/v1/circuits", () =>
    create("text/vnd.circuitlab.netlist", netlist("broken.net")),
  );

  await exchange("POST /v1/circuits?dryRun=true\nContent-Type: text/vnd.circuitlab.netlist\n\n<contents of examples/netlists/sr-latch.net>", "/v1/circuits", () =>
    create("text/vnd.circuitlab.netlist", netlist("sr-latch.net"), { dryRun: "true" }),
  );

  const good = { name: "Buffer", gates: [{ id: "A", type: "INPUT" }, { id: "Y", type: "OUTPUT" }], wires: [{ from: "A", to: "Y", toPin: 0 }] };
  await exchange(`POST /v1/circuits\nContent-Type: application/json\n\n${JSON.stringify(good)}`, "/v1/circuits", () => create("application/json", good));

  await exchange("POST /v1/circuits\nContent-Type: text/plain\n\nA = INPUT", "/v1/circuits", () => create("text/plain", "A = INPUT"));
}

async function simulating(pool: SimulationPool): Promise<void> {
  section("3. Simulating: the engine's errors, mapped to HTTP");
  const simulate = async (id: string, body: unknown, query: Record<string, string> = {}): Promise<Reply> => {
    const record = find(id);
    const { includeSignals } = parseSimulateQuery(query);
    const { inputs } = parseSimulateRequest(body);
    const result = await pool.simulate(record, inputs, { signal: AbortSignal.timeout(LIMITS.simulationTimeoutMs) });
    return json(200, simulationResponse(record, result, includeSignals));
  };

  await exchange('POST /v1/circuits/c1/simulate?include=signals\n\n{"inputs": {"A": 1, "B": 1}}', "/v1/circuits/c1/simulate", () =>
    simulate("c1", { inputs: { A: 1, B: 1 } }, { include: "signals" }),
  );
  await exchange('POST /v1/circuits/c1/simulate\n\n{"inputs": {"A": "1", "Cin": 0}}', "/v1/circuits/c1/simulate", () =>
    simulate("c1", { inputs: { A: "1", Cin: 0 } }),
  );
  await exchange('POST /v1/circuits/c4/simulate   (the SR latch)\n\n{"inputs": {"S": 1, "R": 0}}', "/v1/circuits/c4/simulate", () =>
    simulate("c4", { inputs: { S: 1, R: 0 } }),
  );
  await exchange('POST /v1/circuits/nope/simulate\n\n{"inputs": {}}', "/v1/circuits/nope/simulate", () => simulate("nope", { inputs: {} }));
}

async function truthTables(pool: SimulationPool): Promise<void> {
  section("4. Truth tables: offset pagination, versions, and formats");
  const getTable = async (id: string, query: Record<string, string>, accept?: string): Promise<Reply> => {
    const record = find(id);
    const mediaType = responseMediaType("getTruthTable", accept);
    const format = truthTableFormat(mediaType);
    const parsed = parseTruthTableQuery(query);
    checkExpectedVersion(parsed.version, record.version);
    const summary = summarizeCircuit(record);
    checkTruthTableAllowed(summary);
    const range = truthTableRange(parsed, 2 ** summary.inputs.length, format);
    if (format === "json") {
      const table = await pool.truthTable(record, range);
      return json(200, truthTablePage(table, { circuitId: id, version: record.version, limit: range.limit, basePath: `/v1/circuits/${id}/truth-table` }));
    }
    let text = "";
    for await (const chunk of encodeTruthTable(pool.truthTablePages(record, range), format)) text += chunk;
    return { status: 200, headers: { "Content-Type": mediaType }, body: text };
  };

  await exchange("GET /v1/circuits/c2/truth-table?offset=2&limit=3", "/v1/circuits/c2/truth-table", () =>
    getTable("c2", { offset: "2", limit: "3" }),
  );
  await exchange("GET /v1/circuits/c2/truth-table\nAccept: text/csv", "/v1/circuits/c2/truth-table", () => getTable("c2", {}, "text/csv"));
  await exchange("GET /v1/circuits/c2/truth-table?offset=6&limit=2\nAccept: application/x-ndjson", "/v1/circuits/c2/truth-table", () =>
    getTable("c2", { offset: "6", limit: "2" }, "application/x-ndjson"),
  );

  // Someone edits the circuit while a client is paging through its table.
  const fullAdder = find("c2");
  store[store.indexOf(fullAdder)] = { ...fullAdder, version: 2 };
  await exchange("GET /v1/circuits/c2/truth-table?offset=3&limit=3&version=1   (a next link from before the edit)", "/v1/circuits/c2/truth-table", () =>
    getTable("c2", { offset: "3", limit: "3", version: "1" }),
  );
  await exchange("GET /v1/circuits/c5/truth-table?limit=5000", "/v1/circuits/c5/truth-table", () => getTable("c5", { limit: "5000" }));
  await exchange("GET /v1/circuits/c2/truth-table\nAccept: image/png", "/v1/circuits/c2/truth-table", () => getTable("c2", {}, "image/png"));
}

async function conditional(): Promise<void> {
  section("5. Conditional requests: caching and lost updates");
  const record = find("c1");
  await exchange(`GET /v1/circuits/c1\nIf-None-Match: ${circuitETag(record.version)}`, "/v1/circuits/c1", () =>
    isNotModified(circuitETag(record.version), circuitETag(record.version))
      ? { status: 304, headers: { ETag: circuitETag(record.version) } }
      : json(200, circuitResource(record)),
  );

  // Two people load version 1; the first one saves, which makes it version 2.
  store[store.indexOf(record)] = { ...record, version: 2 };
  await exchange('PUT /v1/circuits/c1\nIf-Match: "1"   (the second person, still editing version 1)\n\n{...}', "/v1/circuits/c1", () => {
    const current = find("c1");
    if (!ifMatchPasses('"1"', current.version)) {
      throw new ApiError("precondition-failed", `The circuit changed since you loaded it (it is now version ${current.version}). Reload it and apply your change again.`);
    }
    return json(200, circuitResource(current));
  });
}

async function overload(): Promise<void> {
  section("6. When the server is overloaded, slow, or broken");
  const tiny = new SimulationPool({ size: 1, maxQueue: 0 });
  const halfAdder = find("c1");
  const busy = tiny.truthTable(rippleCarryAdder(10)).catch(() => undefined); // occupies the only worker
  try {
    await exchange('POST /v1/circuits/c1/simulate   (while the only worker is busy and no waiting is allowed)\n\n{"inputs": {"A": 1, "B": 0}}', "/v1/circuits/c1/simulate", async () =>
      json(200, simulationResponse(halfAdder, await tiny.simulate(halfAdder, { A: 1, B: 0 }), false)),
    );
  } finally {
    await tiny.destroy();
    await busy;
  }

  const slow = new SimulationPool({ size: 1 });
  try {
    await exchange(`GET /v1/circuits/big/truth-table?limit=4096   (the ${LIMITS.simulationTimeoutMs / 1000} s time limit, cut to 50 ms for this demo)`, "/v1/circuits/big/truth-table", async () =>
      json(200, await slow.truthTable(rippleCarryAdder(40), { limit: 4096 }, { signal: AbortSignal.timeout(50) })),
    );
  } finally {
    await slow.close();
  }

  await exchange("GET /v1/circuits/c1   (a bug in the server)", "/v1/circuits/c1", () => {
    throw new TypeError("Cannot read properties of undefined (reading 'passwordHash')");
  });
}

async function main(): Promise<void> {
  await seed();
  const pool = new SimulationPool({ size: 2 });
  try {
    await listing();
    await creating();
    await simulating(pool);
    await truthTables(pool);
  } finally {
    await pool.close();
  }
  await conditional();
  await overload();
}

main().catch((error: unknown) => {
  console.error(error instanceof NetlistError ? error.message : error);
  process.exitCode = 1;
});
