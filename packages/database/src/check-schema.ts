/**
 * Checks the migrations, schema.prisma, and queries.sql on a real PostgreSQL 18: PGlite, which is
 * Postgres compiled to WebAssembly and runs inside this Node process, so there is nothing to install.
 *
 *   npm run db:check        (from the repository root)
 *
 * 1. Applies the migrations in order, as `prisma migrate deploy` does, and asks Prisma whether
 *    schema.prisma describes the resulting database exactly (prisma migrate diff). A circuit
 *    stored before accounts existed must survive the accounts migration.
 * 2. Tries data that breaks each rule, and expects the database to refuse it, naming the rule.
 * 3. Stores the example circuits through queries.sql and reads them back: they must be identical,
 *    down to their truth tables. Replacing one must leave exactly the replacement.
 * 4. Shows optimistic locking turning away a write based on an old version.
 * 5. Accounts, sharing, simulation history, and sessions, through their queries.
 * 6. Truth-table jobs: the allowance, an identical request getting the same job, and status
 *    changes that only move forward (compare-and-swap).
 * 7. Pages through circuits created within one millisecond, with cursors holding JavaScript dates.
 * 8. Fills the tables with 1,000 users, 50,000 circuits and 60,000 runs, and shows the query plans
 *    using the indexes.
 *
 * Every named query in queries.sql runs at least once; the check fails otherwise.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { CycleError, GATE_TYPES, SIMULATION_MODES, topologicalSort, truthTable, type Circuit, type Gate, type Wire } from "@circuitlab/engine";
import { importNetlistFile } from "@circuitlab/netlist";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const PACKAGE = join(__dirname, "..");
const MIGRATIONS = join(PACKAGE, "prisma", "migrations");
const NETLISTS = join(PACKAGE, "..", "..", "examples", "netlists");
/** Circuits stored before this migration have no owner; one must survive it. */
const ACCOUNTS_MIGRATION = "20261001210000_accounts_and_sharing";

/** The named statements in queries.sql, each introduced by `-- name: <name>`. */
const QUERIES = new Map(
  readFileSync(join(PACKAGE, "queries.sql"), "utf8")
    .split(/^-- name: /m)
    .slice(1)
    .map((block) => {
      const [name = "", ...lines] = block.split("\n");
      return [name.trim(), lines.join("\n").trim()] as const;
    }),
);
/** The ones this check has run, to prove at the end that it ran them all. */
const used = new Set<string>();

/** A well-formed Argon2id hash: the only kind of password the users table accepts. */
const PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g";
const DAY = 24 * 60 * 60 * 1000;

let db: PGlite;

function sql(name: string): string {
  const text = QUERIES.get(name);
  if (text === undefined) throw new Error(`queries.sql has no query named "${name}"`);
  used.add(name);
  return text;
}

async function run<T = Record<string, unknown>>(name: string, params: unknown[] = []): Promise<{ rows: T[]; affectedRows?: number }> {
  return db.query<T>(sql(name), params);
}

function section(title: string): void {
  console.log(`\n=== ${title} ${"=".repeat(Math.max(3, 72 - title.length))}\n`);
}

const print = (text: string): void => console.log(text.replace(/^(?=.)/gm, "  "));

async function createUser(email: string, displayName: string): Promise<string> {
  const id = (await run<{ id: string }>("insert_user", [email, displayName, PASSWORD_HASH])).rows[0]?.id;
  assert.ok(id !== undefined);
  return id;
}

/** The constraint a statement violated, or the enum type it misused. */
function refusal(error: unknown): string {
  const { constraint, message } = error as { constraint?: string; message: string };
  return constraint ?? /enum (\w+)/.exec(message)?.[0] ?? message;
}

// ---------------------------------------------------------------------------------------------
// Circuits <-> rows
// ---------------------------------------------------------------------------------------------

interface Summary {
  readonly inputKeys: string[];
  readonly outputKeys: string[];
  /** Empty when there is no loop. */
  readonly feedbackLoop: string[];
}

/** The summary columns, as the API computes them with the engine before every write. */
function summarize(circuit: Circuit): Summary {
  let feedbackLoop: string[] = [];
  try {
    topologicalSort(circuit);
  } catch (error) {
    if (!(error instanceof CycleError)) throw error;
    feedbackLoop = [...error.cycle];
  }
  const keys = (type: string): string[] => circuit.gates.filter((gate) => gate.type === type).map((gate) => gate.id);
  return { inputKeys: keys("INPUT"), outputKeys: keys("OUTPUT"), feedbackLoop };
}

type Transaction = Parameters<Parameters<PGlite["transaction"]>[0]>[0];

async function insertParts(tx: Transaction, id: string, circuit: Circuit): Promise<void> {
  await tx.query(sql("insert_gates"), [
    id,
    circuit.gates.map((gate) => gate.id),
    circuit.gates.map((gate) => gate.type),
    circuit.gates.map((gate) => gate.label ?? null),
    circuit.gates.map((gate) => (gate.type === "CONST" ? gate.value : null)),
  ]);
  await tx.query(sql("insert_wires"), [
    id,
    circuit.wires.map((wire) => wire.from),
    circuit.wires.map((wire) => wire.to),
    circuit.wires.map((wire) => wire.toPin),
    circuit.wires.map((wire) => wire.id ?? null),
  ]);
}

/** Stores a circuit the way the API does: one transaction, three statements from queries.sql. */
async function storeCircuit(circuit: Circuit, name: string, ownerId: string): Promise<string> {
  const { inputKeys, outputKeys, feedbackLoop } = summarize(circuit);
  return db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>(sql("insert_circuit"), [
      ownerId,
      name,
      null,
      circuit.gates.length,
      circuit.wires.length,
      inputKeys,
      outputKeys,
      feedbackLoop,
    ]);
    const id = inserted.rows[0]?.id ?? "";
    await insertParts(tx, id, circuit);
    return id;
  });
}

