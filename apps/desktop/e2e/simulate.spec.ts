import { expect, test } from "./fixtures";

// Offline: the app simulates examples itself, with the same engine the API uses.

test("flips a half adder's inputs by switch and by key, and the truth table follows", async ({ ui }) => {
  await ui.openExample("Half adder");
  await ui.expectBadge("Not saved");
  await expect(ui.simulationStatus).toHaveText("Simulated on this computer.");
  await ui.input("A").click();
  await ui.expectOutput("S", "1");
  await ui.expectOutput("C", "0");
  await ui.page.keyboard.press("2"); // the keys 1 to 9 flip the inputs
  await ui.expectOutput("C", "1");
  await ui.expectOutput("S", "0");
  await expect(ui.tableRows).toHaveCount(4);
  await expect(ui.page.locator(".drawer tr.current"), "the row of the inputs as they are").toHaveAttribute("data-bits", "11");
  await ui.shot("half-adder");
});

test("a row of the truth table sets the inputs to it", async ({ ui }) => {
  await ui.openExample("Half adder");
  await ui.page.locator('.drawer tr[data-bits="10"]').click();
  await expect(ui.input("A")).toHaveAttribute("aria-pressed", "true");
  await expect(ui.input("B")).toHaveAttribute("aria-pressed", "false");
  await ui.expectOutput("S", "1");
  await ui.expectOutput("C", "0");
});

test("clicking an input in the drawing flips it", async ({ ui }) => {
  await ui.openExample("Half adder");
  await ui.gate("B").click();
  await expect(ui.input("B")).toHaveAttribute("aria-pressed", "true");
  await ui.expectOutput("S", "1");
});

test("an SR latch remembers, step by step, and has no truth table", async ({ ui }) => {
  await ui.openExample("SR latch");
  const remembers = ui.page.locator(".seq-box");
  await expect(remembers).toContainText("Remembers:");
  await ui.input("S").click(); // set
  await ui.expectOutput("out_q", "1");
  await ui.input("S").click(); // and back to 0: q must stay 1
  await expect(ui.input("S")).toHaveAttribute("aria-pressed", "false");
  await expect(remembers).toContainText("q=1");
  await ui.expectOutput("out_q", "1");
  await expect(ui.page.getByText("has no truth table")).toBeVisible();
  await ui.shot("latch");
});
