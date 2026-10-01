/**
 * Phase 7 demo: accounts, private and public circuits, sharing, and tokens, over HTTP.
 *
 *   npm run demo:auth        (from the repository root)
 *
 * Starts the API in memory on a free port, then three people (Ada, Bob, Carol) and a signed-out
 * visitor try everything they should and shouldn't be able to do. The demo knows the server's
 * JWT_SECRET, so it can also forge tokens by hand (expired, unsigned, wrongly signed) and show
 * each one refused.
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { AppConfig, createApp } from "@circuitlab/api";
import { print, section } from "./circuits";

const JSON_TYPE = { "Content-Type": "application/json" };
const SECRET = randomBytes(32).toString("hex");

let base = "";

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: any; // parsed JSON, when the answer is JSON
}

/** A person using the API: their name, and the access token they send (none when signed out). */
interface Person {
  readonly name: string;
  id: string;
  token: string;
  refreshToken: string;
}

const visitor: Person = { name: "signed out", id: "", token: "", refreshToken: "" };

async function call(person: Person, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const response = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined && JSON_TYPE), ...(person.token !== "" && { Authorization: `Bearer ${person.token}` }), ...headers },
    ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  const isJson = /json/.test(response.headers.get("content-type") ?? "");
  return { status: response.status, headers: response.headers, body: isJson && text !== "" ? JSON.parse(text) : undefined };
}

/** One line per exchange: who, the request, the status, and what matters in the answer. */
function show(person: Person, request: string, answer: Answer, detail = ""): void {
  const issue = answer.body?.issues?.[0];
  const where = issue === undefined ? "" : ` (${issue.pointer ?? issue.parameter}: ${issue.message})`;
  const problem = answer.status >= 400 && answer.body?.code !== undefined ? `${answer.body.code}: ${answer.body.detail}${where}` : "";
  print(`${`[${person.name}]`.padEnd(13)}${request}\n${" ".repeat(13)}-> ${answer.status} ${detail || problem}`.trimEnd());
}

async function register(name: string, email: string): Promise<Person> {
  const answer = await call(visitor, "POST", "/v1/auth/register", { email, password: `${name}'s long passphrase, 2026`, displayName: name });
  return { name, id: answer.body.user.id, token: answer.body.accessToken, refreshToken: answer.body.refreshToken };
}

// ---------------------------------------------------------------------------------------------

async function accounts(): Promise<[Person, Person, Person]> {
  section("1. Accounts");
  let answer = await call(visitor, "POST", "/v1/auth/register", { email: "Ada@Example.com", password: "Ada's long passphrase, 2026", displayName: "Ada" });
  const ada: Person = { name: "Ada", id: answer.body.user.id, token: answer.body.accessToken, refreshToken: answer.body.refreshToken };
  show(visitor, 'POST /v1/auth/register  {"email": "Ada@Example.com", ...}', answer, `user ${JSON.stringify(answer.body.user.email)}, ${answer.headers.get("cache-control")}`);
  // A JWT is header.payload.signature; the first two are base64url JSON, the third is raw bytes.
  const [header, payload] = ada.token.split(".").slice(0, 2).map((part) => JSON.parse(Buffer.from(part, "base64url").toString()));
  print(`${" ".repeat(16)}accessToken: a JWT. Header ${JSON.stringify(header)}`);
  print(`${" ".repeat(16)}payload ${JSON.stringify(payload)}: who, and until when; no permissions`);
  print(`${" ".repeat(16)}expiresIn ${answer.body.expiresIn} s; refreshToken "${ada.refreshToken.slice(0, 22)}...": a session id and a secret`);

  show(visitor, 'POST /v1/auth/register  {"email": "ada@example.com", ...}  (same address, other case)',
    await call(visitor, "POST", "/v1/auth/register", { email: "ada@example.com", password: "another long passphrase", displayName: "Ada 2" }));
  show(visitor, 'POST /v1/auth/register  {"password": "P@ssw0rd!", ...}',
    await call(visitor, "POST", "/v1/auth/register", { email: "eve@example.com", password: "P@ssw0rd!", displayName: "Eve" }));

  const bob = await register("Bob", "bob@example.com");
  const carol = await register("Carol", "carol@example.com");
  print(`${" ".repeat(13)}(Bob and Carol register too)`);
  answer = await call(ada, "GET", "/v1/users/me");
  show(ada, "GET /v1/users/me", answer, `${answer.body.displayName} <${answer.body.email}>`);
  answer = await call(visitor, "GET", "/v1/users/me");
  show(visitor, "GET /v1/users/me", answer);
  print(`${" ".repeat(16)}WWW-Authenticate: ${answer.headers.get("www-authenticate")}`);
  return [ada, bob, carol];
}