/** Replaces a circuit's contents if it is still at `version`, as PUT does. The new version, or undefined. */
async function replaceCircuit(id: string, version: number, circuit: Circuit, name: string): Promise<number | undefined> {
  const { inputKeys, outputKeys, feedbackLoop } = summarize(circuit);
  return db.transaction(async (tx) => {
    const updated = await tx.query<{ version: number }>(sql("replace_circuit_if_version"), [
      id,
      version,
      name,
      null,
      circuit.gates.length,
      circuit.wires.length,
      inputKeys,
      outputKeys,
      feedbackLoop,
    ]);
    const next = updated.rows[0]?.version;
    if (next === undefined) return undefined;
    await tx.query(sql("delete_gates"), [id]);
    await insertParts(tx, id, circuit);
    return next;
  });
}

interface GateRow {
  key: string;
  type: Gate["type"];
  label: string | null;
  const_value: 0 | 1 | null;
}

interface WireRow {
  source_key: string;
  target_key: string;
  target_pin: number;
  key: string | null;
}

async function loadCircuit(id: string): Promise<Circuit> {
  const [circuit, gates, wires] = await Promise.all([
    run<{ name: string }>("get_circuit", [id]),
    run<GateRow>("get_gates", [id]),
    run<WireRow>("get_wires", [id]),
  ]);
  return {
    name: circuit.rows[0]?.name ?? "",
    gates: gates.rows.map(
      (row): Gate =>
        ({
          id: row.key,
          type: row.type,
          ...(row.label !== null && { label: row.label }),
          ...(row.const_value !== null && { value: row.const_value }),
        }) as Gate,
    ),
    wires: wires.rows.map(
      (row): Wire => ({ ...(row.key !== null && { id: row.key }), from: row.source_key, to: row.target_key, toPin: row.target_pin }),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// 1. The schema
// ---------------------------------------------------------------------------------------------

async function applyMigrations(): Promise<void> {
  section("1. Applying the migrations; does schema.prisma agree?");
  const version = (await db.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0]?.v;
  print(`PostgreSQL ${version} (PGlite)`);
  let legacy: string | undefined;
  // Folder names start with a timestamp, so sorting them gives the order to apply them in.
  for (const migration of readdirSync(MIGRATIONS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    if (migration === ACCOUNTS_MIGRATION) {
      // What phases 4 to 6 wrote: a circuit nobody owns.
      legacy = (
        await db.query<{ id: string }>("INSERT INTO circuits (name, gate_count, wire_count, input_keys, output_keys) VALUES ('Made before accounts', 0, 0, '{}', '{}') RETURNING id")
      ).rows[0]?.id;
      print("stored a circuit with no owner, as phases 4 to 6 did");
    }
    await db.exec(readFileSync(join(MIGRATIONS, migration, "migration.sql"), "utf8"));
    print(`applied ${migration}`);
  }
  const count = async (query: string): Promise<number> => Number((await db.query<{ n: number }>(query)).rows[0]?.n);
  const inPublic = "relnamespace = 'public'::regnamespace";
  print(`${await count(`SELECT count(*) AS n FROM pg_class WHERE relkind = 'r' AND ${inPublic}`)} tables, ` +
    `${await count(`SELECT count(*) AS n FROM pg_class WHERE relkind = 'i' AND ${inPublic}`)} indexes, ` +
    `${await count("SELECT count(*) AS n FROM pg_constraint WHERE connamespace = 'public'::regnamespace")} constraints, ` +
    `${await count("SELECT count(*) AS n FROM pg_type WHERE typtype = 'e' AND typnamespace = 'public'::regnamespace")} enum types`);
  print(`queries.sql: ${QUERIES.size} named queries`);

  // The database's enums must list exactly what the engine's registries do: a gate type added to
  // the gate registry, or a mode added to the strategies, needs a migration too.
  const labels = async (type: string): Promise<string[]> =>
    (await db.query<{ label: string }>(`SELECT unnest(enum_range(NULL::${type}))::text AS label`)).rows.map((row) => row.label);
  assert.deepEqual(await labels("gate_type"), [...GATE_TYPES], "gate_type differs from the engine's gate registry");
  assert.deepEqual(await labels("simulation_mode"), [...SIMULATION_MODES], "simulation_mode differs from the engine's strategies");
  print(`gate_type and simulation_mode match the engine's gate registry and simulation strategies`);

  // The ownerless circuit is still there, private. Making the owner rule hold for every row
  // (VALIDATE CONSTRAINT) has to wait until it has an owner or is gone.
  const old = (await db.query<{ owner_id: string | null; visibility: string }>("SELECT owner_id, visibility FROM circuits WHERE id = $1", [legacy])).rows[0];
  assert.deepEqual(old, { owner_id: null, visibility: "private" });
  let validated: string;
  try {
    await db.transaction(async (tx) => {
      await tx.query("ALTER TABLE circuits VALIDATE CONSTRAINT circuits_owner_required");
      await tx.rollback();
    });
    validated = "succeeded (it should not have)";
  } catch (error) {
    validated = `is refused while it exists (${(error as Error).message})`;
  }
  print(`\nThe circuit with no owner survived the accounts migration: owner NULL, ${old?.visibility}.`);
  print(`VALIDATE CONSTRAINT circuits_owner_required ${validated}.`);
  await db.query("DELETE FROM circuits WHERE id = $1", [legacy]);

  // Prisma compares the real database with schema.prisma. This in-process database is served on a
  // free port for the occasion, so the Prisma CLI can connect to it like to any server. The CLI
  // runs as an asynchronous child process: blocking here would stop this process from answering it.
  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
  await server.start();
  try {
    const prisma = require.resolve("prisma/build/index.js");
    const { status, output } = await runProcess(
      process.execPath,
      [prisma, "migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"],
      // prisma.config.ts reads the database URL from DATABASE_URL.
      { ...process.env, DATABASE_URL: `postgresql://postgres@127.0.0.1:${port}/postgres` },
    );
    const verdict = output.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("Loaded Prisma config")).join("\n");
    assert.equal(status, 0, `schema.prisma and the migrations disagree:\n${verdict}`);
    print(`\nprisma migrate diff (database -> schema.prisma): ${verdict.trim()}`);
  } finally {
    await server.stop();
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: PACKAGE, env });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, output }));
  });
}

