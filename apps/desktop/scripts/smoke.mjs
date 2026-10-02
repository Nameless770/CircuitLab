// `npm run smoke:desktop`: a smoke test of the real app. It starts its own API (in memory, on a
// free port), opens the *built* desktop app (the app://circuitlab path, as users get it), clicks
// through offline and online mode, and saves a screenshot of each step in dist/smoke/.
//
// It drives the window with Playwright, which can control Electron apps. The unit tests
// (test/*.test.ts) check the logic; this checks that the screens and the pieces fit together.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { _electron } from "playwright-core";

const require = createRequire(import.meta.url);
const { AppConfig, createApp } = require("@circuitlab/api");

// path.resolve drops the trailing slash: on Windows, a path ending in "\" would escape the quote around it.
const appDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const shotsDir = path.join(appDir, "dist", "smoke");
rmSync(shotsDir, { recursive: true, force: true });
mkdirSync(shotsDir, { recursive: true });

// --- an API just for this run ---------------------------------------------------------------
const api = await createApp({ config: new AppConfig(), logLevels: ["error"] });
await api.listen(0, "127.0.0.1");
const apiUrl = `http://127.0.0.1:${api.getHttpServer().address().port}`;
console.log(`API for this run: ${apiUrl}`);

// Throwaway accounts that only exist in this run's in-memory API.
const password = `smoke test passphrase ${Date.now()}`;
const ada = { displayName: "Ada", email: `ada.${Date.now()}@example.test`, password };
const bob = { displayName: "Bob", email: `bob.${Date.now()}@example.test`, password };

// A throwaway profile: the test signs in and opens files, and none of that may show up in your app.
const profileDir = mkdtempSync(path.join(tmpdir(), "circuitlab-smoke-profile-"));
const app = await _electron.launch({
  executablePath: String(electronPath),
  args: [appDir],
  env: { ...process.env, CIRCUITLAB_API_URL: apiUrl, CIRCUITLAB_USER_DATA_DIR: profileDir },
});
const page = await app.firstWindow();
const problems = [];
page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") problems.push(`console error: ${message.text()}`);
});

let shot = 0;
async function screenshot(name) {
  shot += 1;
  await page.screenshot({ path: path.join(shotsDir, `${String(shot).padStart(2, "0")}-${name}.png`), fullPage: true });
}
const go = (hash) => page.evaluate((target) => (location.hash = target), hash);
const see = (text) => page.getByText(text, { exact: false }).first().waitFor({ timeout: 15_000 });
const lampOf = (id) => page.locator(".io-row", { has: page.locator(`.io-name[title="${id}"]`) }).locator(".lamp");
const switchOf = (id) => page.locator(".io-row", { has: page.locator(`.io-name[title="${id}"]`) }).locator(".switch");

