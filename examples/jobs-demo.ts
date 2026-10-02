/**
 * Phase 10 demo: the result cache, and truth tables too big for one response as background jobs.
 *
 *   npm run demo:jobs                                   (everything in this process's memory)
 *   REDIS_URL=redis://localhost:6379 npm run demo:jobs  (Redis and BullMQ; npm run redis:start)
 *
 * Starts the API on a free port and drives it over HTTP, like a client would.
 */
import type { AddressInfo } from "node:net";
import { AppConfig, createApp } from "@circuitlab/api";
import { print, rippleCarryAdder, section } from "./circuits";

let base = "";
let token = "";

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: any;
  readonly ms: number;
}

async function call(method: string, path: string, json?: unknown, accept = "application/json"): Promise<Answer> {
  const started = performance.now();
  const response = await fetch(base + path, {
    method,
    headers: { Accept: accept, Authorization: `Bearer ${token}`, ...(json !== undefined && { "Content-Type": "application/json" }) },
    ...(json !== undefined && { body: JSON.stringify(json) }),
  });
  const text = await response.text();
  const body = /json/.test(response.headers.get("content-type") ?? "") && text !== "" ? JSON.parse(text) : text;
  return { status: response.status, headers: response.headers, body, ms: performance.now() - started };
}

const fmt = (n: number): string => n.toLocaleString("en");

async function caching(): Promise<void> {
  section("1. The result cache: keyed by circuit version, so it is never out of date");
  const adder = await call("POST", "/v1/circuits", { name: "16-bit adder", ...rippleCarryAdder(16) });
  const path = `/v1/circuits/${adder.body.id}/simulate`;
  const inputs = Object.fromEntries(adder.body.summary.inputs.map((id: string, k: number) => [id, k % 3 === 0 ? 1 : 0]));
  for (const when of ["the first time", "the same again", "the same again"]) {
    const answer = await call("POST", path, { inputs });
    print(`POST .../simulate, ${when.padEnd(14)} -> ${answer.status}  Cache-Status: ${answer.headers.get("cache-status")}  (${answer.ms.toFixed(1)} ms)`);
  }
  await call("PATCH", `/v1/circuits/${adder.body.id}`, { name: "16-bit adder, renamed" });
  const after = await call("POST", path, { inputs });
  print(`After an edit (version ${after.body.circuitVersion}):          -> ${after.status}  Cache-Status: ${after.headers.get("cache-status")}`);
  print("A hit skips loading the gates and wires, the worker threads, and the simulation; never the access check.");
}

