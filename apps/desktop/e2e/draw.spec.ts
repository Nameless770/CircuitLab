import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

test("draws a circuit from the palette, checks it, saves it in the library, and simulates it", async ({ ui }) => {
  await ui.page.keyboard.press("Control+N");
  await ui.expectOpen("Untitled circuit");
  await ui.expectBadge("Not saved");
  await expect(ui.page.getByText("An empty canvas")).toBeVisible();
  for (const label of ["Input", "Input", "AND", "Output"]) await ui.addGate(label);
  await expect(ui.page.getByText("An empty canvas"), "the hint goes once there are gates").toBeHidden();

  await ui.checkDrawing();
  await expect(ui.page.locator(".inspector .alert.error"), "nothing is wired yet").toBeVisible();
  await expect(ui.page.locator(".gate.problem").first(), "unwired gates are outlined").toBeVisible();
  await ui.wire("A", "and1", 0);
  await ui.wire("B", "and1", 1);
  await ui.wire("and1", "Y", 0);
  await ui.checkDrawing();
  await expect(ui.page.locator(".inspector .alert.ok")).toContainText("Looks right: 4 gates, inputs A, B → outputs Y.");

  await ui.page.getByLabel("Circuit name").fill("My AND gate");
  await ui.page.getByLabel("Description").fill("Two inputs, one output.");
  await ui.shot("drawing");
  await ui.save("Save to library");
  await expect(ui.toast("Saved “My AND gate” in your library.")).toBeVisible();
  await ui.expectBadge("In your library");

  await ui.setMode("Simulate");
  await ui.input("A").click();
  await ui.expectOutput("Y", "0");
  await ui.input("B").click();
  await ui.expectOutput("Y", "1");
});

test("an example counts as unsaved only once it changes; a deleted gate takes its wires along", async ({ ui }) => {
  await ui.openExample("Half adder");
  await expect(ui.page.locator(".tb-dirty"), "nothing to lose yet").toHaveCount(0);
  await ui.setMode("Draw");
  const wires = ui.page.locator(".canvas [data-wire]");
  await expect(wires).toHaveCount(6);
  await ui.gate("carry").click();
  await expect(ui.page.locator(".inspector")).toContainText("AND gate");
  await ui.page.keyboard.press("Delete");
  await expect(ui.gate("carry")).toHaveCount(0);
  await expect(wires, "A and B into it, and it into C, are gone").toHaveCount(3);
  await expect(ui.page.locator(".tb-dirty")).toHaveCount(1);
});

test("exports the circuit as a .net file where you choose", async ({ ui, profileDir }) => {
  await ui.openExample("Half adder");
  const file = path.join(profileDir, "exported.net");
  await ui.answerSaveDialog(file);
  await ui.page.getByRole("button", { name: "Export .net" }).click();
  await expect(ui.toast("Exported to")).toBeVisible();
  expect(readFileSync(file, "utf8")).toMatch(/carry\s*=\s*AND\(A, B\)/);
});
