// `npm run smoke:desktop`: a smoke test of the real app. It starts its own API (in memory, on a
// free port), opens the *built* desktop app (the app://circuitlab path, as users get it), clicks
// through offline and online mode, and saves a screenshot of each step in dist/smoke/.
//
// It drives the window with Playwright, which can control Electron apps. The unit tests
// (test/*.test.ts) check the logic; this checks that the screens and the pieces fit together.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
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

// --- an Ollama just for this run: it answers the way Ollama does (the assistant needs no real model to be tested)
const ollamaRequests = [];
const spec = (name, idea, inputs, outputs) => ({ idea, name, inputs, signals: [], outputs: Object.entries(outputs).map(([key, formula]) => ({ name: key, formula })) });
function ollamaAnswer(question) {
  if (question.includes("Change it like this")) {
    return spec("Inverted-carry adder", "The same circuit, with the carry turned upside down.", ["A", "B", "CIN"], { SUM: "A ^ B ^ CIN", COUT: "!(A + B + CIN >= 2)" });
  }
  if (question.includes("full adder")) return spec("Full adder", "SUM is the parity of the inputs, and COUT is 1 when at least two are 1.", ["A", "B", "CIN"], { SUM: "A ^ B ^ CIN", COUT: "A + B + CIN >= 2" });
  if (question.includes("pancakes")) return spec("Nothing", "Pancakes are not a digital circuit.", [], {});
  return spec("An AND gate", "Both inputs must be 1.", ["A", "B"], { Y: "A & B" });
}
const fakeOllama = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    ollamaRequests.push({ method: request.method, url: request.url, body });
    const send = (status, data) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(data));
    };
    if (request.url === "/api/tags") {
      return send(200, {
        models: [
          { name: "fake-model:1b", size: 1_300_000_000, details: { parameter_size: "1.2B" } },
          { name: "other-model:3b", size: 2_000_000_000, details: { parameter_size: "3B" } },
        ],
      });
    }
    if (request.url === "/api/chat") {
      const question = body.messages.at(-1).content;
      if (question.includes("slow")) return; // never answers: the test presses Cancel
      return send(200, { message: { role: "assistant", content: JSON.stringify(ollamaAnswer(question)) }, done: true });
    }
    send(404, { error: "not found" });
  });
});
await new Promise((resolve) => fakeOllama.listen(0, "127.0.0.1", resolve));
const ollamaUrl = `http://127.0.0.1:${fakeOllama.address().port}`;
console.log(`Ollama for this run: ${ollamaUrl}`);
const chatRequests = () => ollamaRequests.filter((entry) => entry.url === "/api/chat");

// Throwaway accounts that only exist in this run's in-memory API.
const password = `smoke test passphrase ${Date.now()}`;
const ada = { displayName: "Ada", email: `ada.${Date.now()}@example.test`, password };
const bob = { displayName: "Bob", email: `bob.${Date.now()}@example.test`, password };

// A throwaway profile: the test signs in and opens files, and none of that may show up in your app.
const profileDir = mkdtempSync(path.join(tmpdir(), "circuitlab-smoke-profile-"));
const savedSettings = () => JSON.parse(readFileSync(path.join(profileDir, "settings.json"), "utf8"));

// `--packaged` tests the app electron-builder made (release/win-unpacked/CircuitLab.exe, the
// same files the installer installs) instead of running Electron on this folder.
const packaged = process.argv.includes("--packaged");
const packagedExe = path.join(appDir, "release", "win-unpacked", "CircuitLab.exe");
if (packaged && !existsSync(packagedExe)) throw new Error(`${packagedExe} doesn't exist: run npm run package:desktop first.`);
console.log(`Testing ${packaged ? packagedExe : "the build in dist/"}`);

// How to start the app with a file, as Windows does when a .net file is double-clicked.
const executable = packaged ? packagedExe : String(electronPath);
const argsFor = (file) => (packaged ? [file] : [appDir, file]);
const netlist = (name) => path.join(appDir, "..", "..", "examples", "netlists", name);

