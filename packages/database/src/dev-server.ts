/**
 * A local PostgreSQL 18 for development, with nothing to install: PGlite (Postgres compiled to
 * WebAssembly) served on an ordinary Postgres port by pglite-socket. Prisma, psql, and the API
 * connect to it like to any PostgreSQL server.
 *
 *   npm run db:start                  (then, in another terminal: npm run db:migrate)
 *   postgresql://postgres@127.0.0.1:5433/postgres
 *
 * Data is kept in .data/postgres at the repository root; delete that folder to start over.
 * Settings: DB_PORT (default 5433, next to a real Postgres's 5432) and DB_DATA_DIR.
 *
 * Differences from a real server: PGlite is a single session that pglite-socket shares between
 * connections. Simple statements and transactions from several connections are queued one after
 * another, but the messages of parameterized queries (the extended protocol, which Prisma uses) can
 * interleave between connections and fail with errors like `portal "" does not exist`. So the API
 * must use one connection here: DATABASE_POOL_SIZE=1 (already set in .env.example). Production,
 * and Docker in phase 11, use the official postgres:18 image, which has no such limit.
 */
import { join, resolve } from "node:path";
import { startLocalPostgres } from "./local-postgres";

async function main(): Promise<void> {
  const dataDir = resolve(process.env["DB_DATA_DIR"] ?? join(__dirname, "..", "..", "..", ".data", "postgres"));
  const server = await startLocalPostgres({ port: Number(process.env["DB_PORT"] ?? 5433), dataDir });
  console.log(`PostgreSQL ${server.version} (PGlite) listening on 127.0.0.1:${server.port}, data in ${dataDir}`);
  console.log(`DATABASE_URL=${server.url}`);
  console.log("DATABASE_POOL_SIZE=1   (this server handles one connection's queries at a time)");
  console.log("Ctrl+C to stop.");

  const stop = async (): Promise<void> => {
    console.log("Stopping...");
    await server.stop(); // flushes everything to disk
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
