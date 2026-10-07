import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type ElectronApplication, type Locator, type Page, type TestInfo } from "@playwright/test";

export type Mode = "Simulate" | "Draw" | "Netlist";

export interface Account {
  readonly displayName: string;
  readonly email: string;
  readonly password: string;
}

/**
 * The app's screens in the words of a person using it ("open the half adder example", "flip input
 * A", "wire A to and1"), so the tests read as steps. The CSS selectors live here, in one place.
 */
export class CircuitLab {
  /** The assistant's panel, over the screen or in the workspace's right-hand column. */
  readonly assistant: Locator;
  readonly request: Locator;
  readonly askButton: Locator;
  /** The netlist text in Netlist mode. */
  readonly netlistText: Locator;
  /** The circuit cards of the library and of the server's lists. */
  readonly cards: Locator;

  constructor(
    readonly page: Page,
    private readonly electronApp: ElectronApplication,
    /** This run's API, for things a test sets up behind the app's back (another person's account). */
    readonly apiUrl: string,
    private readonly testInfo: TestInfo,
  ) {
    this.assistant = page.locator(".assistant");
    this.request = page.getByLabel("What circuit do you want?");
    this.askButton = this.assistant.getByRole("button", { name: "Ask", exact: true });
    this.netlistText = page.locator("textarea.net-text");
    this.cards = page.locator(".card-grid .ccard");
  }

  // ---- getting around ---------------------------------------------------------------------------

  async go(hash: string): Promise<void> {
    await this.page.evaluate((target) => {
      location.hash = target;
    }, hash);
  }

  async expectAt(hash: string): Promise<void> {
    await expect.poll(() => this.page.evaluate(() => location.hash)).toBe(hash);
  }

  /** Opens one of the home screen's examples in the workspace. */
  async openExample(name: string): Promise<void> {
    await this.go("#/");
    await this.page.locator(".examples .ccard", { hasText: name }).click();
    await this.expectOpen(name);
  }

  /** A short message at the bottom of the window. */
  toast(text: string | RegExp): Locator {
    return this.page.locator(".toast", { hasText: text });
  }

  // ---- the open circuit ---------------------------------------------------------------------------

  async expectOpen(name: string): Promise<void> {
    await expect(this.page.locator(".ws-name")).toHaveText(name);
  }

  /** Where the circuit is kept: "In your library", "File", "Not saved", "Private", "Public". */
  async expectBadge(text: string): Promise<void> {
    await expect(this.page.locator(".ws-title .badge")).toHaveText(text);
  }

  async setMode(mode: Mode): Promise<void> {
    await this.page.locator('.ws-head [aria-label="Mode"] button', { hasText: mode }).click();
    await expect(this.page.locator('.ws-head [aria-label="Mode"] button[aria-pressed="true"]')).toHaveText(mode);
  }

  /** The header's Save button: "Save to library", or "Save" for a file or the server. */
  async save(label: "Save" | "Save to library"): Promise<void> {
    await this.page.locator(".ws-actions").getByRole("button", { name: label, exact: true }).click();
  }

  /** A command of the header's More menu. */
  async more(item: string): Promise<void> {
    await this.page.getByRole("button", { name: "More ▾" }).click();
    await this.page.getByRole("menuitem", { name: item }).click();
  }

  /** The tabs of the workspace's right-hand column. */
  async showTab(tab: "Details" | "Assistant"): Promise<void> {
    await this.page.locator(".ins-tabs").getByRole("button", { name: tab, exact: true }).click();
  }

  // ---- simulating -----------------------------------------------------------------------------------

  /** An input's switch in the right-hand column. */
  input(id: string): Locator {
    return this.page.getByRole("button", { name: `Input ${id}`, exact: true });
  }

  async expectOutput(id: string, value: "0" | "1"): Promise<void> {
    await expect(this.page.locator(`.out-row[data-io="${id}"] .out-bit`)).toHaveAttribute("data-value", value);
  }

  /** The line under the details that says who simulated ("Simulated by the server.", ...). */
  get simulationStatus(): Locator {
    return this.page.locator(".sim-status");
  }

  /** The truth table's rows, in the drawer under the drawing. */
  get tableRows(): Locator {
    return this.page.locator(".drawer table.tt tbody tr");
  }

  // ---- drawing ----------------------------------------------------------------------------------------

  /** A gate in the drawing, by its name. */
  gate(id: string): Locator {
    return this.page.locator(`.canvas [data-gate="${id}"]`);
  }

  /** Adds a gate from Draw mode's palette ("Input", "AND", "0/1", ...). */
  async addGate(label: string): Promise<void> {
    await this.page.locator(".gate-palette .gate-button").filter({ hasText: new RegExp(`^${label}$`) }).click();
  }

