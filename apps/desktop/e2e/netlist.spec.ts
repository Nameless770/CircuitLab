import { expect, test } from "./fixtures";

// Netlist mode: the circuit as text, one gate per line.

test("a mistake is listed and marked on its line; the fixed text becomes the circuit", async ({ ui }) => {
  await ui.openExample("Half adder");
  await ui.page.keyboard.press("Control+3");
  await expect(ui.netlistText).toHaveValue(/carry\s*=\s*AND\(A, B\)/);
  const text = await ui.netlistText.inputValue();

  await ui.netlistText.fill(`${text.trimEnd()}\nextra = NOT(nope)\nE = OUTPUT(extra)\n`);
  const bar = ui.page.locator(".net-bar");
  await bar.getByRole("button", { name: "Check", exact: true }).click();
  await expect(bar).toContainText("1 problem found");
  await expect(ui.page.locator(".issues-box .issue", { hasText: "nope" })).toBeVisible();
  await expect(ui.page.locator(".net-gutter .bad"), "its line is marked").toHaveCount(1);
  await ui.shot("netlist-mistake");

  await ui.netlistText.fill(`${text.trimEnd()}\nextra = NOT(A)\nE = OUTPUT(extra)\n`);
  await bar.getByRole("button", { name: "Apply to drawing" }).click();
  await expect(ui.toast("Drawing updated from the netlist.")).toBeVisible();
  await ui.setMode("Simulate");
  await ui.expectOutput("E", "1"); // NOT of A, which is 0
  await ui.input("A").click();
  await ui.expectOutput("E", "0");
});

test("leaving Netlist mode with mistakes asks first, then drops the text", async ({ ui, dialogs }) => {
  await ui.openExample("Half adder");
  await ui.setMode("Netlist");
  await ui.netlistText.fill("broken = AND(\n");
  await ui.setMode("Draw");
  expect(dialogs.at(-1)).toMatch(/The netlist has mistakes/);
  await expect(ui.gate("carry"), "the circuit as it was").toBeVisible();
});