// ---------------------------------------------------------------------------------------------
// 2. Constraints
// ---------------------------------------------------------------------------------------------

async function constraints(): Promise<void> {
  section("2. What the database refuses");
  const ada = await createUser("ada@example.com", "Ada");
  const bob = await createUser("bob@example.com", "Bob");
  const c1 = await storeCircuit(
    {
      gates: [{ id: "A", type: "INPUT" }, { id: "B", type: "INPUT" }, { id: "x", type: "AND" }, { id: "Y", type: "OUTPUT" }],
      wires: [{ from: "A", to: "x", toPin: 0 }, { from: "B", to: "x", toPin: 1 }, { from: "x", to: "Y", toPin: 0 }],
    },
    "Bob's",
    bob,
  );
  await storeCircuit({ gates: [{ id: "Z", type: "INPUT" }], wires: [] }, "Ada's", ada);
  await run("share_circuit", [c1, ada, "viewer"]);
  await run("insert_session", [ada, createHash("sha256").update("secret").digest(), new Date(), new Date(Date.now() + DAY)]);

  const gate = `INSERT INTO gates (circuit_id, key, position, type, label, const_value) VALUES ('${c1}', $1, $2, $3, $4, $5)`;
  const wire = `INSERT INTO wires (circuit_id, source_key, target_key, target_pin, position) VALUES ('${c1}', $1, $2, $3, $4)`;
  const runRow = `INSERT INTO simulation_runs (circuit_id, circuit_version, kind, status, inputs, outputs, row_offset, row_limit, started_at, finished_at)
               VALUES ('${c1}', 1, $1, $2, $3, $4, $5, $6, $7, $8)`;
  const user = "INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'x', $2)";
  const share = "INSERT INTO circuit_shares (circuit_id, user_id, role) VALUES ($1, $2, $3)";
  const session = "INSERT INTO sessions (user_id, secret_hash, refreshed_at, expires_at) VALUES ($1, $2, $3, $4)";
  const now = new Date("2026-10-01T12:00:00Z");
  const before = new Date("2026-10-01T11:00:00Z");
  const nobody = "00000000-0000-7000-8000-0000000000ff";

  const cases: [rule: string, statement: string, params: unknown[], expected: string][] = [
    ["Two gates with the same key", gate, ["A", 9, "INPUT", null, null], "gates_pkey"],
    ["Two gates at the same position", gate, ["n", 0, "NOT", null, null], "gates_position_key"],
    ["A gate key that isn't netlist-safe", gate, ["a b", 9, "NOT", null, null], "gates_key_format"],
    ["A CONST without a value", gate, ["k", 9, "CONST", null, null], "gates_const_value"],
    ["A CONST with the value 2", gate, ["k", 9, "CONST", null, 2], "gates_const_value"],
    ["An AND with a value", gate, ["k", 9, "AND", null, 1], "gates_const_value"],
    ["An unknown gate type", gate, ["k", 9, "MAJORITY", null, null], "enum gate_type"],
    ["A label over 200 characters", gate, ["k", 9, "NOT", "x".repeat(201), null], "gates_label_length"],
    ["A pin driven by two wires", wire, ["B", "x", 0, 9], "wires_pkey"],
    ["A wire from a gate that doesn't exist", wire, ["ghost", "x", 2, 9], "wires_source_fkey"],
    ["A wire to a gate of another circuit", wire, ["A", "Z", 0, 9], "wires_target_fkey"],
    ["A wire to pin 64", wire, ["A", "x", 64, 9], "wires_pin_range"],
    ["A blank circuit name", "INSERT INTO circuits (owner_id, name, gate_count, wire_count, input_keys, output_keys) VALUES ($1, $2, 0, 0, '{}', '{}')", [ada, "   "], "circuits_name_valid"],
    ["A new circuit without an owner", "INSERT INTO circuits (name, gate_count, wire_count, input_keys, output_keys) VALUES ('x', 0, 0, '{}', '{}')", [], "circuits_owner_required"],
    ["A visibility other than private/public", `UPDATE circuits SET visibility = $1 WHERE id = '${c1}'`, ["friends"], "enum circuit_visibility"],
    ["An e-mail address in capitals", user, ["Ada@Example.com", PASSWORD_HASH], "users_email_format"],
    ["A second account for the same address", user, ["ada@example.com", PASSWORD_HASH], "users_email_key"],
    ["A password stored in plain text", user, ["carol@example.com", "hunter2"], "users_password_hash_format"],
    ["Sharing a circuit twice with one person", share, [c1, ada, "editor"], "circuit_shares_pkey"],
    ["A share with a role other than viewer/editor", share, [c1, bob, "admin"], "enum share_role"],
    ["A share for an account that doesn't exist", share, [c1, nobody, "viewer"], "circuit_shares_user_id_fkey"],
    ["A session storing its secret as it is", session, [ada, Buffer.from("secret"), now, new Date(now.getTime() + DAY)], "sessions_secret_hash_length"],
    ["A session expiring before its last refresh", session, [ada, randomBytes(32), now, before], "sessions_times_ordered"],
    ["A simulate run with truth-table fields", runRow, ["simulate", "succeeded", { A: 1 }, { Y: 1 }, 0, 10, before, now], "simulation_runs_kind_fields"],
    ["A simulate run without inputs", runRow, ["simulate", "failed", null, null, null, null, before, now], "simulation_runs_kind_fields"],
    ["A truth-table run without a range", runRow, ["truth_table", "queued", null, null, null, null, null, null], "simulation_runs_kind_fields"],
    ["A succeeded simulate run without outputs", runRow, ["simulate", "succeeded", { A: 1 }, null, null, null, before, now], "simulation_runs_status_fields"],
    ["A queued run that has already started", runRow, ["truth_table", "queued", null, null, 0, 10, before, null], "simulation_runs_status_fields"],
    ["A cancelled job without a finish time", runRow, ["truth_table", "cancelled", null, null, 0, 10, null, null], "simulation_runs_status_fields"],
    ["A run that finished before it started", runRow, ["truth_table", "failed", null, null, 0, 10, now, before], "simulation_runs_finished_after_started"],
    ["A sequential truth table", `INSERT INTO simulation_runs (circuit_id, circuit_version, kind, mode, status, row_offset, row_limit) VALUES ('${c1}', 1, 'truth_table', 'sequential', 'queued', 0, 10)`, [], "simulation_runs_truth_tables_combinational"],
  ];

  let refused = 0;
  for (const [rule, statement, params, expected] of cases) {
    let outcome: string;
    try {
      await db.transaction(async (tx) => {
        await tx.query(statement, params);
        await tx.rollback();
      });
      outcome = "ACCEPTED (should have been refused)";
    } catch (error) {
      const named = refusal(error);
      outcome = named === expected ? `refused by ${named}` : `refused, but by ${named}, not ${expected}`;
      if (named === expected) refused++;
    }
    print(`${rule.padEnd(46)} ${outcome}`);
  }
  print(`\n${refused === cases.length ? "OK" : "FAILED"}: ${refused} of ${cases.length} bad rows refused by the expected rule`);
  assert.equal(refused, cases.length);

  // Deleting cascades along the foreign keys.
  await run("record_simulation", [c1, 1, ada, { A: 1, B: 1 }, { Y: 1 }, null, "combinational"]);
  const counts = async (): Promise<string> => {
    const row = (await db.query<Record<string, number>>(`SELECT
        (SELECT count(*) FROM circuits) AS circuits, (SELECT count(*) FROM gates) AS gates,
        (SELECT count(*) FROM wires) AS wires, (SELECT count(*) FROM simulation_runs) AS runs,
        (SELECT count(*) FROM simulation_runs WHERE user_id IS NULL) AS anonymous_runs,
        (SELECT count(*) FROM circuit_shares) AS shares, (SELECT count(*) FROM sessions) AS sessions`)).rows[0] ?? {};
    return Object.entries(row).map(([key, value]) => `${value} ${key.replace("_", " ")}`).join(", ");
  };
  print(`\nBefore deleting:                  ${await counts()}`);
  await db.query("DELETE FROM users WHERE id = $1", [ada]);
  print(`After deleting Ada:               ${await counts()}`);
  print("  (her circuit, the share she received, and her session went; her run of Bob's circuit stays, anonymous)");
  await run("delete_circuit_if_version", [c1, 1]);
  print(`After deleting Bob's circuit:     ${await counts()}  (its gates, wires, and runs went with it)`);
  await db.query("DELETE FROM users WHERE id = $1", [bob]);
}