async function jobs(): Promise<void> {
  section("2. A truth table too big for one response: a background job");
  const created = await call("POST", "/v1/circuits", { name: "10-bit adder", ...rippleCarryAdder(10) });
  const id = created.body.id;
  const rows = 2 ** created.body.summary.inputs.length;
  print(`A 10-bit adder: ${created.body.summary.inputs.length} inputs, so ${fmt(rows)} rows.`);
  const direct = await call("GET", `/v1/circuits/${id}/truth-table`, undefined, "text/csv");
  print(`GET .../truth-table (CSV)        -> ${direct.status} ${direct.body.code}: ${direct.body.issues[0].message}`);

  const started = await call("POST", `/v1/circuits/${id}/truth-table/jobs`, {});
  print(`POST .../truth-table/jobs {}     -> ${started.status}  Location: ${started.headers.get("location")}  Retry-After: ${started.headers.get("retry-after")}`);
  const again = await call("POST", `/v1/circuits/${id}/truth-table/jobs`, {});
  print(`The same POST again              -> ${again.status}, the same job (${again.body.id === started.body.id ? "same id" : "a different id!"}): a retried request never doubles the work`);

  let job = started.body;
  let shown = -1;
  const clock = performance.now();
  while (job.status === "queued" || job.status === "running") {
    await new Promise((resolve) => setTimeout(resolve, 100));
    job = (await call("GET", started.headers.get("location") ?? "")).body;
    const percent = Math.floor((100 * job.rowsDone) / job.limit);
    if (percent >= shown + 25 || job.status === "succeeded") {
      shown = percent;
      print(`  polling: ${job.status.padEnd(9)} ${fmt(job.rowsDone).padStart(9)} of ${fmt(job.limit)} rows (${percent}%)`);
    }
  }
  print(`Finished in ${((performance.now() - clock) / 1000).toFixed(1)} s: ${job.status}; the result can be downloaded until ${job.expiresAt}.`);

  // Streamed, and counted rather than kept: it is over 100 MB of text.
  const response = await fetch(base + job.links.result, { headers: { Authorization: `Bearer ${token}`, Accept: "text/csv" } });
  let bytes = 0;
  let lines = 0;
  let head = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.length;
    for (const byte of chunk) if (byte === 10) lines++;
    if (head.length < 200) head += decoder.decode(chunk, { stream: true });
  }
  print(`GET ${job.links.result.replace(/^\/v1\/circuits\/[^/]+/, ".../circuits/{id}")} (CSV)  -> ${response.status}, ${fmt(lines - 1)} rows, ${(bytes / 2 ** 20).toFixed(0)} MiB`);
  print(head.split("\r\n").slice(0, 3).map((line) => `  ${line.slice(0, 90)}...`).join("\n"));
  print(`Kept meanwhile as bits, one per output value: ${fmt(Math.ceil((rows * created.body.summary.outputs.length) / 8 / 1024))} KiB.`);

  section("3. Allowances, cancelling, and the history");
  const one = await call("POST", `/v1/circuits/${id}/truth-table/jobs`, { limit: 1_000_000 });
  const two = await call("POST", `/v1/circuits/${id}/truth-table/jobs`, { offset: 1_000_000 });
  const three = await call("POST", `/v1/circuits/${id}/truth-table/jobs`, { limit: 10 });
  print(`Two jobs started (${one.status}, ${two.status}); a third while both are unfinished -> ${three.status} ${three.body.code}, Retry-After: ${three.headers.get("retry-after")}`);
  print(`  "${three.body.detail}"`);
  for (const started of [one, two]) await call("DELETE", started.headers.get("location") ?? "");
  const cancelled = await call("GET", one.headers.get("location") ?? "");
  print(`DELETE both -> 204; the first is now ${cancelled.body.status}.`);
  const huge = await call("POST", "/v1/circuits", { name: "13-bit adder", ...rippleCarryAdder(13) });
  const tooBig = await call("POST", `/v1/circuits/${huge.body.id}/truth-table/jobs`, {});
  print(`A 13-bit adder's whole table (${fmt(2 ** huge.body.summary.inputs.length)} rows) is refused at once: ${tooBig.status} ${tooBig.body.code}:`);
  print(`  "${tooBig.body.detail}"`);
  const history = await call("GET", `/v1/circuits/${id}/runs`);
  print("GET .../runs: jobs are runs too (kind truth_table):");
  for (const run of history.body.items) print(`  ${run.kind.padEnd(11)} ${run.status.padEnd(9)} rows ${fmt(run.offset)} + ${fmt(run.limit)}`);
}

async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  const app = await createApp({
    config: new AppConfig({ port: 0, jwtSecret: "a demo secret, at least thirty-two characters", ...(redisUrl !== undefined && { redisUrl }) }),
    logLevels: ["error"],
  });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  print(
    redisUrl === undefined
      ? "No REDIS_URL: the cache and the job queue live in this process's memory (set REDIS_URL to use Redis and BullMQ)."
      : `REDIS_URL is set: the cache is in Redis, and jobs go through BullMQ.`,
  );
  try {
    const account = await call("POST", "/v1/auth/register", { email: "jobs@example.com", password: "a passphrase for the demo", displayName: "Demo" });
    token = account.body.accessToken;
    await caching();
    await jobs();
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
