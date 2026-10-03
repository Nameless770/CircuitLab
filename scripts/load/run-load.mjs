// Part of the phase 12 measurements: see docs/system-design.md (Running it yourself).
// Runs loadgen.mjs in a throwaway container on the compose network, and while each scenario is being
// measured samples `docker stats` (CPU and memory per container) and Postgres's open connections.
// Usage: node run-load.mjs --scenarios=floor,health --concurrency=1,32 --seconds=10 --out=file.json
//        [--project=circuitlab-load] [--host=api] [--image=circuitlab]
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.join("=")]; }));
const project = args.project ?? "circuitlab-load";
const containerName = `loadgen-${process.pid}`;
const env = {
  TARGET_HOST: args.host ?? "api",
  SCENARIOS: args.scenarios ?? "",
  CONCURRENCY: args.concurrency ?? "1,32",
  SECONDS: args.seconds ?? "10",
  WARMUP: args.warmup ?? "2",
};
const CONNECTIONS_SQL = "select count(*) from pg_stat_activity where datname = 'circuitlab'";

async function sampleStats() {
  const [stats, connections] = await Promise.all([
    run("docker", ["stats", "--no-stream", "--format", "{{json .}}"]),
    run("docker", ["exec", `${project}-postgres-1`, "psql", "-U", "circuitlab", "-d", "circuitlab", "-At", "-c", CONNECTIONS_SQL]).then((r) => Number(r.stdout.trim()), () => null),
  ]);
  const lines = stats.stdout.trim().split(/\r?\n/);
  const containers = lines.map((line) => JSON.parse(line))
    .filter((c) => c.Name.startsWith(`${project}-`) || c.Name === containerName)
    .map((c) => ({ name: c.Name.replace(`${project}-`, "").replace(/-\d+$/, (m) => m), cpu: c.CPUPerc, mem: c.MemUsage.split(" / ")[0] }));
  return { containers, connections };
}

const child = spawn("docker", [
  "run", "--rm", "-i", "--name", containerName, "--network", args.network ?? `${project}_default`,
  ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
  "--entrypoint", "node", args.image ?? "circuitlab", "--input-type=module", "-",
], { stdio: ["pipe", "pipe", "inherit"] });
child.stdin.end(readFileSync(new URL("loadgen.mjs", import.meta.url)));

const results = [];
let pendingStats;
let chain = Promise.resolve();
async function handle(line) {
  let event;
  try { event = JSON.parse(line); } catch { console.log(line); return; }
  if (event.event === "measuring" && event.concurrency > 1) {
    pendingStats = new Promise((resolve) => setTimeout(() => sampleStats().then(resolve, () => resolve({ containers: [], connections: null })), 3500));
  } else if (event.event === "result") {
    const { containers, connections } = event.concurrency > 1 && pendingStats ? await pendingStats : { containers: [], connections: null };
    pendingStats = undefined;
    results.push({ ...event, containers, postgresConnections: connections });
    const busy = containers.filter((c) => parseFloat(c.cpu) >= 15).map((c) => `${c.name} ${c.cpu}`).join(", ");
    console.log(
      `${event.scenario.padEnd(14)} c=${String(event.concurrency).padStart(3)} x${event.instances}  ${String(event.rps).padStart(6)} req/s  mean ${String(event.meanMs).padStart(7)}  p50 ${String(event.p50Ms).padStart(7)}  p95 ${String(event.p95Ms).padStart(7)}  p99 ${String(event.p99Ms).padStart(7)} ms  ${JSON.stringify(event.statuses)}${event.unexpected ? ` UNEXPECTED=${event.unexpected}` : ""}${event.errors ? ` ERRORS=${event.errors}` : ""}${busy ? `  | ${busy}` : ""}${connections != null ? `  | pg conns ${connections}` : ""}`,
    );
  } else if (event.event === "setup") {
    console.log(`setup: ${event.instances} API instance(s) answering`);
  }
}
createInterface({ input: child.stdout }).on("line", (line) => { chain = chain.then(() => handle(line)); });
await new Promise((resolve) => child.on("close", resolve));
await chain;
if (args.out) writeFileSync(args.out, JSON.stringify(results, null, 2));