// ---------------------------------------------------------------------------------------------
// 3. Round trip
// ---------------------------------------------------------------------------------------------

async function roundTrip(): Promise<void> {
  section("3. Round trip: circuits in, the same circuits out");
  const owner = await createUser("grace@example.com", "Grace");
  const examples: [string, Circuit][] = [];
  for (const file of ["half-adder.net", "full-adder.net", "c17.net", "sr-latch.net"]) {
    examples.push([file, await importNetlistFile(join(NETLISTS, file))]);
  }
  // Every column in use: CONST values, labels, wire ids, and a gate with the maximum 64 inputs
  // (48 circuit inputs plus 16 constants, since a truth table allows at most 53 inputs).
  const wide: Circuit = {
    gates: [
      ...Array.from({ length: 48 }, (_, k): Gate => ({ id: `in[${k}]`, type: "INPUT" })),
      ...Array.from({ length: 16 }, (_, k): Gate => ({ id: `k${k}`, type: "CONST", value: k % 2 === 0 ? 0 : 1, label: `tied ${k % 2 === 0 ? "low" : "high"}` })),
      { id: "parity", type: "XOR", label: "64-input XOR" },
      { id: "odd", type: "OUTPUT" },
    ],
    wires: [
      ...Array.from({ length: 64 }, (_, k): Wire => ({ id: `w${k}`, from: k < 48 ? `in[${k}]` : `k${k - 48}`, to: "parity", toPin: k })),
      { from: "parity", to: "odd", toPin: 0 },
    ],
  };
  examples.push(["(generated) 64-input XOR", wide]);

  const behaviourOf = (label: string, loaded: Circuit, original: Circuit): string => {
    const summary = summarize(original);
    if (summary.feedbackLoop.length > 0) {
      assert.deepEqual(summarize(loaded).feedbackLoop, summary.feedbackLoop);
      return `same feedback loop, ${summary.feedbackLoop.join(" -> ")}`;
    }
    const range = { limit: Math.min(2 ** summary.inputKeys.length, 4096) };
    assert.deepEqual(truthTable(loaded, range), truthTable(original, range), `${label}: truth tables differ`);
    return `truth table identical (${range.limit.toLocaleString("en")} rows compared)`;
  };

  const ids: string[] = [];
  for (const [label, original] of examples) {
    const id = await storeCircuit(original, original.name ?? label, owner);
    ids.push(id);
    const loaded = await loadCircuit(id);
    assert.deepEqual(loaded.gates, original.gates, `${label}: gates differ`);
    assert.deepEqual(loaded.wires, original.wires, `${label}: wires differ`);
    print(`${label.padEnd(26)} ${original.gates.length} gates, ${original.wires.length} wires: identical; ${behaviourOf(label, loaded, original)}`);
  }

  // A replacement (PUT) deletes the old gates, and with them the old wires, before inserting the new.
  const [, fullAdder] = examples[1] ?? [];
  assert.ok(fullAdder !== undefined && ids[0] !== undefined);
  const version = await replaceCircuit(ids[0], 1, fullAdder, "Half adder, now a full adder");
  const replaced = await loadCircuit(ids[0]);
  assert.equal(version, 2);
  assert.deepEqual(replaced.gates, fullAdder.gates);
  assert.deepEqual(replaced.wires, fullAdder.wires);
  print(`\nReplacing the half adder with the full adder: version 2, ${replaced.gates.length} gates, ${replaced.wires.length} wires, nothing left over; ${behaviourOf("replacement", replaced, fullAdder)}`);
  assert.equal(await replaceCircuit(ids[0], 1, fullAdder, "again"), undefined);
  print("Replacing it again from version 1: refused, it is at version 2 now.");
}

