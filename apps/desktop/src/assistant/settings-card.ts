import type { AssistantSettings, AssistantStatus, DesktopBridge } from "../../electron/bridge";
import { normalizeOllamaUrl } from "../../electron/helpers";
import { unwrap } from "../desktop";
import { h } from "../dom";
import { errorBox, field, loading, runAction, successBox } from "../ui";

/**
 * The assistant's part of the Settings screen: where Ollama is, and which of its models to use.
 * The models listed are the ones Ollama says it has, so there is nothing to type.
 */
export function assistantSettingsCard(bridge: DesktopBridge, initial: AssistantSettings): HTMLElement {
  let settings = initial;

  const address = h("input", { type: "url", value: settings.url, required: true, spellcheck: "false", placeholder: settings.defaultUrl });
  const save = h("button", { type: "submit", class: "primary" }, "Save address");
  const reset = h("button", { type: "button" }, "Use Ollama's default");
  const model = h("select", { "aria-label": "Model" });
  const status = h("div");
  const message = h("div");

  /** Asks Ollama what it has, and shows it. */
  async function refresh(): Promise<void> {
    status.replaceChildren(loading("Asking Ollama…"));
    show(await bridge.assistantStatus());
  }

  function show(found: AssistantStatus): void {
    fillModels(found);
    if (found.models.length === 0) {
      status.replaceChildren(h("p", { class: "alert alert-warning" }, found.problem ?? "Ollama has no models."));
      return;
    }
    status.replaceChildren(
      successBox(`Ollama answers at ${found.url}${found.local ? ", on this computer" : " (not this computer: what you ask the assistant is sent there)"}. ${found.models.length === 1 ? "It has 1 model." : `It has ${found.models.length} models.`}`),
      ...(found.problem === undefined ? [] : [h("p", { class: "alert alert-warning" }, found.problem)]),
    );
  }

  function fillModels(found: AssistantStatus): void {
    const options = [h("option", { value: "" }, "Automatic: the newest one Ollama lists")];
    for (const entry of found.models) {
      const details = [entry.parameterSize, `${entry.sizeGigabytes} GB`].filter((part) => part !== undefined).join(", ");
      options.push(h("option", { value: entry.name }, `${entry.name} (${details})`));
    }
    // A model chosen earlier that Ollama no longer has stays visible, so that it's clear what is saved.
    if (settings.savedModel !== null && !found.models.some((entry) => entry.name === settings.savedModel)) {
      options.push(h("option", { value: settings.savedModel }, `${settings.savedModel} (not installed)`));
    }
    model.replaceChildren(...options);
    model.value = settings.savedModel ?? "";
    model.disabled = found.models.length === 0 && settings.savedModel === null;
  }

  async function applyAddress(text: string | null, button: HTMLButtonElement): Promise<void> {
    await runAction(button, message, async () => {
      const wanted = text === null ? null : normalizeOllamaUrl(text); // the main process checks it again when saving
      settings = unwrap(await bridge.setAssistant({ url: wanted })).assistant;
      address.value = settings.url;
      message.replaceChildren(successBox(settings.fromEnvironment ? "Saved." : `Saved. The assistant now looks for Ollama at ${settings.url}.`));
      await refresh();
    });
  }

  model.addEventListener("change", () => {
    message.replaceChildren();
    void (async () => {
      try {
        settings = unwrap(await bridge.setAssistant({ model: model.value === "" ? null : model.value })).assistant;
        message.replaceChildren(successBox(settings.savedModel === null ? "Saved. The assistant uses the newest model." : `Saved. The assistant uses ${settings.savedModel}.`));
      } catch (error) {
        message.replaceChildren(errorBox(error));
      }
    })();
  });

  const form = h(
    "form",
    { class: "form" },
    field("Ollama address", address, `Where Ollama listens. The default, ${settings.defaultUrl}, is Ollama on this computer.`),
    settings.fromEnvironment ? h("p", { class: "alert alert-info" }, "CIRCUITLAB_OLLAMA_URL is set, so this run uses its address whatever is saved here.") : null,
    h("div", { class: "form-actions" }, save, reset),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void applyAddress(address.value, save);
  });
  reset.addEventListener("click", () => void applyAddress(null, reset));

  const recheck = h("button", { type: "button" }, "Check again");
  recheck.addEventListener("click", () => void refresh());

  void refresh();
  return h(
    "section",
    { class: "card settings-card" },
    h("h2", {}, "Assistant"),
    h(
      "p",
      { class: "muted" },
      "The assistant drafts circuits from a description, using a language model that runs in Ollama (ollama.com). It works in the netlist editor, online and offline. The model runs on your computer and the requests go to the address below; nothing goes to CircuitLab's server.",
    ),
    form,
    h("div", { class: "form" }, field("Model", model, "Any model you have downloaded in Ollama. A bigger one makes fewer mistakes, and is slower."), h("div", { class: "form-actions" }, recheck)),
    status,
    message,
  );
}
