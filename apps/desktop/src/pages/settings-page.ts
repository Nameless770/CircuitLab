import type { DesktopBridge } from "../../electron/bridge";
import { normalizeApiUrl } from "../../electron/helpers";
import { assistantSettingsCard } from "../assistant/settings-card";
import { signOut } from "../api";
import { desktop, unwrap } from "../desktop";
import { h } from "../dom";
import { serverStatusLine } from "../online/server-status";
import type { PageContext } from "../router";
import { currentSession } from "../session";
import { field, pageHeader, runAction, successBox } from "../ui";

/** `#/settings`: online mode's server address, and the assistant's Ollama. The main process saves them, in settings.json. */
export async function settingsPage({ root, signal }: PageContext): Promise<void> {
  const maybeBridge = desktop();
  if (maybeBridge === null) {
    root.append(h("div", { class: "card empty-state" }, h("h1", {}, "Settings"), h("p", {}, "Settings are part of the desktop app.")));
    return;
  }
  // A non-null copy: TypeScript forgets the check above inside the functions declared below.
  const bridge: DesktopBridge = maybeBridge;
  let settings = await bridge.getSettings();

  const address = h("input", { type: "url", value: settings.apiUrl, required: true, spellcheck: "false", placeholder: settings.defaultApiUrl });
  const save = h("button", { type: "submit", class: "primary" }, "Save");
  const reset = h("button", { type: "button" }, "Use the default");
  const message = h("div");
  const statusArea = h("div", {}, serverStatusLine(signal));

  /** Saves `text` as the address (null: back to the default). */
  async function apply(text: string | null, button: HTMLButtonElement): Promise<void> {
    await runAction(button, message, async () => {
      // Check the address before anything else (the main process checks it again when saving).
      const newUrl = text === null ? settings.defaultApiUrl : normalizeApiUrl(text);
      const changing = newUrl !== settings.apiUrl && !settings.fromEnvironment;
      // Accounts live on a server, so a new server means signing out. Do it now, while the old
      // server is still the one requests go to, so it can end the session.
      if (changing && currentSession() !== null) {
        if (!confirm("Changing the server signs you out: your account is on the current server. Continue?")) return;
        await signOut();
      }
      settings = unwrap(await bridge.setApiUrl(text));
      address.value = settings.apiUrl;
      message.replaceChildren(successBox(changing ? `Saved. Online mode now uses ${settings.apiUrl}.` : "Saved."));
      statusArea.replaceChildren(serverStatusLine(signal));
    });
  }

  const form = h(
    "form",
    { class: "form" },
    field("Server address", address, `The CircuitLab API that online mode uses. The default, ${settings.defaultApiUrl}, is the one npm run start:api starts on this computer.`),
    settings.fromEnvironment ? h("p", { class: "alert alert-info" }, "CIRCUITLAB_API_URL is set, so this run uses its address whatever is saved here.") : null,
    message,
    h("div", { class: "form-actions" }, save, reset),
    statusArea,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void apply(address.value, save);
  });
  reset.addEventListener("click", () => void apply(null, reset));

  root.append(pageHeader("Settings"), h("section", { class: "card settings-card" }, h("h2", {}, "Online mode"), form), assistantSettingsCard(bridge, settings.assistant));
}
