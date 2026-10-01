/**
 * Phase 4 demo: the real NestJS app, driven over HTTP.
 *
 *   npm run demo:http        (from the repository root)
 *
 * Starts the API on a free port (one simulation worker, no waiting queue, so overload is easy to
 * show), runs a scripted session with fetch(), and shuts down the way SIGTERM would. Since phase 7
 * circuits belong to accounts, so the session starts by registering one; phase 7's own demo
 * (demo:auth) is about who may see and change what.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { AppConfig, createApp } from "@circuitlab/api";
import { print, rippleCarryAdder, section } from "./circuits";

const netlist = (name: string): Promise<Buffer> => readFile(join(__dirname, "..", "netlists", name));
const JSON_TYPE = { "Content-Type": "application/json" };
const NETLIST_TYPE = { "Content-Type": "text/vnd.circuitlab.netlist" };

let base = "";
/** The demo user's access token, sent with every request. */
let token = "";

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly body: any; // parsed JSON, when the answer is JSON
}

async function call(method: string, path: string, init: { body?: string | Uint8Array; headers?: Record<string, string> } = {}): Promise<Answer> {
  const headers = { ...(token !== "" && { Authorization: `Bearer ${token}` }), ...init.headers };
  const response = await fetch(base + path, { method, ...init, headers });
  const text = await response.text();
  const isJson = /json/.test(response.headers.get("content-type") ?? "");
  return { status: response.status, headers: response.headers, text, body: isJson && text !== "" ? JSON.parse(text) : undefined };
}

/** One line per exchange: the request, the status, and what matters in the answer. */
function show(request: string, answer: Answer, detail = ""): void {
  const issue = answer.body?.issues?.[0];
  const where = issue === undefined ? "" : ` (${issue.parameter ?? issue.pointer ?? `line ${issue.line}`}: ${issue.message})`;
  const problem = answer.body?.code !== undefined && answer.status >= 400 ? `${answer.body.code}: ${answer.body.detail}${where}` : "";
  print(`${request}\n  -> ${answer.status} ${detail || problem}`.trimEnd());
}

const header = (answer: Answer, name: string): string => `${name}: ${answer.headers.get(name) ?? "(none)"}`;

interface Ids {
  half: string;
  full: string;
  c17: string;
  latch: string;
}

async function creating(): Promise<Ids> {
  section("1. Creating circuits: JSON, netlist files, gzip");
  const ids: Ids = { half: "", full: "", c17: "", latch: "" };
  const halfAdder = {
    name: "Half adder",
    gates: [
      { id: "A", type: "INPUT" },
      { id: "B", type: "INPUT" },
      { id: "sum", type: "XOR" },
      { id: "carry", type: "AND" },
      { id: "S", type: "OUTPUT" },
      { id: "C", type: "OUTPUT" },
    ],
    wires: [
      { from: "A", to: "sum", toPin: 0 },
      { from: "B", to: "sum", toPin: 1 },
      { from: "A", to: "carry", toPin: 0 },
      { from: "B", to: "carry", toPin: 1 },
      { from: "sum", to: "S", toPin: 0 },
      { from: "carry", to: "C", toPin: 0 },
    ],
  };
  let answer = await call("POST", "/v1/circuits", { body: JSON.stringify(halfAdder), headers: JSON_TYPE });
  ids.half = answer.body.id;
  show("POST /v1/circuits  (JSON)", answer, `${header(answer, "Location")}, ${header(answer, "ETag")}`);

  answer = await call("POST", "/v1/circuits", { body: await netlist("full-adder.net"), headers: NETLIST_TYPE });
  ids.full = answer.body.id;
  show("POST /v1/circuits  (netlist file full-adder.net, streamed into the parser)", answer, `"${answer.body.name}", ${answer.body.summary.gates} gates`);

  answer = await call("POST", "/v1/circuits?name=ISCAS%20c17", {
    body: gzipSync(await netlist("c17.net")),
    headers: { ...NETLIST_TYPE, "Content-Encoding": "gzip" },
  });
  ids.c17 = answer.body.id;
  show("POST /v1/circuits?name=ISCAS%20c17  (gzipped netlist)", answer, `"${answer.body.name}", inputs ${answer.body.summary.inputs.join(" ")}`);

  answer = await call("POST", "/v1/circuits", { body: await netlist("sr-latch.net"), headers: NETLIST_TYPE });
  ids.latch = answer.body.id;
  show("POST /v1/circuits  (sr-latch.net)", answer, `stored; summary.feedbackLoop = ${answer.body.summary.feedbackLoop.join(" -> ")}`);

  answer = await call("POST", "/v1/circuits", { body: await netlist("broken.net"), headers: NETLIST_TYPE });
  const first = answer.body.issues[0];
  show("POST /v1/circuits  (broken.net)", answer, `${answer.body.code}: ${answer.body.issues.length} issues, first at line ${first.line}: ${first.message}`);

  show('POST /v1/circuits  {"name": "x", gates: }', await call("POST", "/v1/circuits", { body: '{"name": "x", gates: }', headers: JSON_TYPE }));
  show("POST /v1/circuits  (Content-Type: text/plain)", await call("POST", "/v1/circuits", { body: "A = INPUT", headers: { "Content-Type": "text/plain" } }));
  return ids;
}