/** Drags a wire from one pin to another in the editor. */
async function wire(fromGate, toGate, toPin) {
  const from = await page.locator(`[data-gate="${fromGate}"] .pin-hit[data-pin="out"]`).boundingBox();
  const to = await page.locator(`[data-gate="${toGate}"] .pin-hit[data-pin="in"][data-index="${toPin}"]`).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function step(name, work) {
  process.stdout.write(`- ${name} … `);
  await work();
  console.log("ok");
}

try {
  await step("home screen, server online", async () => {
    await see("Server online");
    await screenshot("home");
  });

  // ---------------------------------------------------------------------------------- offline
  await step("offline: open the half adder example and simulate it", async () => {
    await page.getByRole("button", { name: "Half adder" }).click();
    await see("Simulated on this computer.");
    await switchOf("A").click();
    await page.waitForFunction(() => document.querySelector('.io-name[title="S"]')?.parentElement?.querySelector(".lamp")?.textContent === "1");
    assert.equal(await lampOf("C").textContent(), "0");
    await switchOf("B").click();
    await page.waitForFunction(() => document.querySelector('.io-name[title="C"]')?.parentElement?.querySelector(".lamp")?.textContent === "1");
    assert.equal(await lampOf("S").textContent(), "0");
    assert.equal(await page.locator(".truth-table tbody tr").count(), 4);
    await screenshot("offline-half-adder");
  });

  await step("offline: an SR latch remembers", async () => {
    await go("#/");
    await page.getByRole("button", { name: "SR latch" }).click();
    await see("Remembers:");
    await switchOf("S").click(); // set
    await page.waitForFunction(() => document.querySelector('.io-name[title="out_q"]')?.parentElement?.querySelector(".lamp")?.textContent === "1");
    await switchOf("S").click(); // back to 0: q must stay 1
    await page.waitForFunction(() => document.querySelector(".switch")?.textContent === "0");
    await see("Remembers: q=1");
    assert.equal(await lampOf("out_q").textContent(), "1");
    await see("has no truth table");
    await screenshot("offline-latch");
  });

  const savedFile = path.join(profileDir, "drawn.net");
  await step("offline: draw a circuit and save it as a file", async () => {
    await go("#/local/new");
    await see("New offline circuit");
    for (const label of ["Input", "Input", "AND", "Output"]) await page.locator(".palette button", { hasText: new RegExp(`^${label}$`) }).click();
    await page.getByRole("button", { name: "Check" }).click();
    await see("isn't finished"); // nothing is wired yet
    assert.ok((await page.locator(".gate.problem").count()) > 0, "unwired gates are outlined");
    await wire("A", "and1", 0);
    await wire("B", "and1", 1);
    await wire("and1", "Y", 0);
    await page.getByRole("button", { name: "Check" }).click();
    await see("Looks good");
    await screenshot("offline-editor");
    // The Save dialog is the operating system's: answer it from the main process instead.
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, savedFile);
    await page.getByRole("button", { name: "Save file…" }).click();
    await see("Simulated on this computer.");
    assert.ok(existsSync(savedFile), "the file was written");
    assert.match(readFileSync(savedFile, "utf8"), /and1 = AND\(A, B\)/);
    await screenshot("offline-saved");
  });

  // ----------------------------------------------------------------------------------- online
  await step("online: create an account", async () => {
    await go("#/register");
    await page.getByLabel("Your name").fill(ada.displayName);
    await page.getByLabel("Email").fill(ada.email);
    await page.getByLabel("Password").fill(ada.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await see("You have no circuits yet");
    await see("Ada"); // in the header
  });

  let circuitHash = "";
  await step("online: add the full adder example, simulate it on the server", async () => {
    await go("#/circuits/new");
    await page.getByRole("button", { name: "Full adder" }).click();
    await see("Simulated by the server.");
    circuitHash = await page.evaluate(() => location.hash);
    await switchOf("A").click();
    await switchOf("B").click();
    await page.waitForFunction(() => document.querySelector('.io-name[title="Cout"]')?.parentElement?.querySelector(".lamp")?.textContent === "1");
    await switchOf("B").click();
    await switchOf("B").click(); // the same question as two clicks ago: the cache answers
    await see("Answered from the server's cache");
    await screenshot("online-full-adder");
  });

  await step("online: share it with another account and make it public", async () => {
    const response = await fetch(`${apiUrl}/v1/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bob) });
    assert.equal(response.status, 201);
    await page.getByLabel("Email of their account").fill(bob.email);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await see(bob.email);
    await page.getByLabel("Who can see it").selectOption("public");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.locator(".badge.public").first().waitFor();
    await see("Recent runs");
    await screenshot("online-shared");
  });

  await step("online: a background truth-table job", async () => {
    await page.getByRole("button", { name: "Compute in the background" }).click();
    await see("Done.");
    await page.getByRole("button", { name: "Download result (CSV)" }).waitFor();
    await screenshot("online-job");
  });

  await step("online: edit the drawing and save a new version", async () => {
    const versionBefore = Number(/version (\d+)/.exec(await page.locator(".meta").first().textContent())?.[1]);
    await page.getByRole("link", { name: "Edit drawing" }).click();
    await see("Edit: Full adder");
    await page.locator('.palette button[title="Inverts its input."]').click();
    await wire("Cin", "not1", 0);
    await page.locator(".palette button", { hasText: /^Output$/ }).click();
    await wire("not1", "Y", 0);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await see(`version ${versionBefore + 1}`); // every change makes a new version (making it public did too)
    await see("Simulated by the server.");
    await screenshot("online-edited");
  });

  await step("online: upload an offline file to the account", async () => {
    await go("#/local");
    await page.getByRole("button", { name: "Upload to my account" }).click();
    await see("Simulated by the server.");
    assert.notEqual(await page.evaluate(() => location.hash), circuitHash);
  });

  await step("online: the list shows both circuits", async () => {
    await go("#/circuits?scope=owned");
    await page.locator(".circuit-card").nth(1).waitFor(); // the list loads after the page appears
    assert.equal(await page.locator(".circuit-card").count(), 2);
    await screenshot("online-list");
  });

  assert.deepEqual(problems, [], "no errors in the window's console");
  console.log(`\nAll steps passed. Screenshots: ${shotsDir}`);
} catch (error) {
  await screenshot("failure").catch(() => {});
  console.error("\nFAILED:", error);
  if (problems.length > 0) console.error(problems.join("\n"));
  process.exitCode = 1;
} finally {
  await app.close();
  await api.close();
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