  /** Drags a wire from a gate's output to an input pin of another, as a person does with the mouse. */
  async wire(fromGate: string, toGate: string, toPin: number): Promise<void> {
    const from = await this.centreOf(this.page.locator(`[data-gate="${fromGate}"] .pin-hit[data-pin="out"]`));
    const to = await this.centreOf(this.page.locator(`[data-gate="${toGate}"] .pin-hit[data-pin="in"][data-index="${toPin}"]`));
    await this.page.mouse.move(from.x, from.y);
    await this.page.mouse.down();
    await this.page.mouse.move(to.x, to.y, { steps: 8 }); // in steps, as a hand moves
    await this.page.mouse.up();
  }

  /**
   * The centre of an element of the drawing. The drawing is drawn afresh after every change (a
   * simulation result, say), which replaces its elements for a moment: measure until it works.
   */
  private async centreOf(element: Locator): Promise<{ x: number; y: number }> {
    for (let tries = 0; tries < 40; tries++) {
      const box = await element.boundingBox();
      if (box !== null) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await this.page.waitForTimeout(250);
    }
    throw new Error(`Can't find ${element.toString()} on the drawing.`);
  }

  /** The Check button and its answer, in Draw mode's details. */
  async checkDrawing(): Promise<void> {
    await this.page.locator(".inspector").getByRole("button", { name: "Check", exact: true }).click();
  }

  // ---- the assistant ------------------------------------------------------------------------------------

  async openAssistant(): Promise<void> {
    await this.page.keyboard.press("Control+J");
    await expect(this.assistant).toBeVisible();
  }

  /** The panel sits in the workspace's right-hand column (rather than over the screen). */
  get dockedAssistant(): Locator {
    return this.page.locator(".inspector .assistant.docked");
  }

  async ask(text: string): Promise<void> {
    await this.request.fill(text);
    await this.askButton.click();
  }

  /** The panel's own close button (only when it is over the screen). */
  async closeAssistant(): Promise<void> {
    await this.assistant.locator(".as-close").click();
    await expect(this.assistant).toHaveCount(0);
  }

  // ---- accounts ------------------------------------------------------------------------------------------

  /** A new account on this run's API, made through the sign-in dialog. */
  async signUp(displayName = "Ada"): Promise<Account> {
    const account = newAccount(displayName);
    await this.page.locator(".sidebar").getByRole("button", { name: "Sign in", exact: true }).click();
    const dialog = this.page.locator(".modal");
    await dialog.getByRole("button", { name: "Create an account" }).click();
    await dialog.getByLabel("Your name").fill(account.displayName);
    await dialog.getByLabel("Email").fill(account.email);
    await dialog.getByLabel("Password").fill(account.password);
    await dialog.getByRole("button", { name: "Create account" }).click();
    await expect(this.toast(`Signed in as ${displayName}.`)).toBeVisible();
    return account;
  }

  async signIn(account: Account): Promise<void> {
    await this.page.locator(".sidebar").getByRole("button", { name: "Sign in", exact: true }).click();
    const dialog = this.page.locator(".modal");
    await dialog.getByLabel("Email").fill(account.email);
    await dialog.getByLabel("Password").fill(account.password);
    await dialog.locator('button[type="submit"]').click();
    await expect(this.toast(`Signed in as ${account.displayName}.`)).toBeVisible();
  }

  async signOut(): Promise<void> {
    await this.page.locator(".sidebar").getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(this.page.locator(".sidebar").getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  }

  /** An account made straight on the API, for the other person in a test. */
  async registerElsewhere(displayName: string): Promise<Account> {
    const account = newAccount(displayName);
    const response = await fetch(`${this.apiUrl}/v1/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(account) });
    expect(response.status, "registering on the API").toBe(201);
    return account;
  }

  // ---- the main process ---------------------------------------------------------------------------------

  /** Answers the next Save dialog with `file`. The dialog is Windows' own, so it's answered in the main process. */
  async answerSaveDialog(file: string): Promise<void> {
    await this.electronApp.evaluate(({ dialog }, target) => {
      (dialog as unknown as { showSaveDialog: () => Promise<unknown> }).showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, file);
  }

  // ---- pictures ---------------------------------------------------------------------------------------------

  /** A screenshot in the HTML report, and in dist/e2e/shots/ (for the docs). */
  async shot(name: string): Promise<void> {
    const body = await this.page.screenshot();
    await this.testInfo.attach(name, { body, contentType: "image/png" });
    const folder = path.join(__dirname, "..", "dist", "e2e", "shots");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, `${name}.png`), body);
  }
}

let accounts = 0;

/** A throwaway account that only exists in this run's in-memory API. */
function newAccount(displayName: string): Account {
  accounts += 1;
  const unique = `${Date.now()}.${process.pid}.${accounts}`;
  return { displayName, email: `${displayName.toLowerCase()}.${unique}@example.test`, password: `e2e test passphrase ${unique}` };
}
