// Part of the phase 12 measurements: see docs/system-design.md (Running it yourself).
// Does any API copy serve any request? Runs against two API instances behind the same name.
// Each check does one step through instance A and the next through instance B.
import http from "node:http";
import dns from "node:dns/promises";

const ips = await dns.resolve4(process.env.TARGET_HOST ?? "api");
if (ips.length < 2) throw new Error(`needs two API instances, found ${ips.length}`);
const [A, B] = ips;
console.log(`instance A = ${A}, instance B = ${B}`);

const agent = new http.Agent({ keepAlive: false });
function call(ip, method, path, { token, json, text, accept } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let body;
    if (json !== undefined) { body = JSON.stringify(json); headers["content-type"] = "application/json"; }
    else if (text !== undefined) { body = text; headers["content-type"] = "text/vnd.circuitlab.netlist"; }
    if (accept) headers.accept = accept;
    if (body !== undefined) headers["content-length"] = Buffer.byteLength(body);
    if (token) headers.authorization = `Bearer ${token}`;
    const request = http.request({ host: ip, port: 3000, method, path, headers, agent }, (response) => {
      const chunks = [];
      response.on("data", (c) => chunks.push(c));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = text;
        try { parsed = JSON.parse(text); } catch { /* plain text */ }
        resolve({ status: response.statusCode, headers: response.headers, body: parsed });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

const ADDER = `.name "Full adder"
A = INPUT
B = INPUT
Cin = INPUT
parity = XOR(A, B, Cin)
ab = AND(A, B)
ac = AND(A, Cin)
bc = AND(B, Cin)
majority = OR(ab, ac, bc)
S = OUTPUT(parity)
Cout = OUTPUT(majority)
`;

let failures = 0;
const check = (ok, what, observed) => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${what}  (${observed})`); };

const stamp = Date.now();
const email = `checks.${stamp}@example.test`;
const password = `checks passphrase ${stamp}`;

// 1. A token signed by A is accepted by B.
const registered = await call(A, "POST", "/v1/auth/register", { json: { email, password, displayName: "Checks" } });
const token = registered.body.accessToken;
const meOnB = await call(B, "GET", "/v1/users/me", { token });
check(meOnB.status === 200, "a token issued by A is accepted by B", `B answered ${meOnB.status}${meOnB.status === 401 ? " " + (meOnB.body.code ?? "") : ""}`);

if (meOnB.status !== 200) {
  console.log("-> stopping here: without a shared JWT_SECRET the other checks can't sign in on B");
  process.exit(failures === 0 ? 0 : 2);
}

// 2. A circuit written through A is read through B (the database is shared).
const created = await call(A, "POST", "/v1/circuits", { token, text: ADDER });
const id = created.body.id;
const readOnB = await call(B, "GET", `/v1/circuits/${id}`, { token });
check(created.status === 201 && readOnB.status === 200, "a circuit created through A is read through B", `create ${created.status}, read ${readOnB.status}`);

// 3. A result cached by A is a hit on B (the cache is shared).
const simulate = (ip) => call(ip, "POST", `/v1/circuits/${id}/simulate`, { token, json: { inputs: { A: 1, B: 1, Cin: 0 } } });
const first = await simulate(A);
const second = await simulate(B);
check(/stored/.test(first.headers["cache-status"] ?? "") && /hit/.test(second.headers["cache-status"] ?? ""), "a result cached by A is a cache hit on B", `A: ${first.headers["cache-status"]} | B: ${second.headers["cache-status"]}`);

// 4. The sign-in throttle counts failures of both instances together.
const guessEmail = `throttle.${stamp}@example.test`;
await call(A, "POST", "/v1/auth/register", { json: { email: guessEmail, password: `throttle passphrase ${stamp}`, displayName: "Throttle" } });
const answers = [];
for (const [i, ip] of [A, B, A, B, A].entries()) answers.push((await call(ip, "POST", "/v1/auth/login", { json: { email: guessEmail, password: `wrong guess number ${i} for the account` } })).status);
const sixthOnB = await call(B, "POST", "/v1/auth/login", { json: { email: guessEmail, password: `throttle passphrase ${stamp}` } });
const sixthOnA = await call(A, "POST", "/v1/auth/login", { json: { email: guessEmail, password: `throttle passphrase ${stamp}` } });
check(answers.every((s) => s === 401) && sixthOnB.status === 429 && sixthOnA.status === 429, "5 wrong guesses spread over A and B (3 and 2) block both, even with the right password", `guesses ${answers.join(",")}; then B ${sixthOnB.status}, A ${sixthOnA.status}`);

// 5. A refresh token issued by A rotates on B, and reusing the old one is refused everywhere.
const login = await call(A, "POST", "/v1/auth/login", { json: { email, password } });
const refreshedOnB = await call(B, "POST", "/v1/auth/refresh", { json: { refreshToken: login.body.refreshToken } });
const reusedOnA = await call(A, "POST", "/v1/auth/refresh", { json: { refreshToken: login.body.refreshToken } });
check(refreshedOnB.status === 200 && reusedOnA.status === 401, "a refresh token from A rotates on B; the old one is then refused on A", `B ${refreshedOnB.status}, reuse on A ${reusedOnA.status}`);

// 6. A job started through A is followed and downloaded through B.
const job = await call(A, "POST", `/v1/circuits/${id}/truth-table/jobs`, { token, json: {} });
let state = job.body;
for (let i = 0; i < 100 && ["queued", "running"].includes(state.status); i++) {
  await new Promise((r) => setTimeout(r, 200));
  state = (await call(B, "GET", job.body.links.self, { token })).body;
}
const csv = state.status === "succeeded" ? await call(B, "GET", state.links.result, { token, accept: "text/csv" }) : undefined;
check(job.status === 202 && state.status === "succeeded" && csv?.status === 200 && csv.body.trim().split("\n").length === 9, "a job started through A is polled and downloaded through B", `start ${job.status}, status ${state.status}, CSV ${csv?.status} ${typeof csv?.body === "string" ? csv.body.trim().split("\n").length : "?"} lines`);

console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 2);
