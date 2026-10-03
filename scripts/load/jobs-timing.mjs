// Part of the phase 12 measurements: see docs/system-design.md (Running it yourself).
// How long does a queue of truth-table jobs take to drain? Four jobs (two users, two jobs each, the
// per-user limit) are started at the same moment, and each one's finishing time is recorded.
// Run it with 1, 2 and 4 worker containers to see what more workers buy.
import http from "node:http";
import dns from "node:dns/promises";
import { performance } from "node:perf_hooks";

const INPUTS = Number(process.env.INPUTS ?? 20);
const JOBS_PER_USER = Number(process.env.JOBS_PER_USER ?? 2);
const USERS = Number(process.env.USERS ?? 2);
const [ip] = await dns.resolve4(process.env.TARGET_HOST ?? "api");
const agent = new http.Agent({ keepAlive: true });

function call(method, path, { token, json, text } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let body;
    if (json !== undefined) { body = JSON.stringify(json); headers["content-type"] = "application/json"; }
    else if (text !== undefined) { body = text; headers["content-type"] = "text/vnd.circuitlab.netlist"; }
    if (body !== undefined) headers["content-length"] = Buffer.byteLength(body);
    if (token) headers.authorization = `Bearer ${token}`;
    const request = http.request({ host: ip, port: 3000, method, path, headers, agent }, (response) => {
      const chunks = [];
      response.on("data", (c) => chunks.push(c));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = text;
        try { parsed = JSON.parse(text); } catch { /* text */ }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

// An XOR chain over INPUTS inputs: 2^INPUTS rows, about 2 * INPUTS gates.
const netlist = `.name "Parity ${INPUTS}"
${Array.from({ length: INPUTS }, (_, i) => `i${i} = INPUT`).join("\n")}
${Array.from({ length: INPUTS - 1 }, (_, i) => `x${i + 1} = XOR(${i === 0 ? "i0" : `x${i}`}, i${i + 1})`).join("\n")}
Y = OUTPUT(x${INPUTS - 1})
`;

const stamp = Date.now();
const users = [];
for (let u = 0; u < USERS; u++) {
  const reg = await call("POST", "/v1/auth/register", { json: { email: `jobs.${stamp}.${u}@example.test`, password: `jobs passphrase ${stamp} ${u}`, displayName: `Jobs ${u}` } });
  if (reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.body)}`);
  const circuit = await call("POST", "/v1/circuits", { token: reg.body.accessToken, text: netlist });
  if (circuit.status !== 201) throw new Error(`create ${circuit.status} ${JSON.stringify(circuit.body)}`);
  users.push({ token: reg.body.accessToken, circuitId: circuit.body.id });
}

const started = performance.now();
const finished = [];
await Promise.all(users.flatMap((user, u) => Array.from({ length: JOBS_PER_USER }, async (_, j) => {
  // The same request twice from one user would be handed the same job, so each job asks for its own row range.
  const rows = 2 ** INPUTS;
  const limit = rows / JOBS_PER_USER;
  const job = await call("POST", `/v1/circuits/${user.circuitId}/truth-table/jobs`, { token: user.token, json: { offset: j * limit, limit } });
  if (job.status !== 202) throw new Error(`start ${job.status} ${JSON.stringify(job.body)}`);
  let state = job.body;
  while (["queued", "running"].includes(state.status)) {
    await new Promise((r) => setTimeout(r, 100));
    state = (await call("GET", job.body.links.self, { token: user.token })).body;
  }
  if (state.status !== "succeeded") throw new Error(`job ${state.status} ${state.errorCode ?? ""}`);
  finished.push({ user: u, job: j, seconds: Number(((performance.now() - started) / 1000).toFixed(2)) });
})));
finished.sort((a, b) => a.seconds - b.seconds);
const total = USERS * JOBS_PER_USER;
console.log(JSON.stringify({ inputs: INPUTS, rowsPerJob: 2 ** INPUTS / JOBS_PER_USER, jobs: total, finishedAfterSeconds: finished.map((f) => f.seconds), drainSeconds: finished.at(-1).seconds }));
agent.destroy();