// ---------------------------------------------------------------------------------------------
// 4. Optimistic locking
// ---------------------------------------------------------------------------------------------

async function optimisticLocking(): Promise<void> {
  section("4. Optimistic locking: two people edit the same circuit");
  const owner = await createUser("lin@example.com", "Lin");
  const id = await storeCircuit({ gates: [{ id: "A", type: "INPUT" }], wires: [] }, "Shared circuit", owner);
  print("Ada and Bob both load version 1.");
  const first = await run<{ version: number }>("update_metadata_if_version", [id, 1, "Ada's name", false, null, null]);
  print(`Ada saves a new name  (... WHERE version = 1): ${first.rows.length} row changed, now version ${first.rows[0]?.version}`);
  const second = await run("update_metadata_if_version", [id, 1, "Bob's name", false, null, null]);
  print(`Bob saves his         (... WHERE version = 1): ${second.rows.length} rows changed: the API answers 412, nothing is overwritten`);
  const deleted = await run("delete_circuit_if_version", [id, 1]);
  print(`Bob deletes it        (... WHERE version = 1): ${deleted.affectedRows} rows deleted, for the same reason`);
  const name = (await run<{ name: string }>("get_circuit", [id])).rows[0]?.name;
  assert.equal(name, "Ada's name");
  print(`The circuit is still called "${name}".`);
}

// ---------------------------------------------------------------------------------------------
// 5. Accounts, sharing, history, sessions
// ---------------------------------------------------------------------------------------------

async function accountsAndSharing(): Promise<void> {
  section("5. Accounts, sharing, simulation history, and sessions");
  const ada = await createUser("ada.l@example.com", "Ada");
  const bob = await createUser("bob.k@example.com", "Bob");
  const carol = await createUser("carol@example.com", "Carol");
  let taken: string;
  try {
    await createUser("ada.l@example.com", "Another Ada");
    taken = "accepted (it should not have been)";
  } catch (error) {
    taken = `refused by ${refusal(error)}: the API answers 409`;
  }
  print(`Accounts for Ada, Bob, and Carol. A second account for Ada's address: ${taken}.`);
  const found = (await run<{ id: string; display_name: string }>("user_by_email", ["ada.l@example.com"])).rows[0];
  assert.equal(found?.id, ada);
  print(`Signing in looks Ada up by address: found "${found?.display_name}".`);

  const id = await storeCircuit(
    { gates: [{ id: "A", type: "INPUT" }, { id: "n", type: "NOT" }, { id: "Y", type: "OUTPUT" }], wires: [{ from: "A", to: "n", toPin: 0 }, { from: "n", to: "Y", toPin: 0 }] },
    "Ada's inverter",
    ada,
  );
  type Access = { owner_id: string; visibility: string; role: string | null };
  const who: [string, string | null][] = [["Ada", ada], ["Bob", bob], ["Carol", carol], ["signed out", null]];
  const showAccess = async (moment: string): Promise<void> => {
    const facts = await Promise.all(who.map(async ([, user]) => (await run<Access>("access_of", [id, user])).rows[0]));
    const describe = (fact: Access | undefined, user: string | null): string =>
      fact === undefined ? "?" : fact.owner_id === user ? "owner" : fact.role ?? (fact.visibility === "public" ? "public" : "none");
    print(`${moment.padEnd(36)} ${who.map(([name, user], k) => `${name}: ${describe(facts[k], user)}`).join(", ")}`);
  };
  await showAccess("New, private:");
  const shared = (await run<{ created: boolean }>("share_circuit", [id, bob, "viewer"])).rows[0];
  assert.equal(shared?.created, true);
  await showAccess("Shared with Bob as viewer:");
  const changed = (await run<{ created: boolean; role: string }>("share_circuit", [id, bob, "editor"])).rows[0];
  assert.deepEqual([changed?.created, changed?.role], [false, "editor"]);
  await showAccess("Shared again, as editor (same row):");
  const shares = (await run<{ display_name: string; role: string }>("list_shares", [id])).rows;
  const sharedWithBob = (await run<{ name: string; role: string }>("list_shared_with", [21, bob])).rows;
  print(`${"".padEnd(36)} Ada's list of shares: ${shares.map((s) => `${s.display_name} (${s.role})`).join(", ")}; Bob's "shared with me": ${sharedWithBob.map((c) => `${c.name} (${c.role})`).join(", ")}`);
  await run("update_metadata_if_version", [id, 1, null, false, null, "public"]);
  await showAccess("Made public (version 2):");
  const unshared = await run("unshare_circuit", [id, bob]);
  assert.equal(unshared.affectedRows, 1);
  await showAccess("Bob's share removed:");

  // Simulation history: the owner sees every run; anyone else, only their own.
  await run("record_simulation", [id, 2, ada, { A: 0 }, { Y: 1 }, null, "combinational"]);
  await run("record_simulation", [id, 2, bob, { A: 1 }, { Y: 0 }, null, "sequential"]);
  await run("record_simulation", [id, 2, null, { A: 2 }, null, "invalid-inputs", "combinational"]);
  const everyone = (await run("recent_runs", [id, 20])).rows.length;
  const bobs = (await run("recent_runs_by_user", [id, 20, bob])).rows.length;
  assert.deepEqual([everyone, bobs], [3, 1]);
  print(`\nThree simulations (by Ada, Bob, and someone signed out): Ada sees ${everyone} runs, Bob sees his ${bobs}.`);

  // Sessions: the secret is replaced on every refresh, and a replaced one no longer works.
  const hash = (secret: Buffer): Buffer => createHash("sha256").update(secret).digest();
  const now = new Date();
  const later = new Date(now.getTime() + 30 * DAY);
  const first = randomBytes(32);
  const session = (await run<{ id: string }>("insert_session", [ada, hash(first), now, later])).rows[0]?.id;
  const second = randomBytes(32);
  const rotated = await run<{ user_id: string }>("rotate_session", [session, hash(first), hash(second), new Date(now.getTime() + 1000), later]);
  assert.equal(rotated.rows[0]?.user_id, ada);
  const replayed = await run("rotate_session", [session, hash(first), hash(randomBytes(32)), new Date(now.getTime() + 2000), later]);
  assert.equal(replayed.rows.length, 0);
  print("\nAda signs in: a session row holding only the SHA-256 of her refresh token's secret.");
  print("Refreshing with that secret replaces it: 1 row changed.");
  print("Refreshing with the replaced secret: 0 rows changed. The API takes that as a stolen token and ends the session:");
  const ended = await run("delete_session", [session]);
  print(`delete_session: ${ended.affectedRows} row deleted.`);
  await run("insert_session", [carol, hash(randomBytes(32)), new Date(now.getTime() - 40 * DAY), new Date(now.getTime() - 10 * DAY)]);
  const expired = await run("delete_expired_sessions", [now]);
  assert.equal(expired.affectedRows, 1);
  print(`Housekeeping (delete_expired_sessions): ${expired.affectedRows} expired session removed.`);
}

