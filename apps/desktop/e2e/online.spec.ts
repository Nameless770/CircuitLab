import type { CircuitLab } from "./circuitlab";
import { expect, test } from "./fixtures";

// Online mode, against this run's API (in memory). Each test makes its own account.

/** Opens an example and uploads it to the signed-in account. */
async function uploadExample(ui: CircuitLab, name: string): Promise<void> {
  await ui.openExample(name);
  await ui.more("Upload to my account");
  await expect(ui.toast("Uploaded: it's in your account now.")).toBeVisible();
  await ui.expectBadge("Private");
}

test("creates an account in the sign-in dialog, and signs out again", async ({ ui }) => {
  const email = `ada.${Date.now()}@example.test`;
  await ui.page.locator(".sidebar").getByRole("button", { name: "Sign in", exact: true }).click();
  const dialog = ui.page.locator(".modal");
  await dialog.getByRole("button", { name: "Create an account" }).click();
  await dialog.getByLabel("Your name").fill("Ada");
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByLabel("Password").fill("too short");
  await dialog.getByRole("button", { name: "Create account" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("The password needs at least 15 characters.");
  await dialog.getByLabel("Password").fill("a passphrase that is long enough");
  await dialog.getByRole("button", { name: "Create account" }).click();
  await expect(ui.toast("Signed in as Ada.")).toBeVisible();
  await expect(ui.page.locator(".sidebar")).toContainText(email);
  await ui.go("#/circuits?scope=owned");
  await expect(ui.page.getByText("You have no circuits yet")).toBeVisible();
  await ui.signOut();
});

test("an uploaded circuit is simulated by the server, which answers repeated questions from its cache", async ({ ui }) => {
  await ui.signUp();
  await uploadExample(ui, "Full adder");
  await expect(ui.simulationStatus).toHaveText("Simulated by the server.");
  await ui.input("A").click();
  await ui.input("B").click();
  await ui.expectOutput("Cout", "1");
  await ui.input("B").click(); // A=1 B=0 again: the server answered that before
  await expect(ui.simulationStatus).toContainText("Answered from the server's cache");
  await ui.shot("online-full-adder");
});

test("shares a circuit with another person, who finds it under Shared with me", async ({ ui }) => {
  const bob = await ui.registerElsewhere("Bob");
  await ui.signUp("Ada");
  await uploadExample(ui, "Half adder");
  await ui.page.locator("details.more > summary", { hasText: "Sharing" }).click();
  await ui.page.getByLabel("Email of their account").fill(bob.email);
  await ui.page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(ui.page.locator(".share-row", { hasText: bob.email })).toBeVisible();

  await ui.go("#/");
  await ui.signOut();
  await ui.signIn(bob);
  await ui.go("#/circuits?scope=shared");
  const card = ui.cards.filter({ hasText: "Half adder" });
  await expect(card).toHaveCount(1);
  await card.click();
  await ui.expectOpen("Half adder");
  await expect(ui.page.locator(".inspector")).toContainText("Ada owns this circuit.");
  // The server simulates it for Bob too. Ada asked the same question first, and the cache is per
  // circuit version and inputs, not per person, so the answer may come from the cache.
  await expect(ui.simulationStatus).toHaveText(/^(Simulated by the server\.|Answered from the server's cache)/);
});

test("makes a circuit public, lists its runs, and anyone finds it among the public circuits", async ({ ui }) => {
  await ui.signUp();
  await ui.openExample("Full adder");
  // A name no other test uses, to find it among everyone's public circuits.
  const name = `Public adder ${Date.now()}`;
  await ui.setMode("Draw");
  await ui.page.getByLabel("Circuit name").fill(name);
  await ui.setMode("Simulate");
  await ui.more("Upload to my account");
  await ui.expectBadge("Private");
  await ui.page.locator('[aria-label="Who can see it"] button', { hasText: "Public" }).click();
  await expect(ui.toast("Public: anyone can see it now.")).toBeVisible();
  await ui.expectBadge("Public");
  await ui.page.locator("details.more > summary", { hasText: "Recent runs" }).click();
  await expect(ui.page.getByText("Simulation (combinational)").first()).toBeVisible();
  await ui.shot("online-public");

  await ui.go("#/");
  await ui.signOut();
  await ui.go("#/circuits?scope=public");
  await expect(ui.cards.filter({ hasText: name })).toHaveCount(1);
});

test("computes a big truth table in the background", async ({ ui }) => {
  await ui.signUp();
  await uploadExample(ui, "Full adder");
  await ui.page.locator("details.more > summary", { hasText: "Big tables" }).click();
  await ui.page.getByRole("button", { name: "Compute in the background" }).click();
  await expect(ui.page.getByText("Done.", { exact: true })).toBeVisible();
  await expect(ui.page.getByRole("button", { name: "Download result (CSV)" })).toBeVisible();
});

test("an edit of a server circuit is saved as a new version, and the server simulates it", async ({ ui }) => {
  await ui.signUp();
  await uploadExample(ui, "Full adder");
  await expect(ui.page.locator(".ws-meta")).toContainText("version 1");
  await ui.setMode("Draw");
  await ui.page.locator('.gate-palette .gate-button[title="Inverts its input."]').click();
  await ui.wire("Cin", "not1", 0);
  await ui.addGate("Output");
  await ui.wire("not1", "Y", 0);
  await ui.save("Save");
  await expect(ui.toast("Saved: version 2.")).toBeVisible();
  await expect(ui.page.locator(".ws-meta")).toContainText("version 2");
  await ui.setMode("Simulate");
  await expect(ui.simulationStatus).toHaveText("Simulated by the server.");
  await ui.expectOutput("Y", "1"); // NOT of Cin, which is 0
});

test("copies a server circuit into the library, and uploads a library circuit", async ({ ui }) => {
  await ui.signUp();
  await uploadExample(ui, "Full adder");
  await ui.more("Save a copy to the library");
  await expect(ui.toast("Saved a copy of “Full adder” in your library")).toBeVisible();
  await ui.go("#/library");
  await ui.cards.filter({ hasText: "Full adder" }).click();
  await ui.expectBadge("In your library");
  await ui.more("Upload to my account");
  await ui.expectBadge("Private");
  await ui.go("#/circuits?scope=owned");
  await expect(ui.cards).toHaveCount(2);
  await ui.shot("online-list");
});

test("a new circuit started from My circuits, drafted by the assistant, is saved in the account", async ({ ui }) => {
  await ui.signUp();
  await ui.go("#/circuits?scope=owned");
  await ui.page.locator(".page-head").getByRole("button", { name: "New circuit" }).click();
  await ui.expectOpen("Untitled circuit");
  await expect(ui.page.locator(".ws-meta")).toContainText("Save puts it in your account");
  await ui.openAssistant();
  await expect(ui.dockedAssistant).toBeVisible();
  await ui.ask("a full adder");
  await ui.assistant.getByRole("button", { name: "Use this in the editor" }).click();
  await ui.expectOpen("Full adder");
  await ui.save("Save");
  await expect(ui.toast("Saved “Full adder” in your account.")).toBeVisible();
  await ui.expectBadge("Private");
  await ui.showTab("Details");
  await ui.setMode("Simulate");
  await expect(ui.simulationStatus).toHaveText("Simulated by the server.");

  await ui.more("Delete from the server");
  await ui.expectAt("#/circuits?scope=owned");
  await expect(ui.page.getByText("You have no circuits yet")).toBeVisible();
});