// No CIRCUITLAB_API_URL: the test sets the server address through the Settings screen, as a user would.
const env = { ...process.env, CIRCUITLAB_USER_DATA_DIR: profileDir };
delete env.CIRCUITLAB_API_URL;
const app = await _electron.launch({ executablePath: executable, args: argsFor(netlist("full-adder.net")), env });
const page = await app.firstWindow();
const problems = [];
page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
// The app asks before deleting, and before replacing a circuit with unsaved changes (window.confirm): answer yes.
const questions = [];
page.on("dialog", (dialog) => {
  questions.push(dialog.message());
  void dialog.accept();
});
page.on("console", (message) => {
  // Chromium also logs every failed request ("Failed to load resource: ... 503"). Those are
  // expected here (the app checks a server that isn't running) and the app shows them itself.
  if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) problems.push(`console error: ${message.text()}`);
});

let shot = 0;
async function screenshot(name) {
  shot += 1;
  await page.screenshot({ path: path.join(shotsDir, `${String(shot).padStart(2, "0")}-${name}.png`) });
}
const go = (hash) => page.evaluate((target) => (location.hash = target), hash);
const atHash = (hash) => page.waitForFunction((target) => location.hash === target, hash);
const see = (text) => page.getByText(text, { exact: false }).first().waitFor({ timeout: 15_000 });