// ---------------------------------------------------------------------------------------------
// 6. Truth-table jobs
// ---------------------------------------------------------------------------------------------

/**
 * A job is a truth_table run whose status only moves forward. Starting one is a transaction
 * (lock, allowance, then insert, as the API does it), and every later change is a compare-and-swap
 * on the status: of a cancellation and a finishing worker, exactly one wins.
 */
async function jobs(): Promise<void> {
  section("6. Truth-table jobs: allowance, retries, and racing status changes");
  const lea = await createUser("lea@example.com", "Lea");
  const max = await createUser("max@example.com", "Max");
  const id = await storeCircuit(
    { gates: [{ id: "A", type: "INPUT" }, { id: "B", type: "INPUT" }, { id: "x", type: "XOR" }, { id: "Y", type: "OUTPUT" }], wires: [{ from: "A", to: "x", toPin: 0 }, { from: "B", to: "x", toPin: 1 }, { from: "x", to: "Y", toPin: 0 }] },
    "Lea's XOR",
    lea,
  );
  const now = new Date("2026-10-01T12:00:00Z");
  const at = (minutes: number): Date => new Date(now.getTime() + minutes * 60_000);
  type Allowance = { started: number; unfinished: number; oldest: Date | null };

  /** What the API does when Lea asks for rows offset..offset+limit-1: the same request twice gets the same job. */
  const start = (offset: number, limit: number, when: Date): Promise<{ id: string; existing: boolean; allowance: Allowance }> =>
    db.transaction(async (tx) => {
      await tx.query(sql("lock_user_jobs"), [lea]);
      const allowance = (await tx.query<Allowance>(sql("job_allowance"), [lea, new Date(when.getTime() - DAY)])).rows[0] ?? { started: 0, unfinished: 0, oldest: null };
      const same = (await tx.query<{ id: string }>(sql("identical_unfinished_job"), [lea, id, 1, offset, limit])).rows[0];
      if (same !== undefined) return { id: same.id, existing: true, allowance };
      const created = (await tx.query<{ id: string }>(sql("insert_job"), [id, 1, lea, offset, limit, when])).rows[0];
      assert.ok(created !== undefined);
      return { id: created.id, existing: false, allowance };
    });

  const first = await start(0, 4, at(0));
  const again = await start(0, 4, at(1));
  assert.deepEqual([again.id, again.existing], [first.id, true]);
  print("Lea starts a job for rows 0-3, then sends the same request again (say her first answer was lost):");
  print("the second finds the first job still queued, and gets it back. One job, not two.");
  const second = await start(2, 2, at(2));
  assert.deepEqual([Number(second.allowance.started), Number(second.allowance.unfinished)], [1, 1]);
  const third = await db.query<Allowance>(sql("job_allowance"), [lea, new Date(at(3).getTime() - DAY)]);
  assert.equal(Number(third.rows[0]?.unfinished), 2);
  print(`A job for rows 2-3 is new. Now job_allowance says ${third.rows[0]?.unfinished} unfinished: a third would be refused (429).`);

  // A worker takes the first job. A retry after a failed attempt starts it again; that's allowed.
  const started = (await run<{ row_offset: string; row_limit: number }>("start_job", [first.id, at(4)])).rows[0];
  assert.deepEqual([Number(started?.row_offset), started?.row_limit], [0, 4]);
  assert.equal((await run("start_job", [first.id, at(5)])).rows.length, 1);
  const status = (await run<{ status: string }>("job_status", [first.id])).rows[0]?.status;
  assert.equal(status, "running");
  print(`\nA worker starts the first job (start_job), and once more as a retry: status ${status}.`);

  // Lea cancels the second while it waits; a worker that took it anyway can no longer finish it.
  const cancelled = await run("cancel_job", [second.id, at(6)]);
  const lateStart = await run("start_job", [second.id, at(7)]);
  const lateFinish = await run("complete_job", [second.id, at(8)]);
  assert.deepEqual([cancelled.rows.length, lateStart.rows.length, lateFinish.rows.length], [1, 0, 0]);
  print("Lea cancels the second (cancel_job: 1 row). A worker asking for it afterwards gets nothing back (start_job: 0 rows),");
  print("and neither can it be completed (complete_job: 0 rows): its status only moves forward.");

  // The first finishes; cancelling it afterwards changes nothing, and failing it neither.
  const completed = await run("complete_job", [first.id, at(9)]);
  const tooLate = [(await run("cancel_job", [first.id, at(10)])).rows.length, (await run("fail_job", [first.id, at(10), "internal-error"])).rows.length];
  assert.deepEqual([completed.rows.length, ...tooLate], [1, 0, 0]);
  print("The first succeeds (complete_job: 1 row); a cancellation or failure arriving later changes 0 rows.");

  const hers = (await run<{ status: string; row_limit: number }>("get_job", [first.id, id, lea])).rows[0];
  const notHis = (await run("get_job", [first.id, id, max])).rows.length;
  assert.deepEqual([hers?.status, notHis], ["succeeded", 0]);
  print(`get_job: Lea sees her job (${hers?.status}); Max, asking for the same id, gets nothing.`);
  const history = (await run<{ kind: string; status: string; row_offset: string | null; row_limit: number | null }>("recent_runs", [id, 10])).rows;
  print(`The circuit's history (recent_runs): ${history.map((row) => `${row.kind} ${row.status} rows ${row.row_offset}+${row.row_limit}`).join("; ")}`);

  // A job that couldn't be queued is forgotten, but only while no worker has touched it.
  const unqueued = (await db.query<{ id: string }>(sql("insert_job"), [id, 1, lea, 0, 2, at(11)])).rows[0]?.id;
  const discarded = await run("discard_job", [unqueued]);
  const notStarted = await run("discard_job", [first.id]);
  assert.deepEqual([discarded.affectedRows, notStarted.affectedRows], [1, 0]);
  print("A job Redis couldn't take is forgotten (discard_job: 1 row); one a worker already ran is not (0 rows).");

  // Housekeeping: a job left unfinished for over an hour has been lost, and is failed.
  const lost = (await db.query<{ id: string }>(sql("insert_job"), [id, 1, lea, 0, 1, at(-120)])).rows[0]?.id;
  const failed = await run<{ id: string }>("fail_abandoned_jobs", [now, at(-60)]);
  assert.deepEqual(failed.rows.map((row) => row.id), [lost]);
  const failedJob = (await run<{ status: string; error_code: string }>("get_job", [lost, id, lea])).rows[0];
  print(`\nHousekeeping (fail_abandoned_jobs): a job queued two hours ago and never run becomes ${failedJob?.status} (${failedJob?.error_code}).`);
  const allowance = (await run<Allowance>("job_allowance", [lea, new Date(now.getTime() - DAY)])).rows[0];
  print(`Lea's allowance now: ${allowance?.started} jobs started in the last 24 hours, ${allowance?.unfinished} unfinished.`);
}