async function privateByDefault(ada: Person, bob: Person): Promise<string> {
  section("2. A new circuit is private");
  const netlist = await readFile(join(__dirname, "..", "netlists", "full-adder.net"));
  let answer = await call(ada, "POST", "/v1/circuits", netlist.toString(), { "Content-Type": "text/vnd.circuitlab.netlist" });
  const id: string = answer.body.id;
  show(ada, "POST /v1/circuits  (full-adder.net)", answer, `"${answer.body.name}", owner ${answer.body.owner.displayName}, ${answer.body.visibility}`);
  show(visitor, "POST /v1/circuits", await call(visitor, "POST", "/v1/circuits", netlist.toString(), { "Content-Type": "text/vnd.circuitlab.netlist" }));

  const theirs = await call(bob, "GET", `/v1/circuits/${id}`);
  const nobodys = await call(bob, "GET", "/v1/circuits/01999999-9999-7999-8999-999999999999");
  show(bob, "GET /v1/circuits/<Ada's circuit>", theirs);
  show(bob, "GET /v1/circuits/<an id nobody has>", nobodys);
  print(`${" ".repeat(16)}The same answer both times, so ids can't be probed to find private circuits.`);
  show(visitor, "GET /v1/circuits/<Ada's circuit>", await call(visitor, "GET", `/v1/circuits/${id}`));
  answer = await call(ada, "GET", "/v1/circuits");
  show(ada, "GET /v1/circuits  (default scope when signed in: owned)", answer, names(answer));
  answer = await call(bob, "GET", "/v1/circuits");
  show(bob, "GET /v1/circuits", answer, names(answer));
  return id;
}

async function sharing(ada: Person, bob: Person, carol: Person, id: string): Promise<void> {
  section("3. Sharing: viewer, then editor");
  const path = `/v1/circuits/${id}`;
  let answer = await call(ada, "POST", `${path}/shares`, { email: "bob@example.com", role: "viewer" });
  show(ada, 'POST .../shares  {"email": "bob@example.com", "role": "viewer"}', answer, `shared with ${answer.body.user.displayName} as ${answer.body.role}`);
  answer = await call(bob, "GET", path);
  show(bob, "GET /v1/circuits/<Ada's circuit>", answer, `"${answer.body.name}" by ${answer.body.owner.displayName}`);
  answer = await call(bob, "POST", `${path}/simulate`, { inputs: { A: 1, B: 1, Cin: 0 } });
  show(bob, 'POST .../simulate  {"inputs": {"A": 1, "B": 1, "Cin": 0}}', answer, `outputs ${JSON.stringify(answer.body.outputs)}`);
  show(bob, 'PATCH .../  {"name": "Bob\'s now"}', await call(bob, "PATCH", path, { name: "Bob's now" }));
  answer = await call(bob, "GET", "/v1/circuits?scope=shared");
  show(bob, "GET /v1/circuits?scope=shared", answer, names(answer));

  answer = await call(ada, "POST", `${path}/shares`, { email: "bob@example.com", role: "editor" });
  show(ada, 'POST .../shares  {"email": "bob@example.com", "role": "editor"}', answer, `(200, not 201: same share, role now ${answer.body.role})`);
  answer = await call(bob, "PATCH", path, { description: "Annotated by Bob" });
  show(bob, 'PATCH .../  {"description": "Annotated by Bob"}', answer, `version ${answer.body.version}`);
  show(bob, 'PATCH .../  {"visibility": "public"}', await call(bob, "PATCH", path, { visibility: "public" }));
  show(bob, "DELETE .../", await call(bob, "DELETE", path));
  show(bob, "GET .../shares", await call(bob, "GET", `${path}/shares`));
  answer = await call(ada, "GET", `${path}/shares`);
  show(ada, "GET .../shares", answer, answer.body.items.map((share: any) => `${share.user.displayName} <${share.user.email}> as ${share.role}`).join(", "));

  show(ada, 'POST .../shares  {"email": "nobody@example.com", ...}', await call(ada, "POST", `${path}/shares`, { email: "nobody@example.com", role: "viewer" }));
  show(ada, 'POST .../shares  {"email": "ada@example.com", ...}', await call(ada, "POST", `${path}/shares`, { email: "ada@example.com", role: "editor" }));
  show(carol, 'POST .../shares  {"email": "carol@example.com", ...}  (sharing it with herself)',
    await call(carol, "POST", `${path}/shares`, { email: "carol@example.com", role: "editor" }));
}