async function listing(): Promise<void> {
  section("2. Listing: cursor pages and Link headers");
  let answer = await call("GET", "/v1/circuits?limit=2");
  show("GET /v1/circuits?limit=2", answer, answer.body.items.map((item: { name: string }) => item.name).join(", "));
  const next = /<([^>]+)>/.exec(answer.headers.get("link") ?? "")?.[1] ?? "";
  print(`  ${header(answer, "Link").slice(0, 110)}...`);
  answer = await call("GET", next);
  show("GET <the next link>", answer, `${answer.body.items.map((item: { name: string }) => item.name).join(", ")}; next: ${answer.body.page.nextCursor}`);
  show("GET /v1/circuits?q=adder&sort=name", (answer = await call("GET", "/v1/circuits?q=adder&sort=name")), answer.body.items.map((item: { name: string }) => item.name).join(", "));
  show("GET /v1/circuits?limit=500", await call("GET", "/v1/circuits?limit=500"));
}

async function simulating(ids: Ids): Promise<void> {
  section("3. Simulating on the shared worker pool");
  let answer = await call("POST", `/v1/circuits/${ids.half}/simulate`, { body: '{"inputs": {"A": 1, "B": 1}}', headers: JSON_TYPE });
  show('POST .../simulate  {"inputs": {"A": 1, "B": 1}}', answer, `outputs ${JSON.stringify(answer.body.outputs)}`);
  answer = await call("POST", `/v1/circuits/${ids.half}/simulate`, { body: '{"inputs": {"A": "1", "Cin": 0}}', headers: JSON_TYPE });
  show('POST .../simulate  {"inputs": {"A": "1", "Cin": 0}}', answer, `${answer.body.code}: ${answer.body.issues.map((issue: { pointer: string }) => issue.pointer).join(", ")}`);
  answer = await call("POST", `/v1/circuits/${ids.latch}/simulate`, { body: '{"inputs": {"S": 1, "R": 0}}', headers: JSON_TYPE });
  show("POST .../simulate  (the SR latch)", answer);
  show("POST /v1/circuits/no-such-id/simulate", await call("POST", "/v1/circuits/no-such-id/simulate", { body: '{"inputs": {}}', headers: JSON_TYPE }));
}

async function truthTables(ids: Ids): Promise<void> {
  section("4. Truth tables: pages, downloads, and 304 Not Modified");
  const path = `/v1/circuits/${ids.full}/truth-table`;
  let answer = await call("GET", `${path}?limit=4`);
  const rows = answer.body.rows.map((row: { inputs: number[]; outputs: number[] }) => `${row.inputs.join("")}->${row.outputs.join("")}`);
  show(`GET .../truth-table?limit=4`, answer, `rows ${rows.join(" ")}, ${header(answer, "ETag")}`);
  const etag = answer.headers.get("etag") ?? "";
  show(`GET .../truth-table?limit=4  (If-None-Match: ${etag})`, await call("GET", `${path}?limit=4`, { headers: { "If-None-Match": etag } }), "(no body: the client's copy is current)");
  answer = await call("GET", path, { headers: { Accept: "text/csv" } });
  show("GET .../truth-table  (Accept: text/csv)", answer, header(answer, "Content-Type"));
  // CSV lines end in CRLF (RFC 4180); shown here with plain line breaks.
  print(answer.text.replaceAll("\r\n", "\n").trimEnd().replace(/^/gm, "     "));
  show("GET .../truth-table  (Accept: image/png)", await call("GET", path, { headers: { Accept: "image/png" } }));
}