// ---------------------------------------------------------------------------------------------
// 7. Cursors and timestamp precision
// ---------------------------------------------------------------------------------------------

/**
 * A list cursor carries the last circuit's created_at as a JavaScript Date, which keeps only
 * milliseconds. With microsecond timestamps, the cursor was slightly earlier than the stored value,
 * so another circuit from the same millisecond looked "newer than the cursor" and was skipped
 * (fixed by the millisecond_timestamps migration). Pages of one circuit must show all three.
 */
async function cursorPrecision(): Promise<void> {
  section("7. Cursors: three circuits created within one millisecond");
  const owner = await createUser("mia@example.com", "Mia");
  const names = ["first", "second", "third"];
  await db.query(
    `INSERT INTO circuits (owner_id, name, gate_count, wire_count, input_keys, output_keys, created_at, updated_at)
     SELECT $1, name, 0, 0, '{}', '{}', at, at
     FROM unnest($2::text[], $3::timestamptz[]) AS t(name, at)`,
    [owner, names, ["2100-01-01 00:00:00.1231+00", "2100-01-01 00:00:00.1232+00", "2100-01-01 00:00:00.1234+00"]],
  );
  print("Created at 00:00:00.1231, .1232 and .1234 (microseconds); stored as .123 by timestamptz(3).");

  type Row = { id: string; name: string; created_at: Date };
  const seen: string[] = [];
  let page = (await run<Row>("list_owned", [1, owner])).rows;
  for (let n = 1; n <= names.length; n++) {
    const last = page[0];
    assert.ok(last !== undefined, `page ${n} is empty`);
    seen.push(last.name);
    print(`Page ${n}: ${last.name.padEnd(7)} next cursor (${last.created_at.toISOString()}, ${last.id})`);
    page = (await run<Row>("list_owned_after", [1, owner, last.created_at, last.id])).rows;
  }
  assert.deepEqual([...seen].sort(), names, `pages showed ${seen.join(", ")}`);
  assert.equal(page.length, 0);
  print("All three appear, once each.");
}

// ---------------------------------------------------------------------------------------------
// 8. Indexes
// ---------------------------------------------------------------------------------------------