async function goingPublic(ada: Person, bob: Person, carol: Person, id: string): Promise<void> {
  section("4. Public: anyone may read and simulate, nobody new may change it");
  const path = `/v1/circuits/${id}`;
  let answer = await call(ada, "PATCH", path, { visibility: "public" });
  show(ada, 'PATCH .../  {"visibility": "public"}', answer, `${answer.body.visibility}, version ${answer.body.version}`);
  answer = await call(visitor, "GET", path);
  show(visitor, "GET /v1/circuits/<Ada's circuit>", answer, `"${answer.body.name}"`);
  answer = await call(visitor, "POST", `${path}/simulate`, { inputs: { A: 1, B: 0, Cin: 1 } });
  show(visitor, "POST .../simulate", answer, `outputs ${JSON.stringify(answer.body.outputs)}`);
  answer = await call(visitor, "GET", "/v1/circuits");
  show(visitor, "GET /v1/circuits  (default scope when signed out: public)", answer, names(answer));
  show(visitor, "GET /v1/circuits?scope=owned", await call(visitor, "GET", "/v1/circuits?scope=owned"));
  show(visitor, "PUT .../", await call(visitor, "PUT", path, "{}"));
  show(carol, 'PATCH .../  {"name": "Carol\'s"}', await call(carol, "PATCH", path, { name: "Carol's" }));

  section("5. Simulation history: the owner sees everyone's runs, others their own");
  answer = await call(ada, "GET", `${path}/runs`);
  show(ada, "GET .../runs", answer, `${answer.body.items.length} runs: ${answer.body.items.map((run: any) => JSON.stringify(run.inputs)).join(" ")}`);
  answer = await call(bob, "GET", `${path}/runs`);
  show(bob, "GET .../runs", answer, `${answer.body.items.length} run: ${answer.body.items.map((run: any) => JSON.stringify(run.inputs)).join(" ")}`);
  show(visitor, "GET .../runs", await call(visitor, "GET", `${path}/runs`));

  section("6. Leaving a share");
  show(bob, `DELETE .../shares/<Bob's id>`, await call(bob, "DELETE", `${path}/shares/${bob.id}`), "(Bob leaves)");
  answer = await call(bob, "GET", "/v1/circuits?scope=shared");
  show(bob, "GET /v1/circuits?scope=shared", answer, names(answer));
  show(bob, 'PATCH .../  {"name": "Bob\'s now"}', await call(bob, "PATCH", path, { name: "Bob's now" }));
}

