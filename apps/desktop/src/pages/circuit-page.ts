import type { CircuitResource, Visibility } from "@circuitlab/api-contract";
import { createCircuit, deleteCircuit, getCircuit, getNetlist, updateCircuit } from "../api";
import { onlineBackend } from "../circuit/backend";
import { simulatorSection } from "../circuit/simulator";
import { truthTableSection } from "../circuit/truth-table";
import { forgetPositions, positionsFor, savePositions } from "../diagram/saved-positions";
import { appendAll, fileNameFor, formatDate, h, plural, saveFile } from "../dom";
import { jobsPanel } from "../online/jobs";
import { runsSection } from "../online/runs";
import { sharingSection } from "../online/sharing";
import { navigate, reload, type PageContext } from "../router";
import { currentSession } from "../session";
import { field, loading, runAction, successBox } from "../ui";

/** `#/circuits/:id`: one circuit on the server. */
export async function circuitPage({ root, params, signal }: PageContext): Promise<void> {
  root.append(loading());
  const { circuit, etag } = await getCircuit(params["id"] ?? "", signal); // a failure (e.g. 404) is shown by the router
  root.replaceChildren();

  const session = currentSession();
  const signedIn = session !== null;
  const isOwner = session?.user.id === circuit.owner.id;
  const message = h("div");
  const backend = onlineBackend(circuit);

  appendAll(
    root,
    titleBlock(circuit, signedIn, isOwner, etag, message),
    message,
    simulatorSection(circuit, backend, circuit.id, signal),
    truthTableSection(circuit, backend, signal, signedIn ? jobsPanel(circuit, signal) : null),
    isOwner ? settingsSection(circuit, etag) : null,
    isOwner ? sharingSection(circuit, signal) : null,
    signedIn ? runsSection(circuit, isOwner, signal) : null,
  );
}

function titleBlock(circuit: CircuitResource, signedIn: boolean, isOwner: boolean, etag: string, message: HTMLElement): HTMLElement {
  const download = h("button", {}, "Download netlist");
  download.addEventListener("click", () => {
    void runAction(download, message, async () => {
      const netlist = await getNetlist(circuit.id);
      saveFile(new Blob([netlist], { type: "text/plain" }), `${fileNameFor(circuit.name)}.net`);
    });
  });

  // Copies the circuit into your own account, e.g. to change someone else's public circuit.
  const copy = h("button", {}, "Make a copy");
  copy.addEventListener("click", () => {
    void runAction(copy, message, async () => {
      const name = `Copy of ${circuit.name}`.slice(0, 200);
      const created = await createCircuit({ name, ...(circuit.description !== undefined && { description: circuit.description }), gates: circuit.gates, wires: circuit.wires });
      savePositions(created.circuit.id, positionsFor(circuit.id, circuit.gates, circuit.wires));
      navigate(`/circuits/${encodeURIComponent(created.circuit.id)}`);
    });
  });

  const remove = h("button", { class: "danger" }, "Delete");
  remove.addEventListener("click", () => {
    if (!confirm(`Delete “${circuit.name}”? This can't be undone.`)) return;
    void runAction(remove, message, async () => {
      await deleteCircuit(circuit.id, etag);
      forgetPositions(circuit.id);
      navigate("/circuits?scope=owned");
    });
  });

  const editLink = (path: string, label: string): HTMLElement => h("a", { class: "button", href: `#/circuits/${encodeURIComponent(circuit.id)}/${path}` }, label);
  const { summary } = circuit;

  return h(
    "div",
    {},
    h(
      "div",
      { class: "page-header" },
      h(
        "div",
        {},
        h(
          "div",
          { class: "circuit-title" },
          h("h1", {}, circuit.name),
          h("span", { class: circuit.visibility === "public" ? "badge public" : "badge" }, circuit.visibility === "public" ? "Public" : "Private"),
        ),
        h(
          "div",
          { class: "meta" },
          h("span", {}, `by ${circuit.owner.displayName}`),
          h("span", {}, `version ${circuit.version}`),
          h("span", {}, `updated ${formatDate(circuit.updatedAt)}`),
          h("span", {}, `${plural(summary.gates, "gate")}, ${plural(summary.wires, "wire")}`),
        ),
      ),
      h(
        "div",
        { class: "actions" },
        signedIn ? editLink("edit", "Edit drawing") : null,
        signedIn ? editLink("netlist", "Edit netlist") : null,
        download,
        signedIn ? copy : null,
        isOwner ? remove : null,
      ),
    ),
    circuit.description === undefined ? null : h("p", { class: "description-text" }, circuit.description),
    signedIn && !isOwner
      ? h("p", { class: "muted small" }, `${circuit.owner.displayName} owns this circuit. If they shared it with you as an editor you can change it; otherwise you can look, simulate, and make a copy.`)
      : null,
  );
}

/** Name, description and who can see it. Only the owner sees this card. */
function settingsSection(circuit: CircuitResource, etag: string): HTMLElement {
  const name = h("input", { type: "text", value: circuit.name, required: true, maxlength: 200 });
  const description = h("textarea", { rows: 3, maxlength: 2000 }, circuit.description ?? "");
  const visibility = h(
    "select",
    {},
    h("option", { value: "private", selected: circuit.visibility === "private" }, "Private: only me and the people I share it with"),
    h("option", { value: "public", selected: circuit.visibility === "public" }, "Public: anyone can see it (read-only)"),
  );
  const save = h("button", { type: "submit", class: "primary" }, "Save changes");
  const message = h("div");
  const form = h("form", { class: "form" }, field("Name", name), field("Description", description), field("Who can see it", visibility), message, h("div", { class: "form-actions" }, save));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void runAction(save, message, async () => {
      const text = description.value.trim();
      // A JSON Merge Patch: only what's sent changes; description null removes it.
      await updateCircuit(circuit.id, { name: name.value.trim(), description: text === "" ? null : text, visibility: visibility.value as Visibility }, etag);
      message.replaceChildren(successBox("Saved."));
      reload(); // show the new version (and get its new ETag)
    });
  });
  return h("section", { class: "card section" }, h("h2", {}, "Settings"), form);
}
