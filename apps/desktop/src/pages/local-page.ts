import { createCircuit } from "../api";
import { offlineBackend } from "../circuit/backend";
import { simulatorSection } from "../circuit/simulator";
import { truthTableSection } from "../circuit/truth-table";
import { desktop, requireDesktop, unwrap } from "../desktop";
import { positionsFor, savePositions } from "../diagram/saved-positions";
import { appendAll, fileNameFor, h, plural } from "../dom";
import { closeDocument, fileName, openWithDialog, positionsKey, restoreDocument, setDocument, type LocalDocument } from "../offline/document";
import { navigate, reload, type PageContext } from "../router";
import { currentSession } from "../session";
import { loading, runAction } from "../ui";

/** `#/local`: the netlist file open in offline mode. */
export async function localPage({ root, signal }: PageContext): Promise<void> {
  if (desktop() === null) {
    root.append(h("div", { class: "card empty-state" }, h("h1", {}, "Offline mode"), h("p", {}, "Offline mode works in the desktop app, not in a browser tab.")));
    return;
  }
  root.append(loading());
  const openFile = await restoreDocument();
  root.replaceChildren();
  if (openFile === null) {
    root.append(noFileOpen());
    return;
  }

  const message = h("div");
  const key = positionsKey(openFile.path);
  const backend = offlineBackend(openFile);
  appendAll(
    root,
    header(openFile, message),
    message,
    openFile.path === null ? h("p", { class: "alert alert-info" }, "This circuit isn't saved in a file yet. Use “Save…” to keep it.") : null,
    simulatorSection(openFile.circuit, backend, key, signal),
    truthTableSection(openFile.circuit, backend, signal),
  );
}

function header(openFile: LocalDocument, message: HTMLElement): HTMLElement {
  const { circuit } = openFile;

  const saveAs = h("button", {}, openFile.path === null ? "Save…" : "Save as…");
  saveAs.addEventListener("click", () => {
    void runAction(saveAs, message, async () => {
      const path = unwrap(await requireDesktop().saveFile(null, openFile.text, fileNameFor(circuit.name)));
      if (path === null) return; // cancelled
      // The gate positions you arranged move with the file to its new name.
      savePositions(positionsKey(path), positionsFor(positionsKey(openFile.path), circuit.gates, circuit.wires));
      setDocument({ ...openFile, path });
      reload();
    });
  });

  const open = h("button", {}, "Open another…");
  open.addEventListener("click", () => {
    void runAction(open, message, async () => {
      if (await openWithDialog()) reload();
    });
  });

  const close = h("button", {}, "Close");
  close.addEventListener("click", () => {
    closeDocument();
    navigate("/");
  });

  // From offline to online: put a copy of this file's circuit in your account on the server.
  const upload = h("button", {}, "Upload to my account");
  upload.addEventListener("click", () => {
    void runAction(upload, message, async () => {
      const created = await createCircuit({ name: circuit.name, gates: circuit.gates, wires: circuit.wires });
      savePositions(created.circuit.id, positionsFor(positionsKey(openFile.path), circuit.gates, circuit.wires));
      navigate(`/circuits/${encodeURIComponent(created.circuit.id)}`);
    });
  });

  return h(
    "div",
    { class: "page-header" },
    h(
      "div",
      {},
      h("div", { class: "circuit-title" }, h("h1", {}, circuit.name), h("span", { class: "badge" }, "Offline")),
      h(
        "div",
        { class: "meta" },
        h("span", { title: openFile.path ?? "" }, openFile.path === null ? "Not saved yet" : fileName(openFile.path)),
        h("span", {}, `${plural(circuit.gates.length, "gate")}, ${plural(circuit.wires.length, "wire")}`),
        openFile.path === null ? null : h("span", { class: "path" }, openFile.path),
      ),
    ),
    h(
      "div",
      { class: "actions" },
      h("a", { class: "button", href: "#/local/draw" }, "Edit drawing"),
      h("a", { class: "button", href: "#/local/netlist" }, "Edit netlist"),
      saveAs,
      currentSession() === null ? null : upload,
      open,
      close,
    ),
  );
}

function noFileOpen(): HTMLElement {
  const message = h("div");
  const open = h("button", { class: "primary" }, "Open netlist file…");
  open.addEventListener("click", () => {
    void runAction(open, message, async () => {
      if (await openWithDialog()) reload();
    });
  });
  return h(
    "div",
    { class: "card empty-state" },
    h("h1", {}, "No file open"),
    h("p", { class: "muted" }, "Open a netlist file, start a new circuit, or try an example from the home screen."),
    h("div", { class: "form-actions" }, open, h("a", { class: "button", href: "#/local/new" }, "New circuit"), h("a", { class: "button", href: "#/" }, "Home")),
    message,
  );
}
