import { readdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

// The library: circuits saved inside the app, one JSON file each in the profile's library folder.

test("lists saved circuits newest first, filters, searches, opens, and deletes", async ({ ui, profileDir }) => {
  await ui.openExample("Half adder");
  await ui.save("Save to library");
  await ui.expectBadge("In your library");
  await ui.openExample("SR latch");
  await ui.save("Save to library");
  await ui.expectBadge("In your library");

  await ui.go("#/library");
  await expect(ui.cards).toHaveCount(2);
  await expect(ui.cards.first(), "newest first").toContainText("SR latch");
  await expect(ui.page.locator(".page-title .count")).toHaveText("2");
  await ui.shot("library");

  await ui.page.getByRole("button", { name: "Remembers state", exact: true }).click();
  await expect(ui.cards).toHaveCount(1);
  await expect(ui.cards.first()).toContainText("SR latch");
  await ui.page.getByRole("button", { name: "All", exact: true }).click();
  await ui.page.getByLabel("Search by name").fill("half");
  await expect(ui.cards).toHaveCount(1);

  await ui.cards.first().click();
  await ui.expectOpen("Half adder");
  await ui.expectBadge("In your library");
  await ui.more("Delete from the library");
  await ui.expectAt("#/library");
  await expect(ui.cards).toHaveCount(1);
  expect(readdirSync(path.join(profileDir, "library")).filter((name) => name.endsWith(".json"))).toHaveLength(1);
});

test("the home screen lists the library, one click away", async ({ ui }) => {
  await ui.openExample("Full adder");
  await ui.save("Save to library");
  await ui.expectBadge("In your library");
  await ui.go("#/");
  await ui.page.locator(".row-link", { hasText: "Full adder" }).click();
  await ui.expectOpen("Full adder");
  await ui.expectBadge("In your library");
});

test("Close puts the circuit away; the command palette finds it by name", async ({ ui }) => {
  await ui.openExample("Half adder");
  await ui.save("Save to library");
  await ui.expectBadge("In your library");
  await ui.page.locator(".ws-actions").getByRole("button", { name: "Close", exact: true }).click();
  await ui.expectAt("#/library");
  await ui.page.keyboard.press("Control+K");
  await ui.page.getByLabel("Command or circuit name").fill("half");
  // The example is listed too ("Open example: Half adder"); the library's own is named as saved.
  await ui.page.locator(".palette-item", { has: ui.page.getByText("Half adder", { exact: true }) }).click();
  await ui.expectOpen("Half adder");
  await ui.expectBadge("In your library");
});
