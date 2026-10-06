import type { DesktopBridge } from "../../electron/bridge";
import { normalizeApiUrl } from "../../electron/helpers";
import { assistantSettingsCard } from "../assistant/settings-card";
import { signOut } from "../api";
import { desktop, unwrap } from "../desktop";
import { h } from "../dom";
import type { PageContext } from "../router";
import { currentSession } from "../session";
import { emit, on } from "../shell/bus";
import { checkServer, serverState } from "../shell/status";
import { SIGNAL_COLOURS, THEMES, currentSignal, currentTheme, onAppearanceChange, setSignal, setTheme } from "../shell/theme";
import { field, runAction, successBox } from "../ui";

/**
 * `#/settings`: how the app looks, online mode's server address, and the assistant's Ollama. The
 * look is kept in the window (localStorage); the addresses in settings.json, by the main process.
 */
export async function settingsPage({ root, signal }: PageContext): Promise<void> {
  const inner = h("div", { class: "page-inner narrow" }, h("div", { class: "page-head" }, h("div", {}, h("h1", { class: "page-title" }, "Settings"))));
  root.append(inner);
  inner.append(appearanceCard());
  const maybeBridge = desktop();
  if (maybeBridge === null) {
    inner.append(h("section", { class: "settings-card" }, h("h2", {}, "Online mode"), h("p", {}, "The server's address and the assistant are set in the desktop app.")));
    return;
  }
  // A non-null copy: TypeScript forgets the check above inside the functions declared below.
  const bridge: DesktopBridge = maybeBridge;
  inner.append(await serverCard(bridge, signal), assistantSettingsCard(bridge, (await bridge.getSettings()).assistant));
}

function appearanceCard(): HTMLElement {
  const themes = h("div", { class: "seg sm", role: "group", "aria-label": "Theme" });
  const colours = h("div", { class: "seg sm", role: "group", "aria-label": "Signal colour" });
  const draw = (): void => {
    themes.replaceChildren(
      ...THEMES.map((theme) => {
        const button = h("button", { type: "button", "aria-pressed": currentTheme() === theme ? "true" : "false" }, theme === "dark" ? "Dark" : "Light");
        button.addEventListener("click", () => setTheme(theme));
        return button;
      }),
    );
    colours.replaceChildren(
      ...SIGNAL_COLOURS.map((colour) => {
        const button = h("button", { type: "button", "aria-pressed": currentSignal() === colour ? "true" : "false" }, colour[0]?.toUpperCase() + colour.slice(1));
        button.addEventListener("click", () => setSignal(colour));
        return button;
      }),
    );
  };
  onAppearanceChange(draw);
  draw();
  return h(
    "section",
    { class: "settings-card" },
    h("h2", {}, "Appearance"),
    h("div", { class: "setting-row" }, h("div", { class: "text" }, h("span", { class: "field-label" }, "Theme"), h("span", {}, "Also the switch in the title bar.")), themes),
    h("div", { class: "setting-row" }, h("div", { class: "text" }, h("span", { class: "field-label" }, "Signal colour"), h("span", {}, "The colour of a 1: wires, lit inputs and outputs.")), colours),
  );
}

async function serverCard(bridge: DesktopBridge, signal: AbortSignal): Promise<HTMLElement> {
  let settings = await bridge.getSettings();
  const address = h("input", { type: "url", class: "input lg", value: settings.apiUrl, required: true, spellcheck: "false", placeholder: settings.defaultApiUrl });
  const save = h("button", { type: "submit", class: "btn lg primary" }, "Save");
  const reset = h("button", { type: "button", class: "btn lg" }, "Use the default");
  const message = h("div");
  const status = h("p", { class: "status-line", "aria-live": "polite" });

  const drawStatus = (): void => {
    const state = serverState();
    if (state.kind === "checking") status.replaceChildren(h("span", { class: "led" }), "Checking the server…");
    else if (state.kind === "online") status.replaceChildren(h("span", { class: "led ok" }), `Server online at ${state.url} (storage: ${state.memoryOnly ? "memory only, so circuits are lost when it stops" : "PostgreSQL"}).`);
    else if (state.kind === "unhealthy") status.replaceChildren(h("span", { class: "led bad" }), `The server at ${state.url} answers, but its database or Redis doesn't.`);
    else status.replaceChildren(h("span", { class: "led bad" }), `Can't reach the server at ${state.url}. Start it with `, h("code", {}, "npm run start:api"), ", or use offline mode.");
  };
  on("status", drawStatus, signal);
  drawStatus();
  void checkServer();

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
      await checkServer();
      emit("server");
    });
  }

  const form = h(
    "form",
    { class: "form" },
    field("Server address", address, `The CircuitLab API that online mode uses. The default, ${settings.defaultApiUrl}, is the one npm run start:api starts on this computer.`),
    settings.fromEnvironment ? h("p", { class: "alert" }, "CIRCUITLAB_API_URL is set, so this run uses its address whatever is saved here.") : null,
    message,
    h("div", { class: "form-actions" }, save, reset),
    status,
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void apply(address.value, save);
  });
  reset.addEventListener("click", () => void apply(null, reset));
  return h("section", { class: "settings-card" }, h("h2", {}, "Online mode"), form);
}
