import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { copyExample, expect, test } from "./fixtures";

// Windows starts the app with the file's path when a .net file is double-clicked.

test.describe("started with a .net file", () => {
  test.use({ startupFile: "full-adder.net" });

  test("opens the file, and simulates it on this computer", async ({ ui }) => {
    await ui.expectOpen("Full adder");
    await ui.expectBadge("File");
    await expect(ui.simulationStatus).toHaveText("Simulated on this computer.");
    await ui.shot("startup-file");
  });

  test("a second launch with a file hands it to the running app, and quits", async ({ ui, launch, profileDir, electronApp }) => {
    await ui.expectOpen("Full adder");
    const second = spawn(launch.executable, launch.args(copyExample(profileDir, "half-adder.net")), { env: launch.env, stdio: "ignore" });
    const [code] = await once(second, "exit"); // it finds the running app, passes the file on, and quits
    expect(code).toBe(0);
    await ui.expectOpen("Half adder");
    await ui.expectBadge("File");
    expect(electronApp.windows(), "still one window").toHaveLength(1);
  });

  test("saving a drawing over a file with comments asks first, then writes the file from the drawing", async ({ ui, profileDir, dialogs }) => {
    await ui.expectOpen("Full adder");
    await ui.setMode("Draw");
    await ui.page.getByLabel("Circuit name").fill("Full adder, renamed");
    await ui.save("Save");
    await expect(ui.toast("Saved to full-adder.net.")).toBeVisible();
    expect(dialogs.at(-1)).toMatch(/comments in it will be lost/);
    const written = readFileSync(path.join(profileDir, "full-adder.net"), "utf8");
    expect(written).toContain('.name "Full adder, renamed"');
    expect(written, "a drawing has no comments").not.toContain("#");
    await ui.expectBadge("File");
  });
});

test.describe("started with a .net file that has mistakes", () => {
  test.use({ startupFile: "broken.net" });

  test("says what's wrong, and stays on the home screen", async ({ ui }) => {
    await expect(ui.page.locator(".toast.error")).toBeVisible();
    await expect(ui.page.locator(".home")).toBeVisible();
    await expect(ui.page.locator(".ws")).toHaveCount(0);
  });
});
