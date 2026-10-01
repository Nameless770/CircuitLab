// Configuration for the Prisma CLI (generate, migrate deploy, migrate diff, studio).
import { join } from "node:path";
import { defineConfig } from "prisma/config";

/** The local development server started by `npm run db:start` (see src/dev-server.ts). */
const LOCAL_DEVELOPMENT_DATABASE = "postgresql://postgres@127.0.0.1:5433/postgres";

// The repository's .env, if there is one (see .env.example): Prisma 7 no longer reads .env files
// itself. Variables already set in the shell keep their values.
try {
  process.loadEnvFile(join(__dirname, "..", "..", ".env"));
} catch (error) {
  if ((error as { code?: unknown }).code !== "ENOENT") throw error;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Production, CI, and Docker set DATABASE_URL; on a developer's machine the CLI talks to the
  // local server by default. (The API itself never falls back like this: without DATABASE_URL it
  // keeps circuits in memory.)
  datasource: { url: process.env["DATABASE_URL"] ?? LOCAL_DEVELOPMENT_DATABASE },
});
