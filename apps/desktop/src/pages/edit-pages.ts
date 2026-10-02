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
import { positionsKey, restoreDocument, setDocument } from "../offline/document";
import type { PageContext } from "../router";
import { loading } from "../ui";
import { requireSignIn } from "./account";

/**
 * The pages that open an editor. Each says where the circuit comes from and how to check and
 * save it: through the API (online), or into a netlist file (offline).
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
// Offline: netlist files on this computer

function needsDesktop(root: HTMLElement): boolean {
  if (desktop() !== null) return false;
  root.append(h("div", { class: "card empty-state" }, h("h1", {}, "Offline mode"), h("p", {}, "Offline mode works in the desktop app, not in a browser tab.")));
  return true;
}

async function checkLocal(input: CircuitInput): Promise<string> {
  const { circuit } = unwrap(await requireDesktop().toNetlist({ name: input.name, gates: input.gates, wires: input.wires }));
  return describeCheck(circuit.summary, circuit.gates.length);
}

/** Writes the drawing to a file (asking where if `path` is null) and makes it the open document. */
async function saveDrawingToFile(draft: Draft, path: string | null): Promise<string | null> {
  const bridge = requireDesktop();
  const { circuit, text } = unwrap(await bridge.toNetlist({ name: draft.name.trim(), gates: draft.gates, wires: draft.wires }));
  const savedPath = unwrap(await bridge.saveFile(path, text, fileNameFor(draft.name)));
  if (savedPath === null) return null;
  setDocument({ path: savedPath, text, circuit });
  savePositions(positionsKey(savedPath), draft.positions);
  return "/local";
}

/** `#/local/new` */
export function newLocalDrawingPage(context: PageContext): void {
  if (needsDesktop(context.root)) return;
  openEditor(context, {
    title: "New offline circuit",
    draft: emptyDraft(),
    saveLabel: "Save file…",
    cancelPath: "/",
    check: checkLocal,
    save: (draft) => saveDrawingToFile(draft, null),
  });
}

/** `#/local/draw` */
export async function editLocalDrawingPage(context: PageContext): Promise<void> {
  if (needsDesktop(context.root)) return;
  const openFile = await restoreDocument();
  if (openFile === null) {
    context.root.append(h("p", {}, "No file is open. ", h("a", { href: "#/" }, "Back to the home screen")));
    return;
  }
  const { circuit, path } = openFile;
  openEditor(context, {
    title: `Edit: ${circuit.name}`,
    draft: draftFromCircuit(circuit, positionsFor(positionsKey(path), circuit.gates, circuit.wires)),
    saveLabel: path === null ? "Save file…" : "Save",
    cancelPath: "/local",
    // Honest warning: the file is rewritten from the drawing, so hand-written comments are lost.
    ...(path !== null && openFile.text.includes("#") && { note: "Saving rewrites the file from the drawing, so the comments in it won't be kept. To keep them, use “Edit netlist” instead." }),
    check: checkLocal,
    save: (draft) => saveDrawingToFile(draft, path),
  });
}

/** `#/local/netlist` */
export async function editLocalNetlistPage(context: PageContext): Promise<void> {
  if (needsDesktop(context.root)) return;
  const openFile = await restoreDocument();
  if (openFile === null) {
    context.root.append(h("p", {}, "No file is open. ", h("a", { href: "#/" }, "Back to the home screen")));
    return;
  }
  const parse = async (text: string): Promise<LocalCircuit> => unwrap(await requireDesktop().parse(text));
  openNetlistEditor(context, {
    title: `Edit netlist: ${openFile.circuit.name}`,
    text: openFile.text,
    saveLabel: openFile.path === null ? "Save file…" : "Save",
    cancelPath: "/local",
    async check(text) {
      const circuit = await parse(text);
      return describeCheck(circuit.summary, circuit.gates.length);
    },
    async save(text) {
      const circuit = await parse(text); // never write a file that doesn't read back
      const path = unwrap(await requireDesktop().saveFile(openFile.path, text, fileNameFor(circuit.name)));
      if (path === null) return null;
      setDocument({ path, text, circuit });
      return "/local";
    },
  });
}
