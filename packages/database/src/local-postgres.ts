// A real PostgreSQL 18 for development and tests, with nothing to install: PGlite (Postgres
// compiled to WebAssembly) served on an ordinary Postgres port by pglite-socket. Used by
// `npm run db:start` (dev-server.ts) and by the API's integration tests.
//
// Development and test only: PGlite and pglite-socket are devDependencies, so this module is a
// separate entry point (@circuitlab/database/local), never loaded by the API itself.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const PACKAGE = join(__dirname, "..");

export interface LocalPostgresOptions {
  /** Port to listen on. Default: a free one. */
  readonly port?: number;
  /** Folder to keep the data in. Default: memory only, gone when stopped. */
  readonly dataDir?: string;
}

export interface LocalPostgres {
  /** The connection string. The API must use DATABASE_POOL_SIZE=1 with it (see below). */
  readonly url: string;
  readonly port: number;
  /** PostgreSQL's version, e.g. "18.3". */
  readonly version: string;
  /** Stops listening and closes the database, flushing it to disk if it has a data folder. */
  stop(): Promise<void>;
}

/**
 * Starts a local PostgreSQL server.
 *
 * One limitation: PGlite is a single session, which pglite-socket shares between connections, and
 * the messages of parameterized queries from different connections can interleave and fail. So
 * whatever connects should use a single connection: DATABASE_POOL_SIZE=1 for the API.
 */
export async function startLocalPostgres(options: LocalPostgresOptions = {}): Promise<LocalPostgres> {
  if (options.dataDir !== undefined) mkdirSync(options.dataDir, { recursive: true });
  const db = options.dataDir === undefined ? await PGlite.create({ extensions: { pg_trgm } }) : await PGlite.create(options.dataDir, { extensions: { pg_trgm } });
  const port = options.port ?? (await freePort());
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  const version = (await db.query<{ v: string }>("SELECT current_setting('server_version') AS v")).rows[0]?.v ?? "?";
  let stopped: Promise<void> | undefined;
  return {
    url: `postgresql://postgres@127.0.0.1:${port}/postgres`,
    port,
    version,
    stop() {
      // Safe to call more than once (a test's cleanup may stop a server the test already stopped).
      stopped ??= (async () => {
        await server.stop();
        await db.close();
      })();
      return stopped;
    },
  };
}

/**
 * Applies the migrations to a database the way production does: `prisma migrate deploy`, run as a
 * child process. Asynchronous on purpose: if the database lives in this very process (a
 * LocalPostgres), blocking here would keep it from answering the CLI.
 *
 * @throws Error with the CLI's output if it fails
 */
export function migrate(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cli = require.resolve("prisma/build/index.js");
    const child = spawn(process.execPath, [cli, "migrate", "deploy"], { cwd: PACKAGE, env: { ...process.env, DATABASE_URL: url } });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (status) => (status === 0 ? resolve() : reject(new Error(`prisma migrate deploy failed:\n${output}`))));
  });
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}
