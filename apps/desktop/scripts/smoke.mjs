// `npm run smoke:desktop`: a smoke test of the real app. It starts its own API (in memory, on a
// free port), opens the *built* desktop app (the app://circuitlab path, as users get it), clicks
// through offline and online mode, and saves a screenshot of each step in dist/smoke/.
//
// It drives the window with Playwright, which can control Electron apps. The unit tests
// (test/*.test.ts) check the logic; this checks that the screens and the pieces fit together.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
// The app asks before deleting (window.confirm): answer yes.
page.on("dialog", (dialog) => void dialog.accept());
page.on("console", (message) => {
  // Chromium also logs every failed request ("Failed to load resource: ... 503"). Those are
  // expected here (the app checks a server that isn't running) and the app shows them itself.
  if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) problems.push(`console error: ${message.text()}`);
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
  await step("opens the .net file it was started with", async () => {
    await page.locator("h1", { hasText: "Full adder" }).waitFor();
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
    const saved = JSON.parse(readFileSync(path.join(profileDir, "settings.json"), "utf8"));
    assert.equal(saved.apiUrl, apiUrl);
    await screenshot("settings");
  });

  await step("home screen, server online", async () => {
    await go("#/");
    await see("Server online");
    await screenshot("home");
  });

  await step("settings: point the assistant at this run's Ollama, and choose a model", async () => {
    await go("#/settings");
    await page.getByLabel("Ollama address").fill(ollamaUrl + "/");
    await page.getByRole("button", { name: "Save address" }).click();
    await see(`Ollama answers at ${ollamaUrl}, on this computer. It has 2 models.`);
    await page.getByLabel("Model").selectOption("other-model:3b");
    await see("The assistant uses other-model:3b.");
    const saved = JSON.parse(readFileSync(path.join(profileDir, "settings.json"), "utf8"));
    assert.equal(saved.assistantUrl, ollamaUrl); // saved without the trailing slash
    assert.equal(saved.assistantModel, "other-model:3b");
    assert.equal(saved.apiUrl, apiUrl, "saving the assistant's settings kept the server address");
    await screenshot("settings-assistant");
    await go("#/"); // the next step starts from the home screen
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

  await step("offline: save the example in the library", async () => {
    await page.getByRole("button", { name: "Save to library" }).click();
    await see("In your library");
    await screenshot("offline-in-library");
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
  await step("offline: draw a circuit, save it (no file dialog), export a copy", async () => {
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
    await page.getByLabel("Name").first().fill("My AND gate");
    await page.getByLabel("Description").fill("Two inputs, one output.");
    await screenshot("offline-editor");
    // Save goes straight into the library and on to the circuit's page, ready to try.
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await see("Simulated on this computer.");
    await see("In your library");
    await see("Two inputs, one output.");
    await screenshot("offline-saved");
    // A file only when asked: the Save dialog is the operating system's, so answer it from the main process.
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, savedFile);
    await page.getByRole("button", { name: "Export as file…" }).click();
    await see("Exported to");
    assert.ok(existsSync(savedFile), "the file was written");
    assert.match(readFileSync(savedFile, "utf8"), /and1 = AND\(A, B\)/);
  });

  await step("offline: the library lists, searches, opens and deletes", async () => {
    await go("#/library");
    await page.locator(".circuit-card").nth(1).waitFor();
    assert.equal(await page.locator(".circuit-card").count(), 2);
    assert.equal(await page.locator(".circuit-card h3").first().textContent(), "My AND gate"); // newest first
    await screenshot("library");
    await page.getByLabel("Search by name").fill("half");
    assert.equal(await page.locator(".circuit-card").count(), 1);
    await page.locator(".circuit-card", { hasText: "Half adder" }).click();
    await page.locator("h1", { hasText: "Half adder" }).waitFor();
    await see("In your library");
    // Delete the other one, from its own page.
    await go("#/library");
    await page.locator(".circuit-card", { hasText: "My AND gate" }).click();
    await page.locator("h1", { hasText: "My AND gate" }).waitFor();
    await page.getByRole("button", { name: "Delete" }).click();
    await page.waitForFunction(() => location.hash === "#/library");
    await page.locator(".circuit-card").first().waitFor();
    assert.equal(await page.locator(".circuit-card").count(), 1);
    // The home screen lists the library too, one click away.
    await go("#/");
    await page.locator(".recent a", { hasText: "Half adder" }).waitFor();
    // On disk: one JSON file per saved circuit, in the profile's library folder.
    assert.deepEqual(readdirSync(path.join(profileDir, "library")).filter((name) => name.endsWith(".json")).length, 1);
  });

  // ------------------------------------------------------------------------------ the assistant
  await step("assistant: draft a circuit, look at it, use it in the editor and save it", async () => {
    await go("#/local/new/netlist?ask=1");
    await see("Ask the assistant");
    await see("Using other-model:3b in Ollama, on this computer");
    await page.getByLabel("What circuit do you want?").fill("a full adder");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await see("SUM is the parity of the inputs");
    await see("Made by other-model:3b.");
    assert.equal(await page.locator(".draft .truth-table tbody tr").count(), 8, "the whole truth table of 3 inputs");
    assert.match(await page.locator(".draft .netlist-text").textContent(), /xor1 = XOR\(A, B, CIN\)/);
    await screenshot("assistant-draft");
    // What reached Ollama: the chosen model, the schema, the recipes for this request, and the request.
    const asked = chatRequests().at(-1).body;
    assert.equal(asked.model, "other-model:3b");
    assert.equal(asked.stream, false);
    assert.equal(asked.options.num_ctx, 8192);
    assert.ok(asked.format && asked.format.properties.outputs, "the answer is asked for in the schema's shape");
    assert.match(asked.messages[0].content, /Request: a full adder with inputs A, B and CIN/);
    assert.equal(asked.messages.at(-1).content, "Design this circuit: a full adder");
    // Nothing is in the editor until "Use this".
    assert.doesNotMatch(await page.locator("textarea.code").inputValue(), /XOR/);
    await page.getByRole("button", { name: "Use this in the editor" }).click();
    await see("The editor now holds the assistant's circuit");
    assert.match(await page.locator("textarea.code").inputValue(), /xor1 = XOR\(A, B, CIN\)/);
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await see("Looks good: ");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator("h1", { hasText: "Full adder" }).waitFor();
    await see("In your library");
    await screenshot("assistant-saved");
  });

  await step("assistant: change the circuit that is open, and undo", async () => {
    await go("#/local/netlist");
    await see("Edit netlist: Full adder");
    assert.ok(await page.getByRole("radio", { name: /Change the netlist below/ }).isChecked(), "an editor with a circuit in it changes it");
    await page.getByLabel("What circuit do you want?").fill("invert the carry output");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await see("The same circuit, with the carry turned upside down.");
    // The model was shown the circuit as it is, in its own format.
    const question = chatRequests().at(-1).body.messages.at(-1).content;
    assert.match(question, /^Here is the current circuit:\n\{/);
    assert.ok(question.includes('"formula":"A ^ B ^ CIN"'), "the open circuit's formulas");
    assert.ok(question.endsWith("Change it like this: invert the carry output\nAnswer with the complete new circuit."));
    await page.getByRole("button", { name: "Use this in the editor" }).click();
    assert.match(await page.locator("textarea.code").inputValue(), /NOT\(/);
    await page.getByRole("button", { name: "Undo" }).click();
    assert.doesNotMatch(await page.locator("textarea.code").inputValue(), /NOT\(/, "Undo brings back what was there");
    // And once more, this time keeping it.
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await see("The same circuit, with the carry turned upside down.");
    await page.getByRole("button", { name: "Use this in the editor" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator("h1", { hasText: "Inverted-carry adder" }).waitFor();
    await screenshot("assistant-changed");
    // Leave the library as the steps after this one expect it.
    await page.getByRole("button", { name: "Delete" }).click();
    await page.waitForFunction(() => location.hash === "#/library");
  });

  await step("assistant: Cancel stops a slow answer, and a request that isn't a circuit is declined", async () => {
    await go("#/local/new/netlist?ask=1");
    await see("Using other-model:3b");
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    assert.equal(await cancel.isVisible(), false, "Cancel only shows while a question is being worked on");
    await page.getByLabel("What circuit do you want?").fill("a slow circuit");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await see("Asking other-model:3b");
    await cancel.click();
    await see("Stopped.");
    await cancel.waitFor({ state: "hidden" });
    assert.ok(await page.getByRole("button", { name: "Ask", exact: true }).isEnabled(), "Ask works again");
    await page.getByLabel("What circuit do you want?").fill("pancakes");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await see("The assistant can't make that.");
    await see("Pancakes are not a digital circuit.");
    await page.getByLabel("What circuit do you want?").fill("   ");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await see("Write what circuit you want first.");
    await screenshot("assistant-declined");
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

  await step("online: the assistant is in the online netlist editor too", async () => {
    await go("#/circuits/new");
    await page.getByRole("link", { name: "Describe it" }).click();
    await see("Ask the assistant");
    await page.getByLabel("What circuit do you want?").fill("a full adder");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await see("SUM is the parity of the inputs");
    await page.getByRole("button", { name: "Use this in the editor" }).click();
    await page.getByRole("button", { name: "Save to my account" }).click();
    await see("Simulated by the server.");
    await see("Full adder");
    await screenshot("assistant-online");
    // Leave the account as the steps after this one expect it: no circuits yet.
    await page.getByRole("button", { name: "Delete" }).click();
    await see("You have no circuits yet");
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

  await step("online: save a copy of a server circuit in the library", async () => {
    await page.getByRole("button", { name: "Save to library" }).click();
    await see("Saved a copy");
    await go("#/library");
    await page.locator(".circuit-card", { hasText: "Full adder" }).waitFor();
  });

  await step("online: upload a library circuit to the account", async () => {
    await go("#/library");
    await page.locator(".circuit-card", { hasText: "Half adder" }).click();
    await page.locator("h1", { hasText: "Half adder" }).waitFor();
    await page.getByRole("button", { name: "Upload to my account" }).click();
    await see("Simulated by the server.");
    assert.notEqual(await page.evaluate(() => location.hash), circuitHash);
  });

  await step("a second launch with a file hands it to the running app", async () => {
    const second = spawn(executable, argsFor(netlist("half-adder.net")), { env, stdio: "ignore" });
    const [code] = await once(second, "exit"); // it finds the running app, passes the file on, and quits
    assert.equal(code, 0);
    await page.locator("h1", { hasText: "Half adder" }).waitFor();
    assert.equal(app.windows().length, 1, "still one window");
    await screenshot("second-instance");
  });

  await step("online: the list shows both circuits", async () => {
    await go("#/circuits?scope=owned");
    await page.locator(".circuit-card").nth(1).waitFor(); // the list loads after the page appears
    assert.equal(await page.locator(".circuit-card").count(), 2);
    await screenshot("online-list");
  });

  await step("assistant: Ollama not running is explained, and the default address comes back", async () => {
    await go("#/settings");
    await page.getByLabel("Ollama address").fill("http://127.0.0.1:1");
    await page.getByRole("button", { name: "Save address" }).click();
    await see("Can't reach Ollama at http://127.0.0.1:1");
    await go("#/local/new/netlist?ask=1");
    await see("Can't reach Ollama at http://127.0.0.1:1"); // the panel's own line
    await page.getByLabel("What circuit do you want?").fill("a full adder");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await page.locator(".alert-error", { hasText: "Can't reach Ollama" }).waitFor();
    await screenshot("assistant-no-ollama");
    await go("#/settings");
    await page.getByRole("button", { name: "Use Ollama's default" }).click();
    await see("Saved. The assistant now looks for Ollama at http://127.0.0.1:11434.");
    const saved = JSON.parse(readFileSync(path.join(profileDir, "settings.json"), "utf8"));
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
  await app.close();
  fakeOllama.closeAllConnections();
  fakeOllama.close();
  await api.close();
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
