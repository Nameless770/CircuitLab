// Stage 2 of docs/system-design.md, checked with real containers.
//
// It starts the production setup (docker-compose.yml with docker-compose.prod.yml: Caddy in front,
// copies of the API, copies of the sign-in pool, PostgreSQL, two Redis servers, a worker) under a
// project name of its own and on free ports, so nothing of yours is touched. It then asks the setup
// what it promises: that requests are shared out and sign-ins go to their own pool; that the copies
// behave as one (a token, the cache, the sign-in lock and the address limit are shared); that a copy
// that dies costs nobody a request; and that when no copy can answer, the answer is a 503 that says
// when to try again. Finally it removes everything it started.
//
// Needs Docker. The first run builds the image, which takes a few minutes.
//
//   node scripts/check-copies.mjs                       check, then remove the stack
//   node scripts/check-copies.mjs --keep                leave the stack running (the last line says how to remove it)
//   node scripts/check-copies.mjs --no-build            use the `circuitlab` image as it is (CI has just built it)
//   node scripts/check-copies.mjs --remove=<project>    remove a stack that --keep left running, and its data
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const { values: flags } = parseArgs({ options: { keep: { type: "boolean", default: false }, "no-build": { type: "boolean", default: false }, remove: { type: "string" } } });
const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROJECT_NAME = /^circuitlab-copies-[0-9a-f]{6}$/; // what this script names its stacks, and the only names --remove accepts
const PROJECT = flags.remove ?? `circuitlab-copies-${randomBytes(3).toString("hex")}`;
const COPIES = 2; // of the API, and of the sign-in pool: two of each, so that the checks can see both
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const HTTP_PORT = await freePort();
// Every variable the two Compose files read, so that a .env file next to them can't change the test.
const STACK_ENV = {
  SITE_ADDRESS: ":80", // plain HTTP, whatever name the request uses
  HTTP_PORT: String(HTTP_PORT),
  HTTPS_PORT: String(await freePort()),
  JWT_SECRET: randomBytes(36).toString("base64url"),
  POSTGRES_PASSWORD: randomBytes(12).toString("hex"),
  API_PORT: "0",
  API_COPIES: String(COPIES),
  API_AUTH_COPIES: String(COPIES),
  AUTH_RATE_LIMIT: "30",
};
const BASE = `http://127.0.0.1:${HTTP_PORT}`;