async function tokens(ada: Person): Promise<void> {
  section("7. Access tokens the API refuses");
  const [header = "", payload = "", signature = ""] = ada.token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const sign = (head: string, body: string, key: string): string => createHmac("sha256", key).update(`${head}.${body}`).digest("base64url");
  const forged = (person: Person, token: string): Person => ({ ...person, token });

  const tampered = encode({ ...claims, sub: "someone-else" });
  show(ada, "GET /v1/users/me  (payload changed, old signature kept)", await call(forged(ada, `${header}.${tampered}.${signature}`), "GET", "/v1/users/me"));
  const none = encode({ alg: "none", typ: "JWT" });
  show(ada, 'GET /v1/users/me  ({"alg": "none"}, no signature)', await call(forged(ada, `${none}.${payload}.`), "GET", "/v1/users/me"));
  show(ada, "GET /v1/users/me  (signed with another key)", await call(forged(ada, `${header}.${payload}.${sign(header, payload, "not the server's key")}`), "GET", "/v1/users/me"));
  const expired = encode({ ...claims, iat: claims.iat - 3600, exp: claims.iat - 2700 });
  show(ada, "GET /v1/users/me  (correctly signed, expired 45 minutes ago)", await call(forged(ada, `${header}.${expired}.${sign(header, expired, SECRET)}`), "GET", "/v1/users/me"));
  show(ada, "GET /v1/users/me  (Authorization: Basic ...)", await call(visitor, "GET", "/v1/users/me", undefined, { Authorization: "Basic YWRhOnNlY3JldA==" }));

  section("8. Refresh tokens: each one works once");
  const first = ada.refreshToken;
  let answer = await call(visitor, "POST", "/v1/auth/refresh", { refreshToken: first });
  const second: string = answer.body.refreshToken;
  show(ada, "POST /v1/auth/refresh  (the refresh token from signing up)", answer, `new access token; same session, new secret: "...${first.slice(-8)}" became "...${second.slice(-8)}"`);
  show(ada, "POST /v1/auth/refresh  (the first one again: a stolen copy?)", await call(visitor, "POST", "/v1/auth/refresh", { refreshToken: first }));
  show(ada, "POST /v1/auth/refresh  (the new one)", await call(visitor, "POST", "/v1/auth/refresh", { refreshToken: second }));
  print(`${" ".repeat(16)}The replay ended the session, so the new token died with it: thief and owner both sign in again.`);

  answer = await call(visitor, "POST", "/v1/auth/login", { email: "ADA@example.com", password: "Ada's long passphrase, 2026" });
  const session: Person = { ...ada, token: answer.body.accessToken, refreshToken: answer.body.refreshToken };
  show(ada, "POST /v1/auth/login", answer, "a new session");
  show(ada, "POST /v1/auth/logout", await call(visitor, "POST", "/v1/auth/logout", { refreshToken: session.refreshToken }), "(session ended)");
  show(ada, "POST /v1/auth/refresh  (after signing out)", await call(visitor, "POST", "/v1/auth/refresh", { refreshToken: session.refreshToken }));
  answer = await call(session, "GET", "/v1/users/me");
  show(ada, "GET /v1/users/me  (the access token from before signing out)", answer, `still ${answer.status === 200 ? "accepted" : "refused"}`);
  print(`${" ".repeat(16)}Access tokens aren't looked up, so they live out their 15 minutes; that is why they are short.`);
}

async function guessing(): Promise<void> {
  section("9. Guessing passwords");
  for (let attempt = 1; attempt <= 6; attempt++) {
    const answer = await call(visitor, "POST", "/v1/auth/login", { email: "carol@example.com", password: `guess number ${attempt}` });
    show(visitor, `POST /v1/auth/login  (Carol's account, wrong password #${attempt})`, answer, answer.status === 429 ? `${answer.body.code}, Retry-After: ${answer.headers.get("retry-after")}` : "");
  }
  const right = await call(visitor, "POST", "/v1/auth/login", { email: "carol@example.com", password: "Carol's long passphrase, 2026" });
  show(visitor, "POST /v1/auth/login  (the right password, same address)", right, `${right.body.code}: blocked for this account from this address`);
  const nobody = await call(visitor, "POST", "/v1/auth/login", { email: "nobody@example.com", password: "guess number 1" });
  show(visitor, "POST /v1/auth/login  (an address with no account)", nobody);
  print(`${" ".repeat(16)}The same answer as a wrong password, after the same Argon2id work: no way to tell which addresses have accounts.`);
}

function names(answer: Answer): string {
  const items: { name: string }[] = answer.body?.items ?? [];
  return items.length === 0 ? "(none)" : items.map((item) => `"${item.name}"`).join(", ");
}

async function main(): Promise<void> {
  const config = new AppConfig({ port: 0, simulationWorkers: 1, jwtSecret: SECRET });
  const app = await createApp({ config, logLevels: ["error"] });
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  console.log(`\nCircuitLab API running at ${base} (in memory)`);
  try {
    const [ada, bob, carol] = await accounts();
    const id = await privateByDefault(ada, bob);
    await sharing(ada, bob, carol, id);
    await goingPublic(ada, bob, carol, id);
    await tokens(ada);
    await guessing();
    console.log();
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
