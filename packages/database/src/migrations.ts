import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "./generated/prisma/client";

const MIGRATIONS = join(__dirname, "..", "prisma", "migrations");

/** The migrations this version of the code expects, oldest first (folder names start with a timestamp). */
export function expectedMigrations(): string[] {
  return readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * The expected migrations that haven't been applied to the database, oldest first: all of them
 * for an empty database. `prisma migrate deploy` records each migration it applies in
 * `_prisma_migrations`; one that failed or was rolled back doesn't count.
 */
export async function pendingMigrations(client: PrismaClient): Promise<string[]> {
  const [table] = await client.$queryRaw<{ exists: boolean }[]>`SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists`;
  const applied = new Set<string>();
  if (table?.exists === true) {
    const rows = await client.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    for (const row of rows) applied.add(row.migration_name);
  }
  return expectedMigrations().filter((name) => !applied.has(name));
}