async function indexes(): Promise<void> {
  section("8. Indexes at work: 1,000 users, 50,000 circuits (a quarter public), 500,000 gates, 60,000 runs");
  // User n gets the id user(n), so each circuit's owner is computed rather than looked up.
  //
  // The ANALYZEs between the inserts matter: without the one on `circuits`, these inserts took over
  // ten minutes after the earlier sections had run, against 8 seconds with it. The likely reason:
  // PostgreSQL keeps one plan per session for each foreign-key check, made while the tables held a
  // handful of rows, and new statistics make it plan again. On a real server, autovacuum refreshes
  // statistics as a table grows; PGlite has no autovacuum.
  const user = (n: string): string => `('00000000-0000-7000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
  await db.exec(`
    INSERT INTO users (id, email, display_name, password_hash)
    SELECT ${user("n")}, 'user' || n || '@example.com', 'User ' || n, '${PASSWORD_HASH}' FROM generate_series(1, 1000) AS n;
    ANALYZE users;
    INSERT INTO circuits (owner_id, visibility, name, gate_count, wire_count, input_keys, output_keys, created_at, updated_at)
    SELECT ${user("n % 1000 + 1")}, CASE WHEN n % 4 = 0 THEN 'public' ELSE 'private' END::circuit_visibility,
           'Circuit ' || n || CASE n % 3 WHEN 0 THEN ' adder' WHEN 1 THEN ' multiplexer' ELSE ' counter' END,
           10, 12, '{A,B}', '{Y}', t.at, t.at
    FROM generate_series(1, 50000) AS n, LATERAL (SELECT timestamptz '2026-01-01' + n * interval '1 minute' AS at) AS t;
    ANALYZE circuits;
    INSERT INTO gates (circuit_id, key, position, type)
    SELECT c.id, 'g' || n, n, 'INPUT' FROM circuits AS c, generate_series(0, 9) AS n
    WHERE c.owner_id BETWEEN ${user("1")} AND ${user("1000")}; -- only the new circuits
    -- Every fourth private circuit is shared with someone other than its owner.
    INSERT INTO circuit_shares (circuit_id, user_id, role)
    SELECT p.id, ${user("p.k % 1000 + 1")}, CASE WHEN p.k % 8 = 0 THEN 'editor' ELSE 'viewer' END::share_role
    FROM (
      SELECT c.id, c.owner_id, row_number() OVER (ORDER BY c.created_at) AS k
      FROM circuits AS c
      WHERE c.visibility = 'private' AND c.owner_id BETWEEN ${user("1")} AND ${user("1000")}
    ) AS p
    WHERE p.k % 4 = 0 AND p.owner_id <> ${user("p.k % 1000 + 1")};
    -- 60,000 runs: simulations by everyone, and 2,000 truth-table jobs (the 10 newest unfinished).
    INSERT INTO simulation_runs (circuit_id, circuit_version, user_id, kind, status, inputs, outputs, row_offset, row_limit, created_at, started_at, finished_at)
    SELECT c.id, 1, c.owner_id,
           CASE WHEN n % 30 = 0 THEN 'truth_table' ELSE 'simulate' END::run_kind,
           CASE WHEN n % 30 = 0 AND n > 59700 THEN 'queued' ELSE 'succeeded' END::run_status,
           CASE WHEN n % 30 = 0 THEN NULL ELSE '{"A": 1, "B": 0}'::jsonb END,
           CASE WHEN n % 30 = 0 THEN NULL ELSE '{"Y": 1}'::jsonb END,
           CASE WHEN n % 30 = 0 THEN 0 END, CASE WHEN n % 30 = 0 THEN 4 END,
           t.at, CASE WHEN n % 30 = 0 AND n > 59700 THEN NULL ELSE t.at END, CASE WHEN n % 30 = 0 AND n > 59700 THEN NULL ELSE t.at END
    FROM generate_series(1, 60000) AS n
    JOIN LATERAL (SELECT id, owner_id FROM circuits WHERE owner_id = ${user("n % 1000 + 1")} LIMIT 1) AS c ON true,
    LATERAL (SELECT timestamptz '2026-09-01' + n * interval '30 seconds' AS at) AS t;
    ANALYZE;
  `);
  const shares = Number((await db.query<{ n: number }>("SELECT count(*) AS n FROM circuit_shares")).rows[0]?.n);
  print(`(and ${shares.toLocaleString("en")} shares)\n`);
  const someone = "00000000-0000-7000-8000-000000000001";
  const theirs = (
    await db.query<{ created_at: Date; id: string }>("SELECT created_at, id FROM circuits WHERE owner_id = $1 ORDER BY created_at DESC, id DESC OFFSET 19 LIMIT 1", [someone])
  ).rows[0];
  const deep = (
    await db.query<{ created_at: Date; id: string }>(
      "SELECT created_at, id FROM circuits WHERE visibility = 'public' ORDER BY created_at DESC, id DESC OFFSET 10000 LIMIT 1",
    )
  ).rows[0];
  const anyCircuit = (await db.query<{ id: string }>("SELECT id FROM circuits LIMIT 1")).rows[0]?.id;

  const plan = async (statement: string, params: unknown[]): Promise<{ steps: string; ms: number }> => {
    const rows = (await db.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, COSTS OFF) ${statement}`, params)).rows.map((row) => row["QUERY PLAN"]);
    const steps = rows
      .filter((line) => /Scan|Sort|Limit|Loop|Join/.test(line) && !/Heap Blocks|Recheck|Sort Method|Sort Key/.test(line))
      .map((line) => line.trim().replace(/^->\s*/, "").replace(/\s*\(actual.*$/, ""))
      .join(" -> ");
    const ms = Number(/Execution Time: ([\d.]+)/.exec(rows.join("\n"))?.[1] ?? NaN);
    return { steps, ms };
  };
  const show = async (label: string, statement: string, params: unknown[]): Promise<number> => {
    const { steps, ms } = await plan(statement, params);
    print(`${label}\n    ${steps}  (${ms.toFixed(2)} ms)`);
    return ms;
  };

  await show("Someone's circuits, newest first (list_owned)", sql("list_owned"), [21, someone]);
  await show("Their second page, by cursor (list_owned_after)", sql("list_owned_after"), [21, someone, theirs?.created_at, theirs?.id]);
  const keyset = await show("Public circuits, page 500, by cursor (list_public_after)", sql("list_public_after"), [21, deep?.created_at, deep?.id]);
  const offset = await show(
    "Public circuits, page 500, by OFFSET, for comparison",
    "SELECT id, name FROM circuits WHERE visibility = 'public' ORDER BY created_at DESC, id DESC OFFSET 10000 LIMIT 21",
    [],
  );
  await show("Public circuits by name, after a cursor (list_public_by_name_after)", sql("list_public_by_name_after"), [21, "Circuit 4", anyCircuit]);
  await show("Circuits shared with someone (list_shared_with)", sql("list_shared_with"), [21, someone]);
  await show("Name search among public circuits, q=12345 (search_public_by_name)", sql("search_public_by_name"), [21, "12345"]);
  await show("A circuit's gates in order (get_gates)", sql("get_gates"), [anyCircuit]);
  const jobOwner = "00000000-0000-7000-8000-000000000001";
  await show("Someone's jobs in the last 24 hours (job_allowance)", sql("job_allowance"), [jobOwner, new Date("2026-09-20T00:00:00Z")]);
  await show("Jobs unfinished for over an hour (fail_abandoned_jobs)", sql("fail_abandoned_jobs"), [
    new Date("2026-10-01T00:00:00Z"),
    new Date("2026-09-30T23:00:00Z"),
  ]);
  print(`\nThe cursor reads 21 rows from the index; OFFSET reads and throws away 10,000 first (${(offset / keyset).toFixed(0)}x slower here).`);
}

async function main(): Promise<void> {
  db = new PGlite({ extensions: { pg_trgm } });
  try {
    await applyMigrations();
    await constraints();
    await roundTrip();
    await optimisticLocking();
    await accountsAndSharing();
    await jobs();
    await cursorPrecision();
    await indexes();
    const unused = [...QUERIES.keys()].filter((name) => !used.has(name));
    assert.deepEqual(unused, [], `queries.sql has queries this check never ran: ${unused.join(", ")}`);
    console.log(`\nAll ${QUERIES.size} named queries in queries.sql ran.\n`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