async function editing(ids: Ids): Promise<void> {
  section("5. Editing safely: ETags and If-Match");
  const path = `/v1/circuits/${ids.half}`;
  let answer = await call("PATCH", path, {
    body: '{"name": "Half adder (renamed)"}',
    headers: { "Content-Type": "application/merge-patch+json", "If-Match": '"1"' },
  });
  show(`PATCH .../${ids.half.slice(0, 8)}...  If-Match: "1"`, answer, `"${answer.body.name}", ${header(answer, "ETag")}`);
  show(`PUT .../${ids.half.slice(0, 8)}...  If-Match: "1"  (a second editor, still on version 1)`, await call("PUT", path, {
    body: await netlist("half-adder.net"),
    headers: { ...NETLIST_TYPE, "If-Match": '"1"' },
  }));
  answer = await call("GET", path, { headers: { Accept: "text/vnd.circuitlab.netlist" } });
  show(`GET .../${ids.half.slice(0, 8)}...  (Accept: text/vnd.circuitlab.netlist)`, answer, header(answer, "ETag"));
  print(answer.text.trimEnd().replace(/^/gm, "     "));
  show(`DELETE .../${ids.half.slice(0, 8)}...  If-Match: "2"`, await call("DELETE", path, { headers: { "If-Match": '"2"' } }), "(deleted)");
  show(`GET .../${ids.half.slice(0, 8)}...`, await call("GET", path));
}

async function overload(): Promise<void> {
  section("6. One worker, no queue: overload and cancellation");
  const adder = rippleCarryAdder(20);
  const created = await call("POST", "/v1/circuits", { body: JSON.stringify({ name: adder.name, gates: adder.gates, wires: adder.wires }), headers: JSON_TYPE });
  const id: string = created.body.id;
  const inputs = Object.fromEntries(adder.gates.filter((gate) => gate.type === "INPUT").map((gate) => [gate.id, 1]));

  // A client downloading a million-row table as fast as it can keeps the only worker busy.
  const download = new AbortController();
  const response = await fetch(`${base}/v1/circuits/${id}/truth-table?limit=1048576`, { headers: { Accept: "text/csv", Authorization: `Bearer ${token}` }, signal: download.signal });
  const reader = response.body!.getReader();
  let received = 0;
  const reading = (async () => {
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) received += chunk.value.length;
    } catch {
      // aborted below
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 300));
  let health = await call("GET", "/health");
  show("GET /health  (during the download)", health, JSON.stringify(health.body.simulationPool));

  const busy = await call("POST", `/v1/circuits/${id}/simulate`, { body: JSON.stringify({ inputs }), headers: JSON_TYPE });
  show("POST .../simulate  (meanwhile)", busy, `${busy.body.code}, ${header(busy, "Retry-After")}`);

  download.abort(); // the client gives up
  await reading;
  await new Promise((resolve) => setTimeout(resolve, 200));
  health = await call("GET", "/health");
  show(`(client abandons the download after ${(received / 1e6).toFixed(1)} MB) GET /health`, health, `${JSON.stringify(health.body.simulationPool)}: its work was cancelled`);
  const again = await call("POST", `/v1/circuits/${id}/simulate`, { body: JSON.stringify({ inputs }), headers: JSON_TYPE });
  show("POST .../simulate  (again)", again, `outputs cout=${again.body.outputs.cout} s19=${again.body.outputs.s19} ... s0=${again.body.outputs.s0}`);
}

async function main(): Promise<void> {
  const config = new AppConfig({ port: 0, simulationWorkers: 1, simulationQueue: 0, shutdownGraceMs: 2_000, jwtSecret: randomBytes(32).toString("hex") });
  const app = await createApp({ config, logLevels: ["warn", "error"] });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  console.log(`\nCircuitLab API running at ${base} (1 simulation worker, no waiting queue)`);

  try {
    const account = await call("POST", "/v1/auth/register", {
      body: JSON.stringify({ email: "demo@example.com", password: "a demo passphrase for phase 4", displayName: "Demo" }),
      headers: JSON_TYPE,
    });
    token = account.body.accessToken;
    console.log(`Signed in as ${account.body.user.displayName} <${account.body.user.email}>; every request below sends its access token.`);
    const ids = await creating();
    await listing();
    await simulating(ids);
    await truthTables(ids);
    await editing(ids);
    await overload();
  } finally {
    section("7. Shutting down, as on SIGTERM");
    app.useLogger(["log", "warn", "error"]);
    const start = performance.now();
    await app.close(); // stop taking requests, drain, then onApplicationShutdown closes the pool
    print(`app.close() finished in ${Math.round(performance.now() - start)} ms\n`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
