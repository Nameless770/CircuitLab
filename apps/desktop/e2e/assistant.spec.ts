import type { CircuitLab } from "./circuitlab";
import { expect, test } from "./fixtures";

// The assistant, against the fake Ollama of fixtures.ts (canned answers, picked by the question).

/** A full adder drafted by the assistant and saved in the library: a circuit with known formulas. */
async function savedFullAdderFromTheAssistant(ui: CircuitLab): Promise<void> {
  await ui.openAssistant();
  await ui.ask("a full adder");
  await ui.assistant.getByRole("button", { name: "Use this in the editor" }).click();
  await ui.expectOpen("Full adder");
  await ui.save("Save to library");
  await ui.expectBadge("In your library");
}

test("drafts a circuit, shows how it behaves, and opens it when asked", async ({ ui, ollama }) => {
  await ui.openAssistant(); // on the home screen it comes over the screen
  await expect(ui.dockedAssistant).toHaveCount(0);
  await expect(ui.assistant).toContainText("Using other-model:3b in Ollama, on this computer");
  await ui.ask("a full adder");
  await expect(ui.assistant).toContainText("SUM is the parity of the inputs");
  await expect(ui.assistant).toContainText("Made by other-model:3b.");
  await expect(ui.assistant.locator(".as-answer table.tt tbody tr"), "the whole truth table of 3 inputs").toHaveCount(8);
  await expect(ui.assistant.locator(".as-answer .netlist-text")).toContainText("xor1 = XOR(A, B, CIN)");
  await ui.shot("assistant-draft");

  // What reached Ollama: the chosen model, the answer's shape, the recipes for this request, the request.
  const asked = ollama.chats.at(-1);
  expect(asked?.model).toBe("other-model:3b");
  expect(asked?.stream).toBe(false);
  expect(asked?.options.num_ctx).toBe(8192);
  expect(asked?.format?.properties, "the answer is asked for in the schema's shape").toHaveProperty("outputs");
  expect(asked?.messages[0]?.content).toMatch(/Request: a full adder with inputs A, B and CIN/);
  expect(asked?.messages.at(-1)?.content).toBe("Design this circuit: a full adder");

  // Nothing is in the workspace until "Use this".
  await ui.assistant.getByRole("button", { name: "Use this in the editor" }).click();
  await expect(ui.toast("The workspace now holds the assistant's circuit")).toBeVisible();
  await expect(ui.assistant, "over a screen, it closes").toHaveCount(0);
  await ui.expectOpen("Full adder");
  await ui.expectBadge("Not saved");
  await ui.expectOutput("COUT", "0");
});

