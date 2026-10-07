import { expect, savedSettings, test } from "./fixtures";

// These start with nothing in Settings, as on a first start, and set the addresses themselves.
test.use({ saveServers: false });

test("the server address is checked, saved without a trailing slash, and used", async ({ ui, api, profileDir }) => {
  await ui.go("#/settings");
  const address = ui.page.getByLabel("Server address");
  // The browser itself refuses things that aren't URLs at all (the field is type="url"); an
  // ftp:// address passes that, and the app's own check must catch it.
  await address.fill("ftp://example.com");
  await ui.page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(ui.page.getByText("must start with http:// or https://")).toBeVisible();
  await address.fill(`${api.url}/`);
  await ui.page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(ui.page.getByText(`Server online at ${api.url} `)).toBeVisible();
  expect(savedSettings(profileDir).apiUrl).toBe(api.url);
  await expect(ui.page.locator(".sidebar")).toContainText("Server online");
  await ui.shot("settings");
});

test("Ollama's address and the model are saved, and the default address comes back", async ({ ui, ollama, profileDir }) => {
  await ui.go("#/settings");
  await ui.page.getByLabel("Ollama address").fill(`${ollama.url}/`);
  await ui.page.getByRole("button", { name: "Save address" }).click();
  await expect(ui.page.getByText(`Ollama answers at ${ollama.url}, on this computer. It has 2 models.`)).toBeVisible();
  await ui.page.getByLabel("Model").selectOption("other-model:3b");
  await expect(ui.page.getByText("The assistant uses other-model:3b.")).toBeVisible();
  expect(savedSettings(profileDir)).toMatchObject({ assistantUrl: ollama.url, assistantModel: "other-model:3b" });
  await expect(ui.page.locator(".sidebar"), "the sidebar's assistant card").toContainText("other-model:3b");

  await ui.page.getByRole("button", { name: "Use Ollama's default" }).click();
  await expect(ui.page.getByText("Saved. The assistant now looks for Ollama at http://127.0.0.1:11434.")).toBeVisible();
  const saved = savedSettings(profileDir);
  expect(saved.assistantUrl, "the default isn't saved as an address").toBeUndefined();
  expect(saved.assistantModel, "the chosen model is kept").toBe("other-model:3b");
});

test("the light theme and the signal colour apply at once, and are kept", async ({ ui, profileDir }) => {
  await ui.page.locator(".tb-theme").click();
  await expect(ui.page.locator("html")).toHaveAttribute("data-theme", "light");
  // The main process keeps it too, to paint the window and its title bar before the page loads.
  await expect.poll(() => savedSettings(profileDir).theme).toBe("light");
  await ui.shot("home-light");

  await ui.go("#/settings");
  await ui.page.getByRole("button", { name: "Green", exact: true }).click();
  await expect(ui.page.locator("html")).toHaveAttribute("data-signal", "green");
  expect(await ui.page.evaluate(() => [localStorage.getItem("circuitlab.theme"), localStorage.getItem("circuitlab.signal")])).toEqual(["light", "green"]);
});
