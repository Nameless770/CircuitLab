import { once } from "node:events";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppConfig, createApp } from "@circuitlab/api";
import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from "@playwright/test";
import { CircuitLab } from "./circuitlab";

/**
 * What every end-to-end test gets: the real app (the build in dist/, or the installed files), a
 * profile of its own that is thrown away afterwards, and servers just for the tests:
 * - an API in memory, as `npm run start:api` runs it without a database;
 * - a fake Ollama, which answers like Ollama does with canned circuits (the assistant needs no real
 *   model to be tested; see docs/assistant.md for the real model's numbers).
 *
 * Each test starts the app afresh, so tests don't depend on each other and can run in any order.
 * The servers are shared by the tests of one worker; tests that need an account make their own.
 */

// path.resolve drops the trailing slash: on Windows, a path ending in "\" would escape the quote around it.
export const APP_DIR = path.resolve(__dirname, "..");
const PACKAGED_EXE = path.join(APP_DIR, "release", "win-unpacked", "CircuitLab.exe");
const EXAMPLES_DIR = path.join(APP_DIR, "..", "..", "examples", "netlists");
// In Node, the electron package's main export is the path of the Electron program.
const ELECTRON_PATH: string = require("electron");

export interface E2EOptions {
  /** Test the files the installer installs (release/win-unpacked) instead of the build in dist/. */
  packaged: boolean;
  /**
   * Start with this run's API and Ollama saved in Settings, and a model chosen, as if a person had
   * typed them there. Settings' own tests start without.
   */
  saveServers: boolean;
  /** More of settings.json, on top of the above. */
  settings: Record<string, unknown>;
  /** An example netlist (a file in examples/netlists) to start the app with, as a double-click does. */
  startupFile: string | null;
}

/** The fake Ollama's answers are picked by what the question says. */
export interface ChatRequest {
  readonly model: string;
  readonly stream: boolean;
  readonly options: { readonly num_ctx: number };
  readonly format?: { readonly properties?: Record<string, unknown> };
  readonly messages: readonly { readonly role: string; readonly content: string }[];
}

export interface FakeOllama {
  readonly url: string;
  /** The models it says it has. */
  readonly models: readonly string[];
  /** Every chat request it got, oldest first. */
  readonly chats: ChatRequest[];
}

/** How the app is started, for tests that start a second copy (as a second double-click does). */
export interface Launch {
  readonly executable: string;
  args(file?: string): string[];
  readonly env: Record<string, string>;
}

interface TestFixtures {
  profileDir: string;
  launch: Launch;
  electronApp: ElectronApplication;
  page: Page;
  /** The messages of the questions the window asked (window.confirm), oldest first; all answered yes. */
  dialogs: string[];
  ui: CircuitLab;
}

interface WorkerFixtures {
  api: { readonly url: string };
  ollama: FakeOllama;
}

