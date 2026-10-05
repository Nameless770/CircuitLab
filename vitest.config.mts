import { defineConfig } from "vitest/config";

/**
 * One Vitest run over every package. Tests import the packages by name (`@circuitlab/engine`,
 * `@circuitlab/api`, ...), which resolves to their compiled `dist/`, exactly as the app and the
 * demos do: the code under test is what `tsc -b` built, with the same compiler settings and
 * decorator metadata as production. `npm test` builds first.
 */
export default defineConfig({
  test: {
    // Built workspace packages are loaded by Node itself, like anything in node_modules, rather
    // than run through Vite's transforms: NestJS (ES modules) is then loaded by the same
    // require(esm) path as in production.
    server: { deps: { external: [/\/(packages|apps)\/[^/]+\/dist\//] } },
    projects: [
      { extends: true, test: { name: "engine", include: ["packages/engine/test/**/*.test.ts"] } },
      { extends: true, test: { name: "netlist", include: ["packages/netlist/test/**/*.test.ts"] } },
      { extends: true, test: { name: "assistant", include: ["packages/assistant/test/**/*.test.ts"] } },
      { extends: true, test: { name: "runner", include: ["packages/runner/test/**/*.test.ts"] } },
      { extends: true, test: { name: "api-contract", include: ["packages/api-contract/test/**/*.test.ts"] } },
      // Each API test file starts the whole app (and, for PostgreSQL, a database): give them time.
      { extends: true, test: { name: "api", include: ["apps/api/test/**/*.test.ts"], testTimeout: 20_000 } },
      // The desktop app's plain logic (layout, editing rules, offline simulation); the UI itself is checked by hand.
      { extends: true, test: { name: "desktop", include: ["apps/desktop/test/**/*.test.ts"] } },
    ],
    coverage: {
      provider: "v8",
      // V8 measures the built JavaScript that ran; the source maps tsc writes then map it back to
      // the TypeScript files, which is what the report shows. So the filters name the built files.
      include: ["packages/*/dist/**/*.js", "apps/api/dist/**/*.js"],
      exclude: [
        "packages/database/dist/generated/**", // Prisma's generated client
        "packages/database/dist/check-schema.js", // a script: npm run db:check
        "packages/database/dist/dev-server.js", // a script: npm run db:start
        "apps/api/dist/main.js", // the process entry points: the API
        "apps/api/dist/worker.js", // and a worker (createWorker, which they call, is tested)
        "packages/runner/dist/worker.js", // runs in worker threads, which V8 coverage doesn't follow
      ],
      // A little below what the tests reach today: a change that drops coverage noticeably fails the run.
      thresholds: { statements: 92, branches: 82, functions: 95, lines: 95 },
      reporter: ["text-summary", "text", "html"],
      reportsDirectory: "coverage",
    },
  },
});
