import type { CircuitResource, ShareResource, ShareRole } from "@circuitlab/api-contract";
import { listShares, shareCircuit, unshareCircuit } from "../api";
import { h } from "../dom";
import { errorBox, field, loading, runAction } from "../ui";

/** Who else can see the circuit. Only the owner sees this card (the API allows only them anyway). */
export function sharingSection(circuit: CircuitResource, signal: AbortSignal): HTMLElement {
  const list = h("div", {}, loading());
  const message = h("div");

  async function refresh(): Promise<void> {
    try {
      const { items } = await listShares(circuit.id, signal);
      list.replaceChildren(items.length === 0 ? h("p", { class: "muted" }, "Not shared with anyone yet.") : h("div", {}, items.map(shareRow)));
    } catch (error) {
      if (!signal.aborted) list.replaceChildren(errorBox(error));
    }
  }

  function shareRow(share: ShareResource): HTMLElement {
    const role = roleSelect(share.role);
    role.addEventListener("change", () => {
      // Sharing again with the same person changes their role.
      void shareCircuit(circuit.id, share.user.email, role.value as ShareRole).then(refresh, (error: unknown) => message.replaceChildren(errorBox(error)));
    });
    const remove = h("button", { class: "small danger" }, "Remove");
    remove.addEventListener("click", () => {
      void runAction(remove, message, async () => {
        await unshareCircuit(circuit.id, share.user.id);
        await refresh();
      });
    });
    return h("div", { class: "share-row" }, h("div", {}, h("strong", {}, share.user.displayName), h("div", { class: "muted small" }, share.user.email)), h("div", { class: "actions" }, role, remove));
  }

  const email = h("input", { type: "email", required: true, placeholder: "their@email.com", maxlength: 254 });
  const newRole = roleSelect("viewer");
  const add = h("button", { type: "submit", class: "primary" }, "Share");
  const form = h("form", { class: "inline-form" }, field("Email of their account", email), field("Role", newRole), add);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void runAction(add, message, async () => {
      await shareCircuit(circuit.id, email.value.trim(), newRole.value as ShareRole);
      email.value = "";
      await refresh();
    });
  });

  void refresh();
  return h(
    "section",
    { class: "card section" },
    h("h2", {}, "Sharing"),
    h("p", { class: "muted" }, "Viewers can look at the circuit and simulate it. Editors can also change it. Only you can delete it, share it, or make it public."),
    list,
    h("div", { class: "section" }, form),
    message,
  );
}

function roleSelect(selected: ShareRole): HTMLSelectElement {
  return h(
    "select",
    { "aria-label": "Role" },
    h("option", { value: "viewer", selected: selected === "viewer" }, "Viewer"),
    h("option", { value: "editor", selected: selected === "editor" }, "Editor"),
  );
}