// ---- the workspace -----------------------------------------------------------------------------
const openCircuitIs = (name) => page.locator(".ws-name").filter({ hasText: new RegExp(`^${name}$`) }).waitFor();
const badgeIs = (text) => page.locator(".ws-title .badge").filter({ hasText: new RegExp(`^${text}$`) }).waitFor();
const toggleOf = (id) => page.getByRole("button", { name: `Input ${id}`, exact: true });
const outputIs = (id, value) => page.locator(`.out-row[data-io="${id}"] .out-bit[data-value="${value}"]`).waitFor();
const outputOf = (id) => page.locator(`.out-row[data-io="${id}"] .out-bit`).getAttribute("data-value");
const setMode = (label) => page.locator('.ws-head [aria-label="Mode"] button').filter({ hasText: label }).click();
const saveButton = (label) => page.locator(".ws-actions").getByRole("button", { name: label, exact: true });
async function moreMenu(item) {
  await page.getByRole("button", { name: "More ▾" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}
const cards = page.locator(".card-grid .ccard");
const netText = page.locator("textarea.net-text");

// ---- the assistant's panel ---------------------------------------------------------------------
const assistant = page.locator(".assistant");
const request = page.getByLabel("What circuit do you want?");
const askButton = assistant.getByRole("button", { name: "Ask", exact: true });
async function openAssistant() {
  await page.keyboard.press("Control+J");
  await assistant.waitFor();
}
async function closeAssistant() {
  await assistant.locator(".as-close").click();
  await assistant.waitFor({ state: "detached" });
}

/** Drags a wire from one pin to another in Draw mode. */
async function wire(fromGate, toGate, toPin) {
  const from = await page.locator(`[data-gate="${fromGate}"] .pin-hit[data-pin="out"]`).boundingBox();
  const to = await page.locator(`[data-gate="${toGate}"] .pin-hit[data-pin="in"][data-index="${toPin}"]`).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
}
const addGate = (label) => page.locator(".gate-palette .gate-button").filter({ hasText: new RegExp(`^${label}$`) }).click();

async function step(name, work) {
  process.stdout.write(`- ${name} … `);
  await work();
  console.log("ok");
}

try {
  await step("opens the .net file it was started with", async () => {
    await openCircuitIs("Full adder");
    await badgeIs("File");
    await see("Simulated on this computer.");
    await screenshot("startup-file");
  });

  await step("settings: point online mode at this run's API", async () => {
    await go("#/settings");
    // The browser itself refuses things that aren't URLs at all (the field is type="url");
    // an ftp:// address passes that, and our own check must catch it.
    await page.getByLabel("Server address").fill("ftp://example.com");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await see("must start with http:// or https://");
    await page.getByLabel("Server address").fill(`${apiUrl}/`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await see(`Server online at ${apiUrl} `); // saved without the trailing slash
    assert.equal(savedSettings().apiUrl, apiUrl);
    await screenshot("settings");
  });

  await step("settings: point the assistant at this run's Ollama, and choose a model", async () => {
    await page.getByLabel("Ollama address").fill(ollamaUrl + "/");
    await page.getByRole("button", { name: "Save address" }).click();
    await see(`Ollama answers at ${ollamaUrl}, on this computer. It has 2 models.`);
    await page.getByLabel("Model").selectOption("other-model:3b");
    await see("The assistant uses other-model:3b.");
    const saved = savedSettings();
    assert.equal(saved.assistantUrl, ollamaUrl); // saved without the trailing slash
    assert.equal(saved.assistantModel, "other-model:3b");
    assert.equal(saved.apiUrl, apiUrl, "saving the assistant's settings kept the server address");
    await page.locator(".sidebar", { hasText: "other-model:3b" }).waitFor(); // the sidebar's assistant card
  });

  await step("home screen, and the light theme (saved for the next start)", async () => {
    await go("#/");
    await page.locator(".sidebar").getByText("Server online").waitFor();
    await screenshot("home");
    await page.locator(".tb-theme").click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    await page.waitForFunction(() => document.querySelector(".hero svg") !== null);
    await screenshot("home-light");
    // The main process keeps it too, to paint the window and its title bar before the page loads.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(savedSettings().theme, "light");
    await page.locator(".tb-theme").click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  });

  // ---------------------------------------------------------------------------------- offline
  await step("offline: open the half adder example and simulate it", async () => {
    await page.locator(".examples .ccard", { hasText: "Half adder" }).click();
    await openCircuitIs("Half adder");
    await badgeIs("Not saved");
    await see("Simulated on this computer.");
    await toggleOf("A").click();
    await outputIs("S", "1");
    assert.equal(await outputOf("C"), "0");
    await page.keyboard.press("2"); // the keys 1 to 9 flip the inputs
    await outputIs("C", "1");
    assert.equal(await outputOf("S"), "0");
    assert.equal(await page.locator("table.tt tbody tr").count(), 4);
    assert.equal(await page.locator("table.tt tbody tr.current").getAttribute("data-bits"), "11");
    await screenshot("offline-half-adder");
    // A row of the truth table sets the inputs to it.
    await page.locator('table.tt tbody tr[data-bits="00"]').click();
    await outputIs("C", "0");
    assert.equal(await toggleOf("A").getAttribute("aria-pressed"), "false");
  });

  await step("offline: save the example in the library", async () => {
    await saveButton("Save to library").click();
    await see("Saved “Half adder” in your library.");
    await badgeIs("In your library");
    await screenshot("offline-in-library");
  });

  await step("offline: an SR latch remembers", async () => {
    await go("#/");
    await page.locator(".examples .ccard", { hasText: "SR latch" }).click();
    await openCircuitIs("SR latch");
    await see("Remembers:");
    await toggleOf("S").click(); // set
    await outputIs("out_q", "1");
    await toggleOf("S").click(); // back to 0: q must stay 1
    await page.locator('.toggle[aria-label="Input S"][aria-pressed="false"]').waitFor();
    await page.locator(".seq-box", { hasText: "q=1" }).waitFor();
    await outputIs("out_q", "1");
    await see("has no truth table");
    await screenshot("offline-latch");
  });

  const savedFile = path.join(profileDir, "drawn.net");
  await step("offline: draw a circuit, check it, save it, export a copy", async () => {
    await page.keyboard.press("Control+N");
    await openCircuitIs("Untitled circuit");
    await badgeIs("Not saved");
    await see("An empty canvas");
    for (const label of ["Input", "Input", "AND", "Output"]) await addGate(label);
    assert.equal(await page.getByText("An empty canvas").isVisible(), false, "the hint goes once there are gates");
    await page.locator(".inspector").getByRole("button", { name: "Check", exact: true }).click();
    await page.locator(".inspector .alert.error").waitFor(); // nothing is wired yet
    assert.ok((await page.locator(".gate.problem").count()) > 0, "unwired gates are outlined");
    await wire("A", "and1", 0);
    await wire("B", "and1", 1);
    await wire("and1", "Y", 0);
    await page.locator(".inspector").getByRole("button", { name: "Check", exact: true }).click();
    await see("Looks right:");
    await page.getByLabel("Circuit name").fill("My AND gate");
    await page.getByLabel("Description").fill("Two inputs, one output.");
    await screenshot("offline-draw");
    await saveButton("Save to library").click();
    await see("Saved “My AND gate” in your library.");
    await badgeIs("In your library");
    await setMode("Simulate");
    await see("Simulated on this computer.");
    // A file only when asked: the Save dialog is the operating system's, so answer it from the main process.
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, savedFile);
    await page.getByRole("button", { name: "Export .net" }).click();
    await see("Exported to");
    assert.ok(existsSync(savedFile), "the file was written");
    assert.match(readFileSync(savedFile, "utf8"), /and1 = AND\(A, B\)/);
  });

  await step("offline: the library lists, searches, opens and deletes", async () => {
    await go("#/library");
    await cards.nth(1).waitFor();
    assert.equal(await cards.count(), 2);
    assert.equal(await cards.first().locator(".ccard-title > span").first().textContent(), "My AND gate"); // newest first
    await screenshot("library");
    await page.getByLabel("Search by name").fill("half");
    await page.waitForFunction(() => document.querySelectorAll(".card-grid .ccard").length === 1);
    await cards.filter({ hasText: "Half adder" }).click();
    await openCircuitIs("Half adder");
    await badgeIs("In your library");
    // The command palette goes anywhere.
    await page.keyboard.press("Control+K");
    await page.getByLabel("Command or circuit name").fill("Library");
    await page.keyboard.press("Enter");
    await atHash("#/library");
    // Delete the other one, from the workspace's More menu.
    await cards.filter({ hasText: "My AND gate" }).click();
    await openCircuitIs("My AND gate");
    await moreMenu("Delete from the library");
    await atHash("#/library");
    await page.waitForFunction(() => document.querySelectorAll(".card-grid .ccard").length === 1);
    // The home screen lists the library too, one click away.
    await go("#/");
    await page.locator(".row-link", { hasText: "Half adder" }).waitFor();
    // On disk: one JSON file per saved circuit, in the profile's library folder.
    assert.equal(readdirSync(path.join(profileDir, "library")).filter((name) => name.endsWith(".json")).length, 1);
  });

  // ------------------------------------------------------------------------------ the assistant
  await step("assistant: draft a circuit, look at it, use it, fix the netlist, save it", async () => {
    await openAssistant();
    await see("Using other-model:3b in Ollama, on this computer");
    await request.fill("a full adder");
    await askButton.click();
    await see("SUM is the parity of the inputs");
    await see("Made by other-model:3b.");
    assert.equal(await assistant.locator(".as-answer table.tt tbody tr").count(), 8, "the whole truth table of 3 inputs");
    assert.match(await assistant.locator(".as-answer .netlist-text").textContent(), /xor1 = XOR\(A, B, CIN\)/);
    await screenshot("assistant-draft");
    // What reached Ollama: the chosen model, the schema, the recipes for this request, and the request.
    const asked = chatRequests().at(-1).body;
    assert.equal(asked.model, "other-model:3b");
    assert.equal(asked.stream, false);
    assert.equal(asked.options.num_ctx, 8192);
    assert.ok(asked.format && asked.format.properties.outputs, "the answer is asked for in the schema's shape");
    assert.match(asked.messages[0].content, /Request: a full adder with inputs A, B and CIN/);
    assert.equal(asked.messages.at(-1).content, "Design this circuit: a full adder");
    // Nothing is in the workspace until "Use this".
    await assistant.getByRole("button", { name: "Use this in the editor" }).click();
    await see("The workspace now holds the assistant's circuit");
    await openCircuitIs("Full adder");
    await badgeIs("Not saved");
    await page.keyboard.press("Control+3");
    assert.match(await netText.inputValue(), /xor1 = XOR\(A, B, CIN\)/);
    // A mistake in the text is found, listed, and shown on its line.
    const good = await netText.inputValue();
    await netText.fill(`${good}\nbad = AND(nope, A)\n`);
    await page.locator(".net-bar").getByRole("button", { name: "Check", exact: true }).click();
    await page.locator(".issues-box .issue", { hasText: "nope" }).waitFor();
    assert.ok((await page.locator(".net-gutter .bad").count()) > 0, "the line is marked");
    await screenshot("netlist-mistake");
    await netText.fill(good);
    await page.locator(".net-bar").getByRole("button", { name: "Check", exact: true }).click();
    await see("Looks good: ");
    await saveButton("Save to library").click();
    await see("Saved “Full adder” in your library.");
    await badgeIs("In your library");
  });

  await step("assistant: beside the drawing, change the open circuit, undo, then keep it", async () => {
    await page.keyboard.press("Control+2"); // drawing
    await page.locator(".canvas.drawing").waitFor();
    await moreMenu("Ask the assistant to change it");
    // In the workspace the panel takes the right-hand column, instead of covering the circuit.
    await page.locator(".inspector .assistant.docked").waitFor();
    assert.equal(await page.getByRole("button", { name: "Assistant", exact: true }).getAttribute("aria-pressed"), "true");
    assert.ok(await page.locator(".canvas.drawing").isVisible(), "the drawing stays in view");
    assert.equal(await assistant.getByRole("button", { name: "Change the open circuit" }).getAttribute("aria-pressed"), "true");
    await request.fill("invert the carry output");
    await askButton.click();
    await see("The same circuit, with the carry turned upside down.");
    // The model was shown the circuit as it is, in its own format.
    const question = chatRequests().at(-1).body.messages.at(-1).content;
    assert.match(question, /^Here is the current circuit:\n\{/);
    assert.ok(question.includes('"formula":"A ^ B ^ CIN"'), "the open circuit's formulas");
    assert.ok(question.endsWith("Change it like this: invert the carry output\nAnswer with the complete new circuit."));
    await screenshot("assistant-docked");
    await assistant.getByRole("button", { name: "Use this in the open circuit" }).click();
    // Still drawing, with the panel still beside the drawing, which now has the change.
    await page.locator('.canvas.drawing [data-type="NOT"]').first().waitFor();
    await page.locator(".inspector .assistant.docked").waitFor();
    await badgeIs("In your library"); // still where it's saved, with unsaved changes
    await assistant.locator(".alert.ok", { hasText: "The assistant's change is in the open circuit" }).waitFor();
    await assistant.getByRole("button", { name: "Undo", exact: true }).click();
    await page.locator('[data-type="NOT"]').first().waitFor({ state: "detached" });
    // The column remembers its tab: away and back, the assistant is still there.
    await go("#/");
    await page.locator(".home").waitFor();
    await go("#/workspace");
    await page.locator(".inspector .assistant.docked").waitFor();
    // And once more, this time keeping it.
    await askButton.click();
    await see("The same circuit, with the carry turned upside down.");
    await assistant.getByRole("button", { name: "Use this in the open circuit" }).click();
    await page.locator('.canvas.drawing [data-type="NOT"]').first().waitFor();
    // After an edit of your own, Undo would throw that away too: it refuses, and keeps both.
    await addGate("BUF");
    await assistant.getByRole("button", { name: "Undo", exact: true }).click();
    await assistant.getByText("Not undone: the circuit has changed since").waitFor();
    assert.ok((await page.locator('[data-type="NOT"]').count()) > 0, "the assistant's change is still there");
    await page.keyboard.press("Delete"); // the new gate is still selected
    await page.locator('[data-type="BUF"]').first().waitFor({ state: "detached" });
    await saveButton("Save to library").click();
    await openCircuitIs("Inverted-carry adder");
    await screenshot("assistant-changed");
    // Back to the details of the drawing.
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await page.locator(".inspector .assistant").waitFor({ state: "detached" });
    await page.locator(".inspector").getByRole("button", { name: "Check", exact: true }).waitFor();
    // Leave the library as the steps after this one expect it.
    await moreMenu("Delete from the library");
    await atHash("#/library");
  });

  await step("assistant: Cancel stops a slow answer, and a request that isn't a circuit is declined", async () => {
    await openAssistant();
    await see("Using other-model:3b");
    const cancel = assistant.getByRole("button", { name: "Cancel", exact: true });
    assert.equal(await cancel.isVisible(), false, "Cancel only shows while a question is being worked on");
    await request.fill("a slow circuit");
    await askButton.click();
    await see("Asking other-model:3b");
    await cancel.click();
    await see("Stopped.");
    await cancel.waitFor({ state: "hidden" });
    assert.ok(await askButton.isEnabled(), "Ask works again");
    await request.fill("pancakes");
    await askButton.click();
    await see("The assistant can't make that.");
    await see("Pancakes are not a digital circuit.");
    await request.fill("   ");
    await askButton.click();
    await see("Write what circuit you want first.");
    await screenshot("assistant-declined");
    await closeAssistant();
  });

  // ----------------------------------------------------------------------------------- online
  await step("online: create an account", async () => {
    await page.locator(".sidebar").getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator(".modal").getByRole("button", { name: "Create an account" }).click();
    await page.getByLabel("Your name").fill(ada.displayName);
    await page.getByLabel("Email").fill(ada.email);
    await page.getByLabel("Password").fill(ada.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await see("Signed in as Ada.");
    await page.locator(".sidebar", { hasText: ada.email }).waitFor();
    await go("#/circuits?scope=owned");
    await see("You have no circuits yet");
  });

  await step("online: a new circuit from the assistant goes in the account", async () => {
    await page.locator(".page-head").getByRole("button", { name: "New circuit" }).click();
    await openCircuitIs("Untitled circuit");
    await see("Save puts it in your account");
    await openAssistant();
    await page.locator(".inspector .assistant.docked").waitFor(); // beside the empty drawing
    assert.ok(await assistant.getByRole("button", { name: "Change the open circuit" }).isDisabled(), "an empty circuit has nothing to change");
    await request.fill("a full adder");
    await askButton.click();
    await see("SUM is the parity of the inputs");
    await assistant.getByRole("button", { name: "Use this in the editor" }).click();
    await openCircuitIs("Full adder");
    await page.locator('.canvas.drawing [data-gate="xor1"]').waitFor(); // drawn, and still in Draw mode
    await saveButton("Save").click();
    await see("Saved “Full adder” in your account.");
    await badgeIs("Private");
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await setMode("Simulate");
    await see("Simulated by the server.");
    await screenshot("assistant-online");
    // Leave the account as the steps after this one expect it: no circuits yet.
    await moreMenu("Delete from the server");
    await atHash("#/circuits?scope=owned");
    await see("You have no circuits yet");
  });

  await step("online: upload the full adder example, simulate it on the server", async () => {
    await go("#/");
    await page.locator(".examples .ccard", { hasText: "Full adder" }).click();
    await openCircuitIs("Full adder");
    await moreMenu("Upload to my account");
    await see("Uploaded: it's in your account now.");
    await badgeIs("Private");
    await see("Simulated by the server.");
    await toggleOf("A").click();
    await toggleOf("B").click();
    await outputIs("Cout", "1");
    await toggleOf("B").click(); // A=1 B=0 again: the server has answered that before
    await toggleOf("B").click();
    await see("Answered from the server's cache");
    await screenshot("online-full-adder");
  });

  await step("online: share it with another account and make it public", async () => {
    const response = await fetch(`${apiUrl}/v1/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bob) });
    assert.equal(response.status, 201);
    await page.locator("details.more > summary", { hasText: "Sharing" }).click();
    await page.getByLabel("Email of their account").fill(bob.email);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await see(bob.email);
    await page.locator('[aria-label="Who can see it"] button', { hasText: "Public" }).click();
    await see("Public: anyone can see it now.");
    await badgeIs("Public");
    await page.locator("details.more > summary", { hasText: "Recent runs" }).click();
    await see("Simulation (combinational)");
    await screenshot("online-shared");
  });

  await step("online: a background truth-table job", async () => {
    await page.locator("details.more > summary", { hasText: "Big tables" }).click();
    await page.getByRole("button", { name: "Compute in the background" }).click();
    await see("Done.");
    await page.getByRole("button", { name: "Download result (CSV)" }).waitFor();
    await page.locator(".ins-body").evaluate((element) => (element.scrollTop = element.scrollHeight));
    await screenshot("online-job");
  });

  await step("online: edit the drawing and save a new version", async () => {
    const versionBefore = Number(/version (\d+)/.exec(await page.locator(".ws-meta").textContent())?.[1]);
    await setMode("Draw");
    await page.locator('.gate-palette .gate-button[title="Inverts its input."]').click();
    await wire("Cin", "not1", 0);
    await addGate("Output");
    await wire("not1", "Y", 0);
    await saveButton("Save").click();
    await see(`Saved: version ${versionBefore + 1}.`); // every change makes a new version (making it public did too)
    await page.locator(".ws-meta", { hasText: `version ${versionBefore + 1}` }).waitFor();
    await setMode("Simulate");
    await see("Simulated by the server.");
    await screenshot("online-edited");
  });

  await step("online: save a copy of a server circuit in the library", async () => {
    await moreMenu("Save a copy to the library");
    await see("Saved a copy of “Full adder” in your library");
    await go("#/library");
    await cards.filter({ hasText: "Full adder" }).waitFor();
  });

  await step("online: upload a library circuit to the account", async () => {
    await cards.filter({ hasText: "Half adder" }).click();
    await openCircuitIs("Half adder");
    await moreMenu("Upload to my account");
    await see("Uploaded: it's in your account now.");
    await badgeIs("Private");
    await see("Simulated by the server.");
  });

  const fileCopy = path.join(profileDir, "half-adder.net");
  await step("a second launch with a file hands it to the running app; saving asks before losing comments", async () => {
    copyFileSync(netlist("half-adder.net"), fileCopy); // a copy: this step writes to it
    const second = spawn(executable, argsFor(fileCopy), { env, stdio: "ignore" });
    const [code] = await once(second, "exit"); // it finds the running app, passes the file on, and quits
    assert.equal(code, 0);
    await badgeIs("File");
    await openCircuitIs("Half adder");
    assert.equal(app.windows().length, 1, "still one window");
    await screenshot("second-instance");
    // The file has comments; a drawing has none, so saving one over it asks first.
    await setMode("Draw");
    await page.getByLabel("Circuit name").fill("Half adder, renamed");
    await saveButton("Save").click();
    await see("Saved to half-adder.net.");
    assert.match(questions.at(-1), /comments in it will be lost/);
    const written = readFileSync(fileCopy, "utf8");
    assert.match(written, /\.name "Half adder, renamed"/);
    assert.doesNotMatch(written, /#/);
  });

  await step("online: the lists show the circuits", async () => {
    await go("#/circuits?scope=owned");
    await cards.nth(1).waitFor(); // the list loads after the page appears
    assert.equal(await cards.count(), 2);
    await screenshot("online-list");
    await go("#/circuits?scope=public");
    await cards.filter({ hasText: "Full adder" }).waitFor();
    assert.equal(await cards.count(), 1);
  });

  await step("assistant: Ollama not running is explained, and the default address comes back", async () => {
    await go("#/settings");
    await page.getByLabel("Ollama address").fill("http://127.0.0.1:1");
    await page.getByRole("button", { name: "Save address" }).click();
    await see("Can't reach Ollama at http://127.0.0.1:1");
    await openAssistant();
    await assistant.getByText("Can't reach Ollama at http://127.0.0.1:1").first().waitFor(); // the panel's own line
    await assistant.getByRole("button", { name: "A new circuit" }).click();
    await request.fill("a full adder");
    await askButton.click();
    await assistant.locator(".alert.error", { hasText: "Can't reach Ollama" }).waitFor();
    await screenshot("assistant-no-ollama");
    await closeAssistant();
    await page.getByRole("button", { name: "Use Ollama's default" }).click();
    await see("Saved. The assistant now looks for Ollama at http://127.0.0.1:11434.");
    const saved = savedSettings();
    assert.equal(saved.assistantUrl, undefined, "the default isn't saved as an address");
    assert.equal(saved.assistantModel, "other-model:3b", "the chosen model is kept");
    assert.equal(saved.apiUrl, apiUrl, "the server address is kept");
  });

  assert.deepEqual(problems, [], "no errors in the window's console");
  console.log(`\nAll steps passed. Screenshots: ${shotsDir}`);
} catch (error) {
  await screenshot("failure").catch(() => {});
  console.error("\nFAILED:", error);
  if (problems.length > 0) console.error(problems.join("\n"));
  process.exitCode = 1;
} finally {
  // A failed step can leave unsaved changes, and then the window asks before closing (a dialog
  // no one answers here): give it a while, then stop the app.
  const closed = await Promise.race([app.close().then(() => true), new Promise((resolve) => setTimeout(resolve, 15_000, false))]);
  if (!closed) app.process().kill();
  fakeOllama.closeAllConnections();
  fakeOllama.close();
  await api.close();
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
