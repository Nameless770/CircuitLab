import type { CircuitInput } from "@circuitlab/api-contract";
import type { LocalCircuit } from "../../electron/bridge";
import {
  checkCircuit,
  checkNetlist,
  createCircuit,
  createCircuitFromNetlist,
  getCircuit,
  getNetlist,
  replaceCircuit,
  replaceCircuitWithNetlist,
} from "../api";
import { desktop, requireDesktop, unwrap } from "../desktop";
import { positionsFor, savePositions } from "../diagram/saved-positions";
import { fileNameFor, h, plural } from "../dom";
import { draftFromCircuit, emptyDraft, toCircuitInput, type Draft } from "../editor/draft";
import { openEditor } from "../editor/editor-view";
import { NETLIST_TEMPLATE, openNetlistEditor } from "../editor/netlist-view";
import { positionsKey, restoreDocument, saveInLibrary, setDocument, type DocumentSource, type LocalDocument } from "../offline/document";
import type { PageContext } from "../router";
import { loading } from "../ui";
import { requireSignIn } from "./account";

/**
 * The pages that open an editor. Each says where the circuit comes from and how to check and
 * save it: through the API (online), or into the app's library or a netlist file (offline).
 */

/** "Looks good: 5 gates, inputs A, B → outputs S, C." */
function describeCheck(summary: { readonly inputs: readonly string[]; readonly outputs: readonly string[]; readonly feedbackLoop: readonly string[] | null }, gates: number): string {
  const loop = summary.feedbackLoop === null ? "" : ` It has a feedback loop (${summary.feedbackLoop.join(" → ")}), so it will be simulated step by step.`;
  const inputs = summary.inputs.length === 0 ? "no inputs" : `inputs ${summary.inputs.join(", ")}`;
  const outputs = summary.outputs.length === 0 ? "no outputs" : `outputs ${summary.outputs.join(", ")}`;
  return `Looks good: ${plural(gates, "gate")}, ${inputs} → ${outputs}.${loop}`;
}

const circuitUrl = (id: string): string => `/circuits/${encodeURIComponent(id)}`;

async function checkOnline(input: CircuitInput): Promise<string> {
  const report = await checkCircuit(input);
  return describeCheck(report.summary, report.summary.gates);
}

async function checkOnlineNetlist(text: string): Promise<string> {
  const report = await checkNetlist(text);
  return describeCheck(report.summary, report.summary.gates);
}

// ---------------------------------------------------------------------------------------------
// Online: circuits in your account

/** `#/circuits/new/draw` */
export function newDrawingPage(context: PageContext): void {
  if (!requireSignIn(context.root)) return;
  openEditor(context, {
    title: "New circuit",
    draft: emptyDraft(),
    saveLabel: "Save to my account",
    cancelPath: "/circuits/new",
    check: checkOnline,
    async save(draft) {
      const created = await createCircuit(toCircuitInput(draft));
      savePositions(created.circuit.id, draft.positions);
      return circuitUrl(created.circuit.id);
    },
  });
}

/** `#/circuits/:id/edit` */
export async function editDrawingPage(context: PageContext): Promise<void> {
  if (!requireSignIn(context.root)) return;
  context.root.append(loading());
  const { circuit, etag } = await getCircuit(context.params["id"] ?? "", context.signal);
  context.root.replaceChildren();
  openEditor(context, {
    title: `Edit: ${circuit.name}`,
    draft: draftFromCircuit(circuit, positionsFor(circuit.id, circuit.gates, circuit.wires)),
    saveLabel: "Save",
    cancelPath: circuitUrl(circuit.id),
    check: checkOnline,
    async save(draft) {
      // If-Match: if someone else saved in the meantime, the API refuses (412) instead of losing their work.
      await replaceCircuit(circuit.id, toCircuitInput(draft), etag);
      savePositions(circuit.id, draft.positions);
      return circuitUrl(circuit.id);
    },
  });
}

/** `#/circuits/new/netlist` */
export function newNetlistPage(context: PageContext): void {
  if (!requireSignIn(context.root)) return;
  openNetlistEditor(context, {
    title: "New circuit from a netlist",
    text: NETLIST_TEMPLATE,
    saveLabel: "Save to my account",
    cancelPath: "/circuits/new",
    check: checkOnlineNetlist,
    async save(text) {
      const created = await createCircuitFromNetlist(text);
      return circuitUrl(created.circuit.id);
    },
  });
}

