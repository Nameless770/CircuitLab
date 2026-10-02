import { createCircuit } from "../api";
import { offlineBackend } from "../circuit/backend";
import { simulatorSection } from "../circuit/simulator";
import { truthTableSection } from "../circuit/truth-table";
import { desktop, requireDesktop, unwrap } from "../desktop";
import { positionsFor, savePositions } from "../diagram/saved-positions";
import { appendAll, fileNameFor, formatDate, h, plural } from "../dom";
import {
  closeDocument,
  deleteFromLibrary,
  openWithDialog,
  positionsKey,
  restoreDocument,
  saveInLibrary,
  setDocument,
  type LocalDocument,
} from "../offline/document";
import { navigate, reload, type PageContext } from "../router";
import { currentSession } from "../session";
import { loading, runAction, successBox } from "../ui";

/** `#/local`: the circuit open in offline mode, from the library, a file, or not saved yet. */
export async function localPage({ root, signal }: PageContext): Promise<void> {
  if (desktop() === null) {
    root.append(h("div", { class: "card empty-state" }, h("h1", {}, "Offline mode"), h("p", {}, "Offline mode works in the desktop app, not in a browser tab.")));
    return;
  }
  root.append(loading());
  const openFile = await restoreDocument();
  root.replaceChildren();
  if (openFile === null) {
    root.append(nothingOpen());
    return;
  }

  const message = h("div");
  const backend = offlineBackend(openFile);
  appendAll(
    root,
    header(openFile, message),
    message,
    openFile.source.kind === "new"
      ? h("p", { class: "alert alert-info" }, "Not saved yet. “Save to library” keeps it in the app, and you'll find it on the Library page.")
      : null,
    openFile.description === undefined ? null : h("p", { class: "description-text" }, openFile.description),
    simulatorSection(openFile.circuit, backend, positionsKey(openFile.source), signal),
    truthTableSection(openFile.circuit, backend, signal),
  );
}

function header(openFile: LocalDocument, message: HTMLElement): HTMLElement {
  const { circuit, source } = openFile;
  const oldKey = positionsKey(source);
  /** The gate positions you arranged go along when the circuit is saved somewhere new. */
  const keepPositions = (newKey: string): void => savePositions(newKey, positionsFor(oldKey, circuit.gates, circuit.wires));

  // Into the library: a new circuit, or a copy of a file (the file itself is left as it is).
  const toLibrary = h("button", { class: source.kind === "new" ? "primary" : null }, "Save to library");
  toLibrary.addEventListener("click", () => {
    void runAction(toLibrary, message, async () => {
      const saved = await saveInLibrary(openFile.text, openFile.description);
      keepPositions(positionsKey(saved.source));
      reload();
    });
  });

  // Out to a .net file. For a library circuit that's a copy (it stays in the library); a new
  // circuit, or a file saved under a new name, becomes that file.
  const toFile = h("button", {}, source.kind === "file" ? "Save as…" : source.kind === "library" ? "Export as file…" : "Save as file…");
  toFile.addEventListener("click", () => {
    void runAction(toFile, message, async () => {
      const path = unwrap(await requireDesktop().saveFile(null, openFile.text, fileNameFor(circuit.name)));
      if (path === null) return; // cancelled
      if (source.kind === "library") {
        message.replaceChildren(successBox(`Exported to ${path}`));
        return;
      }
      keepPositions(positionsKey({ kind: "file", path }));
      setDocument({ ...openFile, source: { kind: "file", path } });
      reload();
    });
  });

  const remove = h("button", { class: "danger" }, "Delete");
  remove.addEventListener("click", () => {
    if (source.kind !== "library" || !confirm(`Delete “${circuit.name}” from your library? This can't be undone.`)) return;
    void runAction(remove, message, async () => {
      await deleteFromLibrary(source.id);
      navigate("/library");
    });
  });

  // From offline to online: put a copy of this circuit in your account on the server.
  const upload = h("button", {}, "Upload to my account");
  upload.addEventListener("click", () => {
    void runAction(upload, message, async () => {
      const created = await createCircuit({
        name: circuit.name,
        ...(openFile.description !== undefined && { description: openFile.description }),
        gates: circuit.gates,
        wires: circuit.wires,
      });
      keepPositions(created.circuit.id);
      navigate(`/circuits/${encodeURIComponent(created.circuit.id)}`);
    });
  });

  const close = h("button", {}, "Close");
  close.addEventListener("click", () => {
    closeDocument();
    navigate(source.kind === "library" ? "/library" : "/");
  });

  const badge =
    source.kind === "library"
      ? h("span", { class: "badge saved" }, "In your library")
      : source.kind === "file"
        ? h("span", { class: "badge" }, "File")
        : h("span", { class: "badge loop" }, "Not saved");
  const where =
    source.kind === "library"
      ? h("span", {}, openFile.updatedAt === undefined ? "saved" : `saved ${formatDate(openFile.updatedAt)}`)
      : source.kind === "file"
        ? h("span", { class: "path", title: source.path }, source.path)
        : h("span", {}, "not saved yet");

  return h(
    "div",
    { class: "page-header" },
    h(
      "div",
      {},
      h("div", { class: "circuit-title" }, h("h1", {}, circuit.name), badge),
      h("div", { class: "meta" }, where, h("span", {}, `${plural(circuit.gates.length, "gate")}, ${plural(circuit.wires.length, "wire")}`)),
    ),
    h(
      "div",
      { class: "actions" },
      h("a", { class: "button", href: "#/local/draw" }, "Edit drawing"),
      h("a", { class: "button", href: "#/local/netlist" }, "Edit netlist"),
      source.kind === "library" ? null : toLibrary,
      toFile,
      currentSession() === null ? null : upload,
      source.kind === "library" ? remove : null,
      close,
    ),
  );
}

function nothingOpen(): HTMLElement {
  const message = h("div");
  const open = h("button", {}, "Open netlist file…");
  open.addEventListener("click", () => {
    void runAction(open, message, async () => {
      if (await openWithDialog()) reload();
    });
  });
  return h(
    "div",
    { class: "card empty-state" },
    h("h1", {}, "Nothing open"),
    h("p", { class: "muted" }, "Open a circuit from your library, start a new one, or open a netlist file."),
    h(
      "div",
      { class: "form-actions" },
      h("a", { class: "button primary", href: "#/library" }, "Library"),
      h("a", { class: "button", href: "#/local/new" }, "New circuit"),
      open,
    ),
    message,
  );
}