/** Runs docker, never through a shell. */
function docker(args) {
  return run("docker", args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
}

/** Runs docker compose for this stack's project, and no other: every command in this file goes through here. */
function compose(...args) {
  return run("docker", ["compose", "-p", PROJECT, "-f", "docker-compose.yml", "-f", "docker-compose.prod.yml", ...args], {
    cwd: ROOT,
    env: { ...process.env, ...STACK_ENV },
    maxBuffer: 256 * 1024 * 1024,
  });
}

if (flags.remove !== undefined) {
  // Never a stack that isn't this script's own: a typo here must not be able to delete your data.
  if (!PROJECT_NAME.test(PROJECT)) {
    console.log(`"${PROJECT}" is not the name of a stack this script made (circuitlab-copies- and six hexadecimal digits), so it is left alone.`);
    process.exit(1);
  }
  await compose("down", "--volumes", "--remove-orphans", "--timeout", "5");
  console.log(`Removed ${PROJECT}, with its data.`);
  process.exit(0);
}

// ---- Asking the stack things ------------------------------------------------------------------

let sent = 0; // requests made through Caddy, which Caddy must have logged

/** `raw` is for a flood: a 200's body is read and thrown away, so the client's own CPU doesn't become the limit. */
async function call(method, path, { token, json, raw = false, headers = {} } = {}) {
  sent++;
  const started = performance.now();
  try {
    const response = await fetch(BASE + path, {
      method,
      headers: { ...(json !== undefined && { "Content-Type": "application/json" }), ...(token !== undefined && { Authorization: `Bearer ${token}` }), ...headers },
      ...(json !== undefined && { body: JSON.stringify(json) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (raw && response.status === 200) {
      await response.arrayBuffer();
      return { status: 200, headers: response.headers, body: undefined, ms: performance.now() - started };
    }
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, headers: response.headers, body, ms: performance.now() - started };
  } catch (error) {
    return { status: 0, headers: new Headers(), body: undefined, error: String(error), ms: performance.now() - started };
  }
}

/** Caddy's access log: one JSON object per request, with the address of the copy that answered. */
async function accessLog(expected) {
  for (let attempt = 0; ; attempt++) {
    const { stdout } = await compose("logs", "--no-log-prefix", "--no-color", "caddy");
    const entries = [];
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry.logger === "string" && entry.logger.startsWith("http.log.access")) entries.push(entry);
      } catch {
        // a line cut short; the next read will have it whole
      }
    }
    if (entries.length >= expected || attempt >= 20) return entries;
    await sleep(250);
  }
}

/** The log entries since the last time this was called, once Caddy has written one for every request made. */
let logged = 0;
async function newEntries() {
  const entries = await accessLog(sent);
  const fresh = entries.slice(logged);
  logged = entries.length;
  return fresh;
}

const hostOf = (entry) => String(entry.upstream ?? "").replace(/:\d+$/, "");

/** The running containers of one service, with the address each has on the stack's network. */
async function containersOf(service) {
  const { stdout } = await compose("ps", "--format", "json", "--filter", "status=running", service);
  const text = stdout.trim();
  const rows = text.startsWith("[") ? JSON.parse(text) : text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const found = [];
  for (const row of rows) {
    const { stdout: ip } = await docker(["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", row.ID]);
    found.push({ name: row.Name, id: row.ID, ip: ip.trim(), health: row.Health });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

async function waitFor(what, test, seconds = 90) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${seconds} seconds`);
    await sleep(500);
  }
}

// ---- The checks ---------------------------------------------------------------------------------

const results = [];
async function check(name, body) {
  try {
    const detail = await body();
    results.push({ name, ok: true });
    console.log(`  ok    ${name}${detail ? `\n          ${detail}` : ""}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name}\n          ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

const describeCounts = (counts) => [...counts].map(([key, n]) => `${key} x${n}`).join(", ");
const person = (name) => ({ email: `${name}.${randomBytes(4).toString("hex")}@example.com`, password: `${name}'s passphrase for this check`, displayName: name });
const HALF_ADDER = {
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

let failedToStart = false;
try {
  console.log(`Starting the production setup as the Compose project "${PROJECT}" (Caddy on port ${HTTP_PORT}), with ${COPIES} copies of the API and ${COPIES} of the sign-in pool...`);
  const started = Date.now();
  try {
    await compose("up", "--detach", ...(flags["no-build"] ? [] : ["--build"]), "--wait", "--wait-timeout", "300");
  } catch (error) {
    failedToStart = true;
    throw error;
  }
  console.log(`Up after ${Math.round((Date.now() - started) / 1000)} seconds.\n`);

  let api = [];
  let auth = [];
  let token;

  await check("Caddy answers, and so does the API behind it, with the database and Redis reachable", async () => {
    const health = await call("GET", "/health");
    assert(health.status === 200 && health.body?.status === "ok", `GET /health answered ${health.status} ${JSON.stringify(health.body)}`);
    const live = await call("GET", "/health/live");
    assert(live.status === 200 && live.body?.status === "ok", `GET /health/live answered ${live.status} ${JSON.stringify(live.body)}`);
    return `${JSON.stringify(health.body.storage)}, ${JSON.stringify(health.body.redis)}`;
  });

  await check(`${COPIES} copies of the API and ${COPIES} of the sign-in pool are running, healthy and apart`, async () => {
    api = await containersOf("api");
    auth = await containersOf("api-auth");
    assert(api.length === COPIES, `${api.length} API copies are running, not ${COPIES}`);
    assert(auth.length === COPIES, `${auth.length} sign-in copies are running, not ${COPIES}`);
    for (const copy of [...api, ...auth]) assert(copy.health === "healthy", `${copy.name} is "${copy.health}", not healthy`);
    assert(new Set([...api, ...auth].map((copy) => copy.ip)).size === 2 * COPIES, "two copies share an address");
    return [...api, ...auth].map((copy) => `${copy.name.replace(`${PROJECT}-`, "")} ${copy.ip}`).join(", ");
  });

  const me = person("Ada");
  await check("registering and signing in work, and are answered by the sign-in pool only", async () => {
    await newEntries(); // forget what came before
    const registered = await call("POST", "/v1/auth/register", { json: me });
    assert(registered.status === 201, `register answered ${registered.status} ${JSON.stringify(registered.body)}`);
    const signedIn = await call("POST", "/v1/auth/login", { json: { email: me.email, password: me.password } });
    assert(signedIn.status === 200, `login answered ${signedIn.status} ${JSON.stringify(signedIn.body)}`);
    token = signedIn.body.accessToken;
    const served = (await newEntries()).filter((entry) => entry.request.uri.startsWith("/v1/auth/"));
    assert(served.length === 2, `Caddy logged ${served.length} sign-in requests, not 2`);
    const authIps = new Set(auth.map((copy) => copy.ip));
    for (const entry of served) assert(authIps.has(hostOf(entry)), `${entry.request.uri} was answered by ${entry.upstream}, which is not in the sign-in pool`);
    return `answered by ${served.map((entry) => entry.upstream).join(" and ")}`;
  });

  let circuit;
  await check("everything else goes to the API copies, shared between both, and a token from the sign-in pool works on each", async () => {
    circuit = (await call("POST", "/v1/circuits", { token, json: HALF_ADDER })).body?.id;
    assert(circuit !== undefined, "could not create a circuit");
    await newEntries();
    const statuses = [];
    for (let round = 0; round < 6; round++) {
      const answers = await Promise.all(Array.from({ length: 10 }, () => call("GET", "/v1/circuits", { token })));
      statuses.push(...answers.map((answer) => answer.status));
    }
    assert(statuses.every((status) => status === 200), `statuses: ${describeCounts(countBy(statuses))}`);
    const served = (await newEntries()).filter((entry) => entry.request.uri.startsWith("/v1/circuits"));
    const perCopy = countBy(served.map(hostOf));
    const apiIps = new Set(api.map((copy) => copy.ip));
    for (const ip of perCopy.keys()) assert(apiIps.has(ip), `a request was answered by ${ip}, which is not an API copy`);
    assert(perCopy.size === COPIES, `only ${perCopy.size} of ${COPIES} API copies answered: ${describeCounts(perCopy)}`);
    for (const [ip, n] of perCopy) assert(n >= 6, `${ip} answered only ${n} of ${served.length} requests: ${describeCounts(perCopy)}`);
    return `60 requests, 10 at a time, all 200: ${describeCounts(perCopy)}`;
  });

  await check("the cache is shared: a result stored through one copy is a hit through the other", async () => {
    await newEntries();
    const verdicts = [];
    for (let i = 0; i < 20; i++) {
      const answer = await call("POST", `/v1/circuits/${circuit}/simulate`, { token, json: { inputs: { A: 1, B: 0 } } });
      assert(answer.status === 200, `simulate answered ${answer.status}`);
      verdicts.push(answer.headers.get("cache-status"));
    }
    const served = countBy((await newEntries()).map(hostOf));
    assert(served.size === COPIES, `only ${served.size} copies answered the 20 requests, so this proves nothing: ${describeCounts(served)}`);
    const verdictCounts = countBy(verdicts);
    const misses = [...verdictCounts].filter(([verdict]) => verdict?.includes("miss")).reduce((sum, [, n]) => sum + n, 0);
    const hits = verdictCounts.get("CircuitLab; hit") ?? 0;
    assert(misses === 1 && hits === 19, `expected 1 miss and 19 hits, got ${describeCounts(verdictCounts)}`);
    return `1 miss and 19 hits, over ${describeCounts(served)}`;
  });

  await check("the sign-in lock is shared: 5 wrong guesses spread over both sign-in copies lock the account for all", async () => {
    const victim = person("Grace");
    assert((await call("POST", "/v1/auth/register", { json: victim })).status === 201, "could not register");
    await newEntries();
    const guess = () => call("POST", "/v1/auth/login", { json: { email: victim.email, password: "a wrong guess, again" } });
    const answers = [...(await Promise.all([guess(), guess()])), ...(await Promise.all([guess(), guess()])), await guess()];
    assert(answers.every((answer) => answer.status === 401), `the wrong guesses answered ${describeCounts(countBy(answers.map((answer) => answer.status)))}`);
    const served = countBy((await newEntries()).map(hostOf));
    assert(served.size === COPIES, `all 5 guesses went to one copy, so this proves nothing: ${describeCounts(served)}`);
    const locked = await call("POST", "/v1/auth/login", { json: { email: victim.email, password: victim.password } });
    assert(locked.status === 429 && locked.body?.code === "too-many-requests", `the right password answered ${locked.status} ${JSON.stringify(locked.body)}`);
    return `the right password now answers 429, Retry-After ${locked.headers.get("retry-after")}; the guesses went to ${describeCounts(served)}`;
  });

  await check("a copy that is killed costs nobody a request", async () => {
    const [victim] = api;
    await docker(["kill", victim.name]);
    const outcomes = [];
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      outcomes.push(await call("GET", "/v1/circuits", { token }));
      await sleep(50);
    }
    const failures = outcomes.filter((outcome) => outcome.status !== 200);
    const slowest = Math.max(...outcomes.map((outcome) => outcome.ms));
    assert(failures.length === 0, `${failures.length} of ${outcomes.length} requests failed: ${describeCounts(countBy(failures.map((outcome) => outcome.status || outcome.error)))}`);
    assert(slowest < 4000, `the slowest request took ${Math.round(slowest)} ms`);
    const slow = outcomes.filter((outcome) => outcome.ms > 500).length;
    // Docker brings it back (restart: unless-stopped), unless it counts `kill` as a deliberate stop.
    let revived = await waitFor("the copy running again", async () => (await containersOf("api")).length === COPIES, 30).catch(() => false);
    let how = "Docker restarted it by itself";
    if (!revived) {
      await compose("up", "--detach", "--wait", "--wait-timeout", "120", "api");
      how = "Docker left it stopped, so it was started again";
    }
    await waitFor("both API copies healthy", async () => (await containersOf("api")).filter((copy) => copy.health === "healthy").length === COPIES, 90);
    api = await containersOf("api");
    return `${outcomes.length} requests in 10 seconds while ${victim.name.replace(`${PROJECT}-`, "")} was dead: none failed, ${slow} took over half a second, the slowest ${Math.round(slowest)} ms; ${how}`;
  });

  await check("the restarted copy takes its share of requests again", async () => {
    await newEntries();
    await sleep(3000); // Caddy looks the copies up again every 2 seconds, and a copy that failed is left alone for 10
    const until = Date.now() + 25_000;
    let perCopy = new Map();
    while (Date.now() < until && perCopy.size < COPIES) {
      await Promise.all(Array.from({ length: 10 }, () => call("GET", "/v1/circuits", { token })));
      perCopy = countBy((await newEntries()).map(hostOf));
      if (perCopy.size < COPIES) await sleep(1000);
    }
    assert(perCopy.size === COPIES, `still only ${perCopy.size} copy answering: ${describeCounts(perCopy)}`);
    return describeCounts(perCopy);
  });

  await check("with no API copy left, Caddy answers 503 with a problem document and Retry-After, not a hang, and signing in still works", async () => {
    await compose("stop", "api");
    try {
      const started = performance.now();
      const answer = await call("GET", "/v1/circuits", { token });
      const took = performance.now() - started;
      assert(answer.status === 503, `answered ${answer.status} ${JSON.stringify(answer.body)}`);
      assert(answer.body?.code === "server-unavailable" && answer.body?.status === 503, `the body was ${JSON.stringify(answer.body)}`);
      assert(answer.headers.get("retry-after") === "5", `Retry-After was ${answer.headers.get("retry-after")}`);
      assert(/^application\/problem\+json/.test(answer.headers.get("content-type") ?? ""), `Content-Type was ${answer.headers.get("content-type")}`);
      // Not as quick as the flood below: with no container of that name left, Docker's DNS forwards the
      // question to the machine's resolver before saying "no such host", which took 4 seconds on a laptop.
      assert(took < 20_000, `it took ${Math.round(took)} ms`);
      const signIn = await call("POST", "/v1/auth/login", { json: { email: me.email, password: me.password } });
      assert(signIn.status === 200, `the sign-in pool, which is a pool of its own, answered ${signIn.status}`);
      return `${Math.round(took)} ms (Docker's DNS is slow to say that a name is gone); meanwhile signing in still works`;
    } finally {
      await compose("start", "api");
      await waitFor("both API copies healthy again", async () => (await containersOf("api")).filter((copy) => copy.health === "healthy").length === COPIES, 90);
    }
  });

  await check("the address limit holds across both sign-in copies, and only sign-ins are limited", async () => {
    let first429;
    let attempts = 0;
    while (first429 === undefined && attempts < 70) {
      attempts++;
      const answer = await call("POST", "/v1/auth/login", { json: { email: `nobody${attempts}.${randomBytes(3).toString("hex")}@example.com`, password: "a long wrong passphrase" } });
      if (answer.status === 429) first429 = answer;
      else assert(answer.status === 401, `a sign-in answered ${answer.status} ${JSON.stringify(answer.body)}`);
    }
    assert(first429 !== undefined, `70 sign-ins in a row and no 429 (AUTH_RATE_LIMIT is ${STACK_ENV.AUTH_RATE_LIMIT} a minute)`);
    assert(first429.headers.get("retry-after") !== null, "the 429 has no Retry-After");
    const ordinary = await call("GET", "/v1/circuits", { token });
    assert(ordinary.status === 200, `an ordinary request answered ${ordinary.status} while the address was limited`);
    return `429 on sign-in number ${attempts} of this address (Retry-After ${first429.headers.get("retry-after")}), while GET /v1/circuits still answers 200`;
  });

  // Last, because it makes Caddy log thousands of requests, which the checks above count one by one.
  await check("a flood is turned away quickly: 503 problem documents with Retry-After, after about 2 seconds, while the copies keep serving", async () => {
    // Reading a circuit of 5,000 gates costs the API about 37 ms of CPU (docs/system-design.md): far more
    // than two copies can read at once for hundreds of users, however fast the machine is.
    const SIZE = 5000;
    const gates = [{ id: "x", type: "INPUT" }, ...Array.from({ length: SIZE }, (_, i) => ({ id: `n${i}`, type: "NOT" })), { id: "y", type: "OUTPUT" }];
    const wires = [{ from: "x", to: "n0", toPin: 0 }, ...Array.from({ length: SIZE - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, toPin: 0 })), { from: `n${SIZE - 1}`, to: "y", toPin: 0 }];
    const big = await call("POST", "/v1/circuits", { token, json: { name: "5,000 inverters", gates, wires } });
    assert(big.status === 201, `could not create the big circuit: ${big.status} ${JSON.stringify(big.body)?.slice(0, 200)}`);

    const SECONDS = 8;
    const flood = async (users) => {
      const answers = [];
      const until = Date.now() + SECONDS * 1000;
      await Promise.all(
        Array.from({ length: users }, async () => {
          // No compression: it would cost Caddy and this script more CPU than the API's own work.
          while (Date.now() < until) answers.push(await call("GET", `/v1/circuits/${big.body.id}`, { token, raw: true, headers: { "Accept-Encoding": "identity" } }));
        }),
      );
      return answers;
    };
    let users = 500;
    let answers = await flood(users);
    if (!answers.some((answer) => answer.status === 503)) {
      users = 1500; // a machine faster than expected: ask for more
      await sleep(3000);
      answers = await flood(users);
    }
    const served = answers.filter((answer) => answer.status === 200);
    const turnedAway = answers.filter((answer) => answer.status === 503);
    const others = answers.filter((answer) => answer.status !== 200 && answer.status !== 503);
    assert(others.length === 0, `${others.length} requests got neither 200 nor 503: ${describeCounts(countBy(others.map((answer) => answer.status || answer.error)))}`);
    assert(served.length > 0, "no request was served");
    assert(turnedAway.length > 0, `${users} users for ${SECONDS} seconds and not one 503: the cap never came into play (${served.length} served)`);
    for (const answer of turnedAway) {
      assert(answer.body?.code === "server-unavailable", `a 503 had the body ${JSON.stringify(answer.body)}`);
      assert(answer.headers.get("retry-after") === "5", `a 503 had Retry-After ${answer.headers.get("retry-after")}`);
    }
    const refusalMs = turnedAway.map((answer) => answer.ms).sort((a, b) => a - b);
    const medianRefusal = refusalMs[Math.floor(refusalMs.length / 2)];
    // About 2 seconds: Caddy looks for a free copy that long. A busy machine may add a little to any one answer.
    assert(medianRefusal > 1500 && medianRefusal < 4000, `the median 503 took ${Math.round(medianRefusal)} ms; turning away is meant to take about 2 seconds`);
    assert(refusalMs.at(-1) < 10_000, `the slowest 503 took ${Math.round(refusalMs.at(-1))} ms`);

    await sleep(3000);
    const after = await call("GET", `/v1/circuits/${big.body.id}`, { token });
    assert(after.status === 200 && after.ms < 2000, `three seconds after the flood, a request answered ${after.status} in ${Math.round(after.ms)} ms`);
    const servedMs = served.map((answer) => answer.ms).sort((a, b) => a - b);
    return `${users} users for ${SECONDS} s: ${served.length} served (median ${Math.round(servedMs[Math.floor(servedMs.length / 2)])} ms), ${turnedAway.length} turned away (median ${Math.round(medianRefusal)} ms, slowest ${Math.round(refusalMs.at(-1))} ms); one request ${Math.round(after.ms)} ms after`;
  });
} catch (error) {
  console.log(`\nThe check could not finish: ${error.message}`);
  results.push({ name: "the check ran to the end", ok: false });
  if (failedToStart) {
    const { stdout } = await compose("ps", "--all").catch(() => ({ stdout: "" }));
    console.log(stdout);
  }
} finally {
  if (results.some((result) => !result.ok)) {
    console.log("\nThe end of the containers' logs, for finding out why:");
    for (const service of ["caddy", "api", "api-auth"]) {
      const { stdout } = await compose("logs", "--no-color", "--tail", "25", service).catch(() => ({ stdout: "" }));
      console.log(stdout.split("\n").map((line) => (line.length > 400 ? `${line.slice(0, 400)}...` : line)).join("\n"));
    }
  }
  if (flags.keep) {
    console.log(`\nLeft running: Caddy answers on ${BASE}. To remove it, with its data:\n  node scripts/check-copies.mjs --remove=${PROJECT}`);
  } else {
    await compose("down", "--volumes", "--remove-orphans", "--timeout", "5").catch((error) => console.log(`Could not remove the stack: ${error.message}`));
  }
}

const failed = results.filter((result) => !result.ok);
console.log(failed.length === 0 ? `\nAll ${results.length} checks passed.` : `\n${failed.length} of ${results.length} checks failed.`);
process.exit(failed.length === 0 ? 0 : 1);