export const test = base.extend<TestFixtures & E2EOptions, WorkerFixtures>({
  packaged: [false, { option: true }],
  saveServers: [true, { option: true }],
  settings: [{}, { option: true }],
  startupFile: [null, { option: true }],

  api: [
    async ({}, use) => {
      // Given a config, the API never reads environment variables: always in memory, never a database.
      const app = await createApp({ config: new AppConfig(), logLevels: ["error"] });
      await app.listen(0, "127.0.0.1");
      const { port } = app.getHttpServer().address() as AddressInfo;
      await use({ url: `http://127.0.0.1:${port}` });
      await app.close();
    },
    { scope: "worker" },
  ],

  ollama: [
    async ({}, use) => {
      const models = ["fake-model:1b", "other-model:3b"];
      const chats: ChatRequest[] = [];
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const send = (status: number, data: unknown): void => {
            response.writeHead(status, { "Content-Type": "application/json" });
            response.end(JSON.stringify(data));
          };
          if (request.url === "/api/tags") {
            send(200, { models: models.map((name, index) => ({ name, size: (index + 1) * 1_000_000_000, details: { parameter_size: `${index + 1}B` } })) });
            return;
          }
          if (request.url === "/api/chat") {
            const chat = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatRequest;
            chats.push(chat);
            const question = chat.messages.at(-1)?.content ?? "";
            if (question.includes("slow")) return; // never answers: the test presses Cancel
            send(200, { message: { role: "assistant", content: JSON.stringify(cannedAnswer(question)) }, done: true });
            return;
          }
          send(404, { error: "not found" });
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const { port } = server.address() as AddressInfo;
      await use({ url: `http://127.0.0.1:${port}`, models, chats });
      server.closeAllConnections();
      server.close();
    },
    { scope: "worker" },
  ],

  profileDir: async ({ api, ollama, saveServers, settings }, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), "circuitlab-e2e-"));
    const servers = saveServers ? { apiUrl: api.url, assistantUrl: ollama.url, assistantModel: "other-model:3b" } : {};
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ ...servers, ...settings }));
    await use(dir);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  },

  launch: async ({ packaged, profileDir }, use) => {
    if (packaged && !existsSync(PACKAGED_EXE)) throw new Error(`${PACKAGED_EXE} doesn't exist: run npm run package:desktop first.`);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
    // The addresses come from the profile's settings.json, as a person's do, never from these.
    delete env["CIRCUITLAB_API_URL"];
    delete env["CIRCUITLAB_OLLAMA_URL"];
    env["CIRCUITLAB_USER_DATA_DIR"] = profileDir;
    await use({
      executable: packaged ? PACKAGED_EXE : ELECTRON_PATH,
      // During development Electron is given the app's folder first; the installed program isn't.
      args: (file) => [...(packaged ? [] : [APP_DIR]), ...(file === undefined ? [] : [file])],
      env,
    });
  },

  electronApp: async ({ launch, profileDir, startupFile }, use, testInfo) => {
    const file = startupFile === null ? undefined : copyExample(profileDir, startupFile);
    const app = await electron.launch({ executablePath: launch.executable, args: launch.args(file), env: launch.env });
    // A trace of everything the test did (screens, clicks, the page's state), kept when it fails:
    // open it from the HTML report, or with `npx playwright show-trace <file>`.
    await app.context().tracing.start({ screenshots: true, snapshots: true, title: testInfo.title });
    await use(app);
    if (testInfo.status !== testInfo.expectedStatus) {
      const trace = testInfo.outputPath("trace.zip");
      await app.context().tracing.stop({ path: trace });
      testInfo.attachments.push({ name: "trace", path: trace, contentType: "application/zip" });
    } else {
      await app.context().tracing.stop();
    }
    await quit(app);
  },

  dialogs: async ({}, use) => {
    await use([]);
  },

  page: async ({ electronApp, dialogs }, use, testInfo) => {
    const page = await electronApp.firstWindow();
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
    page.on("console", (message) => {
      // Chromium also logs every failed request ("Failed to load resource: ... 503"); the app
      // shows those itself, and some tests cause them on purpose.
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) problems.push(`console error: ${message.text()}`);
    });
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.accept();
    });
    await page.locator("#view > .page").first().waitFor();
    await use(page);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach("screen when it failed", { body: await page.screenshot(), contentType: "image/png" }).catch(() => {});
    }
    expect(problems, "errors in the window's console").toEqual([]);
  },

  ui: async ({ page, electronApp, api }, use, testInfo) => {
    await use(new CircuitLab(page, electronApp, api.url, testInfo));
  },
});

export { expect };

/**
 * Quits the app at once. Closing it normally would ask about unsaved changes (a native dialog
 * that no one answers here), and a test may well end with some.
 */
async function quit(app: ElectronApplication): Promise<void> {
  const process = app.process();
  if (process.exitCode !== null) return;
  const exited = once(process, "exit");
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}); // the answer never comes: it has quit
  const timeout = new Promise<"timeout">((resolve) => setTimeout(resolve, 10_000, "timeout"));
  if ((await Promise.race([exited, timeout])) === "timeout") process.kill();
}

/** A copy of an example netlist in the test's profile folder, so a test may change it. */
export function copyExample(profileDir: string, name: string): string {
  const copy = path.join(profileDir, name);
  if (!existsSync(copy)) copyFileSync(path.join(EXAMPLES_DIR, name), copy);
  return copy;
}

/** settings.json as the app last saved it. */
export function savedSettings(profileDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(profileDir, "settings.json"), "utf8")) as Record<string, unknown>;
}

// ---- the fake Ollama's canned answers ---------------------------------------------------------------

/** An answer in the assistant's own format: the circuit as named formulas (see packages/assistant). */
function circuitSpec(name: string, idea: string, inputs: string[], outputs: Record<string, string>): unknown {
  return { idea, name, inputs, signals: [], outputs: Object.entries(outputs).map(([output, formula]) => ({ name: output, formula })) };
}

function cannedAnswer(question: string): unknown {
  if (question.includes("Change it like this")) {
    return circuitSpec("Inverted-carry adder", "The same circuit, with the carry turned upside down.", ["A", "B", "CIN"], { SUM: "A ^ B ^ CIN", COUT: "!(A + B + CIN >= 2)" });
  }
  if (question.includes("full adder")) {
    return circuitSpec("Full adder", "SUM is the parity of the inputs, and COUT is 1 when at least two are 1.", ["A", "B", "CIN"], { SUM: "A ^ B ^ CIN", COUT: "A + B + CIN >= 2" });
  }
  // A model that can't make what is asked says so with no outputs.
  if (question.includes("pancakes")) return circuitSpec("Nothing", "Pancakes are not a digital circuit.", [], {});
  return circuitSpec("An AND gate", "Both inputs must be 1.", ["A", "B"], { Y: "A & B" });
}