test("beside the drawing: changes the open circuit, and you keep drawing", async ({ ui, ollama }) => {
  await savedFullAdderFromTheAssistant(ui);
  await ui.setMode("Draw");
  await ui.more("Ask the assistant to change it");
  // In the workspace it takes the right-hand column, instead of covering the circuit.
  await expect(ui.dockedAssistant).toBeVisible();
  await expect(ui.page.locator('.ins-tabs button[aria-pressed="true"]')).toHaveText("Assistant");
  await expect(ui.page.locator(".canvas.drawing"), "the drawing stays in view").toBeVisible();
  await expect(ui.assistant.getByRole("button", { name: "Change the open circuit" })).toHaveAttribute("aria-pressed", "true");

  await ui.ask("invert the carry output");
  await expect(ui.assistant).toContainText("The same circuit, with the carry turned upside down.");
  // The model was shown the circuit as it is, in its own format.
  const question = ollama.chats.at(-1)?.messages.at(-1)?.content ?? "";
  expect(question).toMatch(/^Here is the current circuit:\n\{/);
  expect(question, "the open circuit's formulas").toContain('"formula":"A ^ B ^ CIN"');
  expect(question.endsWith("Change it like this: invert the carry output\nAnswer with the complete new circuit.")).toBe(true);
  await ui.shot("assistant-docked");

  await ui.assistant.getByRole("button", { name: "Use this in the open circuit" }).click();
  await expect(ui.page.locator('.canvas.drawing [data-type="NOT"]'), "still drawing, now with the change").toHaveCount(1);
  await expect(ui.dockedAssistant, "the panel stays for the next question").toBeVisible();
  await ui.expectBadge("In your library"); // still where it's saved, with unsaved changes
  await expect(ui.page.locator(".tb-dirty")).toHaveCount(1);
  await ui.save("Save to library");
  await ui.expectOpen("Inverted-carry adder");
});

test("Undo brings the circuit back, but not after an edit of your own", async ({ ui }) => {
  await savedFullAdderFromTheAssistant(ui);
  await ui.setMode("Draw");
  await ui.more("Ask the assistant to change it");
  await ui.ask("invert the carry output");
  const use = ui.assistant.getByRole("button", { name: "Use this in the open circuit" });
  const undo = ui.assistant.getByRole("button", { name: "Undo", exact: true });
  const nots = ui.page.locator('.canvas [data-type="NOT"]');
  await use.click();
  await expect(nots).toHaveCount(1);
  await expect(ui.assistant.locator(".alert.ok")).toContainText("The assistant's change is in the open circuit");
  await undo.click();
  await expect(nots).toHaveCount(0);
  await expect(ui.page.locator(".tb-dirty"), "back as it was saved").toHaveCount(0);

  // Again, then an edit of your own: Undo would throw that away too, so it refuses and keeps both.
  await ui.askButton.click();
  await use.click();
  await expect(nots).toHaveCount(1);
  await ui.addGate("BUF");
  await undo.click();
  await expect(ui.assistant).toContainText("Not undone: the circuit has changed since");
  await expect(nots).toHaveCount(1);
  await expect(ui.page.locator('.canvas [data-type="BUF"]')).toHaveCount(1);
});

test("the workspace remembers the Assistant tab", async ({ ui }) => {
  await ui.openExample("Half adder");
  await ui.showTab("Assistant");
  await expect(ui.dockedAssistant).toBeVisible();
  await ui.go("#/library");
  await expect(ui.assistant, "not over other screens unless asked").toHaveCount(0);
  await ui.go("#/workspace");
  await expect(ui.dockedAssistant).toBeVisible();
  await ui.showTab("Details");
  await expect(ui.assistant).toHaveCount(0);
  await expect(ui.input("A")).toBeVisible();
});

test("Esc closes it over a screen, but beside the circuit only leaves its text box", async ({ ui }) => {
  await ui.openAssistant();
  await ui.page.keyboard.press("Escape");
  await expect(ui.assistant).toHaveCount(0);

  await ui.openExample("Half adder");
  await ui.openAssistant();
  await expect(ui.dockedAssistant).toBeVisible();
  await expect(ui.request).toBeFocused();
  await ui.page.keyboard.press("Escape");
  await expect(ui.request).not.toBeFocused();
  await expect(ui.dockedAssistant).toBeVisible();
  await ui.page.keyboard.press("1"); // the workspace's own keys work again: A flips
  // (The switches are on the Details tab, hidden now; the truth table shows the inputs too.)
  await expect(ui.page.locator(".drawer tr.current")).toHaveAttribute("data-bits", "10");
});

test("an empty new circuit takes the draft, and you stay in Draw mode", async ({ ui }) => {
  await ui.page.keyboard.press("Control+N");
  await ui.expectOpen("Untitled circuit");
  await ui.openAssistant();
  await expect(ui.dockedAssistant).toBeVisible();
  await expect(ui.assistant.getByRole("button", { name: "Change the open circuit" }), "an empty circuit has nothing to change").toBeDisabled();
  await ui.ask("a full adder");
  await ui.assistant.getByRole("button", { name: "Use this in the editor" }).click();
  await ui.expectOpen("Full adder");
  await expect(ui.gate("xor1")).toBeVisible();
  await expect(ui.page.locator(".canvas.drawing")).toBeVisible();
  await ui.expectBadge("Not saved");
});

test("Cancel stops a slow answer; a request that isn't a circuit is declined; an empty one is caught", async ({ ui }) => {
  await ui.openAssistant();
  const cancel = ui.assistant.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel, "only while a question is being worked on").toBeHidden();
  await ui.ask("a slow circuit");
  await expect(ui.assistant).toContainText("Asking other-model:3b");
  await cancel.click();
  await expect(ui.assistant).toContainText("Stopped.");
  await expect(cancel).toBeHidden();
  await expect(ui.askButton).toBeEnabled();

  await ui.ask("pancakes");
  await expect(ui.assistant).toContainText("The assistant can't make that.");
  await expect(ui.assistant).toContainText("Pancakes are not a digital circuit.");
  await ui.ask("   ");
  await expect(ui.assistant).toContainText("Write what circuit you want first.");
  await ui.closeAssistant();
});

test.describe("when Ollama isn't running", () => {
  test.use({ settings: { assistantUrl: "http://127.0.0.1:1" } });

  test("says so in the panel, and when asked", async ({ ui }) => {
    await ui.openAssistant();
    await expect(ui.assistant).toContainText("Can't reach Ollama at http://127.0.0.1:1");
    await ui.ask("a full adder");
    await expect(ui.assistant.locator(".alert.error", { hasText: "Can't reach Ollama" })).toBeVisible();
    await ui.shot("assistant-no-ollama");
  });
});
