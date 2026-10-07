import { defineConfig } from "@playwright/test";
import type { E2EOptions } from "./fixtures";

/**
 * The desktop app's end-to-end tests: `npm run e2e:desktop` (from the repo root) builds everything
 * and runs them against the build in dist/; `npm run e2e:packaged -w @circuitlab/desktop` runs them
 * against the files the installer installs. See docs/testing.md.
 */
export default defineConfig<E2EOptions>({
  testDir: ".",
  outputDir: "../dist/e2e/results",
  // Each test starts the app and clicks through a whole task: give it time.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Two copies of the app at a time (each with its own profile); the tests of one file run in order.
  workers: 2,
  forbidOnly: true,
  reporter: [["list"], ["html", { outputFolder: "../dist/e2e/report", open: "never" }]],
  projects: [
    { name: "app", use: { packaged: false } },
    { name: "packaged", use: { packaged: true } },
  ],
});