/** `#/circuits/:id/netlist` */
export async function editNetlistPage(context: PageContext): Promise<void> {
  if (!requireSignIn(context.root)) return;
  context.root.append(loading());
  const id = context.params["id"] ?? "";
  const [{ circuit, etag }, text] = await Promise.all([getCircuit(id, context.signal), getNetlist(id, context.signal)]);
  context.root.replaceChildren();
  openNetlistEditor(context, {
    title: `Edit netlist: ${circuit.name}`,
    text,
    saveLabel: "Save",
    cancelPath: circuitUrl(id),
    check: checkOnlineNetlist,
    async save(newText) {
      await replaceCircuitWithNetlist(id, newText, circuit.description, etag);
      return circuitUrl(id);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Offline: circuits in the app's library, or netlist files

function needsDesktop(root: HTMLElement): boolean {
  if (desktop() !== null) return false;
  root.append(h("div", { class: "card empty-state" }, h("h1", {}, "Offline mode"), h("p", {}, "Offline mode works in the desktop app, not in a browser tab.")));
  return true;
}

async function checkLocal(input: CircuitInput): Promise<string> {
  const { circuit } = unwrap(await requireDesktop().toNetlist({ name: input.name, gates: input.gates, wires: input.wires }));
  return describeCheck(circuit.summary, circuit.gates.length);
}

/**
 * Where offline work is saved: a circuit opened from a file goes back to that file; everything
 * else goes into the library, with no file dialog. Resolves to the saved circuit, now the open one.
 */
async function saveOffline(text: string, description: string, source: DocumentSource): Promise<LocalDocument> {
  if (source.kind === "file") {
    const circuit = unwrap(await requireDesktop().parse(text)); // never write a file that doesn't read back
    unwrap(await requireDesktop().saveFile(source.path, text, fileNameFor(circuit.name)));
    const saved: LocalDocument = { source, text, circuit };
    setDocument(saved);
    return saved;
  }
  return saveInLibrary(text, description, source.kind === "library" ? source.id : undefined);
}

/** Saves a drawing: turned into netlist text first, which also checks it. */
async function saveDrawing(draft: Draft, source: DocumentSource): Promise<string> {
  const { text } = unwrap(await requireDesktop().toNetlist({ name: draft.name.trim(), gates: draft.gates, wires: draft.wires }));
  const saved = await saveOffline(text, draft.description, source);
  savePositions(positionsKey(saved.source), draft.positions);
  return "/local"; // straight to the circuit's page, to try it
}

/** `#/local/new` */
export function newLocalDrawingPage(context: PageContext): void {
  if (needsDesktop(context.root)) return;
  openEditor(context, {
    title: "New offline circuit",
    draft: emptyDraft(),
    saveLabel: "Save",
    saveHint: "Saves it in your library, inside the app",
    cancelPath: "/library",
    check: checkLocal,
    save: (draft) => saveDrawing(draft, { kind: "new" }),
  });
}

/** `#/local/draw` */
export async function editLocalDrawingPage(context: PageContext): Promise<void> {
  if (needsDesktop(context.root)) return;
  const openFile = await restoreDocument();
  if (openFile === null) {
    context.root.append(h("p", {}, "No circuit is open. ", h("a", { href: "#/library" }, "Go to the library")));
    return;
  }
  const { circuit, source } = openFile;
  const inFile = source.kind === "file";
  openEditor(context, {
    title: `Edit: ${circuit.name}`,
    draft: draftFromCircuit(
      { ...circuit, ...(openFile.description !== undefined && { description: openFile.description }) },
      positionsFor(positionsKey(source), circuit.gates, circuit.wires),
    ),
    saveLabel: "Save",
    saveHint: inFile ? "Saves it back to its file" : "Saves it in your library, inside the app",
    // A netlist file has no place for a description, so files don't get the field.
    showDescription: !inFile,
    cancelPath: "/local",
    // Honest warning: the file is rewritten from the drawing, so hand-written comments are lost.
    ...(inFile && openFile.text.includes("#") && { note: "Saving rewrites the file from the drawing, so the comments in it won't be kept. To keep them, use “Edit netlist” instead." }),
    check: checkLocal,
    save: (draft) => saveDrawing(draft, source),
  });
}

/** `#/local/netlist` */
export async function editLocalNetlistPage(context: PageContext): Promise<void> {
  if (needsDesktop(context.root)) return;
  const openFile = await restoreDocument();
  if (openFile === null) {
    context.root.append(h("p", {}, "No circuit is open. ", h("a", { href: "#/library" }, "Go to the library")));
    return;
  }
  openNetlistEditor(context, {
    title: `Edit netlist: ${openFile.circuit.name}`,
    text: openFile.text,
    saveLabel: "Save",
    cancelPath: "/local",
    async check(text) {
      const circuit: LocalCircuit = unwrap(await requireDesktop().parse(text));
      return describeCheck(circuit.summary, circuit.gates.length);
    },
    async save(text) {
      await saveOffline(text, openFile.description ?? "", openFile.source);
      return "/local";
    },
  });
}
