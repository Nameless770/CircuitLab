// Part of the phase 12 measurements: see docs/system-design.md (Running it yourself).
// Closed-loop HTTP load generator for CircuitLab (phase 12 measurements).
// Runs inside a container on the compose network, so Docker Desktop's port forwarding is not in the way.
// N "virtual users" each send a request, wait for the whole answer, and send the next one, for a fixed time.
import http from "node:http";
import dns from "node:dns/promises";
import { performance } from "node:perf_hooks";

const HOST = process.env.TARGET_HOST ?? "api";
const PORT = Number(process.env.TARGET_PORT ?? 3000);
const SCENARIOS = (process.env.SCENARIOS ?? "").split(",").filter(Boolean);
const CONCURRENCY = (process.env.CONCURRENCY ?? "1,32").split(",").map(Number);
const SECONDS = Number(process.env.SECONDS ?? 10);
const WARMUP = Number(process.env.WARMUP ?? 2);
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");

// Every instance behind the name: with two API copies, connections are spread over both, like a load balancer would.
const ips = await dns.resolve4(HOST);

function send(ip, agent, method, path, { token, json, text } = {}, keepBody = false) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let body;
    if (json !== undefined) { body = JSON.stringify(json); headers["content-type"] = "application/json"; }
    else if (text !== undefined) { body = text; headers["content-type"] = "text/vnd.circuitlab.netlist"; }
    if (body !== undefined) headers["content-length"] = Buffer.byteLength(body);
    if (token) headers.authorization = `Bearer ${token}`;
    const request = http.request({ host: ip, port: PORT, method, path, headers, agent }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => { if (keepBody) chunks.push(chunk); });
      response.on("end", () => {
        let parsed;
        if (keepBody) {
          const text = Buffer.concat(chunks).toString("utf8");
          try { parsed = JSON.parse(text); } catch { parsed = text; }
        }
        resolve({ status: response.statusCode, headers: response.headers, body: parsed });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

const setupAgent = new http.Agent({ keepAlive: true });
const call = (method, path, options) => send(ips[0], setupAgent, method, path, options, true);

// --- setup: one account, one small circuit (cache hits), one wide circuit (cache misses), and some more for lists ---
const ADDER = (name) => `.name "${name}"
A   = INPUT
B   = INPUT
Cin = INPUT "Carry in"
parity   = XOR(A, B, Cin)
ab       = AND(A, B)
ac       = AND(A, Cin)
bc       = AND(B, Cin)
majority = OR(ab, ac, bc)
S    = OUTPUT(parity)    "Sum"
Cout = OUTPUT(majority)  "Carry out"
`;
const WIDTH = 64;
const PARITY = `.name "Parity ${WIDTH}"
${Array.from({ length: WIDTH }, (_, i) => `i${i} = INPUT`).join("\n")}
${Array.from({ length: WIDTH - 1 }, (_, i) => `x${i + 1} = XOR(${i === 0 ? "i0" : `x${i}`}, i${i + 1})`).join("\n")}
Y = OUTPUT(x${WIDTH - 1})
`;
const randomInputs = () => Object.fromEntries(Array.from({ length: WIDTH }, (_, i) => [`i${i}`, Math.random() < 0.5 ? 0 : 1]));
const BIG_INPUTS = 24, BIG_GATES = 5000;
const BIG = `.name "Chain ${BIG_GATES}"
${Array.from({ length: BIG_INPUTS }, (_, i) => `in${i} = INPUT`).join("\n")}
${Array.from({ length: BIG_GATES }, (_, i) => `g${i + 1} = NAND(${i === 0 ? "in0" : `g${i}`}, in${(i + 1) % BIG_INPUTS})`).join("\n")}
Y = OUTPUT(g${BIG_GATES})
`;
const randomBigInputs = () => Object.fromEntries(Array.from({ length: BIG_INPUTS }, (_, i) => [`in${i}`, Math.random() < 0.5 ? 0 : 1]));

const stamp = Date.now();
const email = `load.${stamp}@example.test`;
const password = `load test passphrase ${stamp}`;
const registered = await call("POST", "/v1/auth/register", { json: { email, password, displayName: "Load test" } });
if (registered.status !== 201) throw new Error(`register: ${registered.status} ${JSON.stringify(registered.body)}`);
const token = registered.body.accessToken;
const created = async (text) => {
  const r = await call("POST", "/v1/circuits", { token, text });
  if (r.status !== 201) throw new Error(`create: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
};
const adderId = await created(ADDER("Full adder"));
const parityId = await created(PARITY);
const bigId = SCENARIOS.some((s) => s.endsWith("-big")) ? await created(BIG) : undefined;
for (let i = 0; i < 25; i++) await created(ADDER(`Adder ${i}`));
out({ event: "setup", instances: ips.length, adderId, parityId });

const scenarios = {
  floor: () => ({ method: "GET", path: "/v1/users/me", expect: 401 }),
  health: () => ({ method: "GET", path: "/health", expect: 200 }),
  me: () => ({ method: "GET", path: "/v1/users/me", token, expect: 200 }),
  list: () => ({ method: "GET", path: "/v1/circuits?limit=20", token, expect: 200 }),
  get: () => ({ method: "GET", path: `/v1/circuits/${adderId}`, token, expect: 200 }),
  "simulate-hit": () => ({ method: "POST", path: `/v1/circuits/${adderId}/simulate`, token, json: { inputs: { A: 1, B: 0, Cin: 1 } }, expect: 200 }),
  "simulate-miss": () => ({ method: "POST", path: `/v1/circuits/${parityId}/simulate`, token, json: { inputs: randomInputs() }, expect: 200 }),
  create: () => ({ method: "POST", path: "/v1/circuits", token, text: ADDER("Created under load"), expect: 201 }),
  "get-big": () => ({ method: "GET", path: `/v1/circuits/${bigId}`, token, expect: 200 }),
  "simulate-miss-big": () => ({ method: "POST", path: `/v1/circuits/${bigId}/simulate`, token, json: { inputs: randomBigInputs() }, expect: 200 }),
  login: () => ({ method: "POST", path: "/v1/auth/login", json: { email, password }, expect: 200 }),
};

const percentile = (sorted, p) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
const round = (value, digits = 2) => (value === null ? null : Number(value.toFixed(digits)));

async function run(name, concurrency) {
  const make = scenarios[name];
  const users = Array.from({ length: concurrency }, (_, i) => ({ ip: ips[i % ips.length], agent: new http.Agent({ keepAlive: true, maxSockets: 1 }) }));
  const latencies = [];
  const statuses = {};
  let unexpected = 0;
  let errors = 0;
  const seconds = concurrency === 1 ? Math.max(4, SECONDS / 2) : SECONDS;
  const warmup = concurrency === 1 ? 1 : WARMUP;
  const startedAt = performance.now();
  const measureFrom = startedAt + warmup * 1000;
  const endAt = measureFrom + seconds * 1000;
  let announced = false;
  await Promise.all(users.map(async (user) => {
    while (performance.now() < endAt) {
      const spec = make();
      const t0 = performance.now();
      if (!announced && t0 >= measureFrom) { announced = true; out({ event: "measuring", scenario: name, concurrency }); }
      try {
        const { status } = await send(user.ip, user.agent, spec.method, spec.path, spec, false);
        const t1 = performance.now();
        if (t0 >= measureFrom && t1 <= endAt) {
          latencies.push(t1 - t0);
          statuses[status] = (statuses[status] ?? 0) + 1;
          if (status !== spec.expect) unexpected++;
        }
      } catch {
        if (t0 >= measureFrom) errors++;
      }
    }
  }));
  for (const user of users) user.agent.destroy();
  latencies.sort((a, b) => a - b);
  const mean = latencies.reduce((sum, v) => sum + v, 0) / (latencies.length || 1);
  out({
    event: "result", scenario: name, concurrency, instances: ips.length, seconds,
    requests: latencies.length, rps: round(latencies.length / seconds, 0),
    meanMs: round(mean), p50Ms: round(percentile(latencies, 50)), p95Ms: round(percentile(latencies, 95)), p99Ms: round(percentile(latencies, 99)), maxMs: round(latencies.at(-1) ?? null),
    statuses, unexpected, errors,
  });
}

for (const name of SCENARIOS) {
  if (!(name in scenarios)) throw new Error(`unknown scenario ${name}`);
  for (const concurrency of CONCURRENCY) await run(name, concurrency);
}
out({ event: "done" });
setupAgent.destroy();
