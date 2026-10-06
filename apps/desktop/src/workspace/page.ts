import type { Bit } from "@circuitlab/engine";
import { checkCircuit } from "../api";
import { closeAssistant, offerAssistantDock, openAssistant } from "../assistant/drawer";
import { desktop, requireDesktop, unwrap } from "../desktop";
import { formatDate, h, plural } from "../dom";
import { toCircuitInput } from "../editor/draft";
import { navigate, redirect, reload, type Page, type PageContext } from "../router";
import { currentSession } from "../session";
import { newCircuit, openNetlistFile, setWorkspaceHooks } from "../shell/commands";
import { toast } from "../shell/toast";
import { errorDetails, errorMessage } from "../ui";
import { createCanvas, type Canvas } from "./canvas";
import type { Part, Ws } from "./context";
import { renderInspector } from "./inspector";
import { createNetlistStage, type NetlistStage } from "./netlist-stage";
import { createSimulator } from "./simulator";
import {
  closeDoc,
  copyToLibrary,
  currentDoc,
  deleteDoc,
  drawingChanged,
  exportNetlist,
  onDocChange,
  restoreDoc,
  saveDoc,
  saveHint,
  saveLabel,
  uploadToAccount,
  type Mode,
  type OpenDoc,
} from "./store";
import { describeSummary } from "./summary";
import { createTable } from "./table";

/**
 * `#/workspace`: the open circuit, in one of three modes (Simulate, Draw, Netlist), with the truth
 * table in a drawer underneath and the inspector on the right. See workspace/store.ts for what
 * "the open circuit" is.
 */
export async function workspacePage({ root, signal }: PageContext): Promise<void> {
  root.classList.add("fixed");
  const doc = currentDoc() ?? (await restoreDoc());
  if (signal.aborted) return;
  if (doc === null) {
    root.classList.remove("fixed");
    root.append(nothingOpen());
    return;
  }
  mount(root, doc, signal);
}

/**
 * The addresses that open a circuit, then show it: `#/circuits/123`, `#/library/abc`, `#/local/new`,
 * ... Each loads (or makes) the circuit, chooses a mode, and moves on to `#/workspace`.
 */
export function enter(load: (context: PageContext) => Promise<OpenDoc | null> | OpenDoc | null, mode?: Mode): Page {
  return async (context) => {
    context.root.append(h("p", { class: "page-inner loading" }, "Opening…"));
    const opened = await load(context); // a failure (a circuit that doesn't exist) is shown by the router
    if (context.signal.aborted) return;
    if (opened !== null && mode !== undefined) opened.mode = mode;
    redirect(currentDoc() === null ? "/" : "/workspace");
  };
}

function nothingOpen(): HTMLElement {
  const newButton = h("button", { type: "button", class: "btn lg primary" }, "New circuit");
  newButton.addEventListener("click", () => newCircuit());
  const open = h("button", { type: "button", class: "btn lg" }, "Open netlist file…");
  open.addEventListener("click", () => void openNetlistFile());
  const library = h("button", { type: "button", class: "btn lg" }, "Library");
  library.addEventListener("click", () => navigate("/library"));
  return h(
    "div",
    { class: "page-inner" },
    h(
      "div",
      { class: "empty-box" },
      h("h2", {}, "Nothing open"),
      h("p", {}, "Open a circuit from your library, start a new one, or open a netlist file."),
      h("div", { class: "form-actions" }, newButton, library, desktop() === null ? null : open),
    ),
  );
}

function mount(root: HTMLElement, doc: OpenDoc, signal: AbortSignal): void {
  const head = h("div", { class: "ws-head" });
  const stage = h("div", { class: "ws-stage" });
  // The right-hand column has two tabs: the details of what you're doing (the inputs and outputs,
  // the selected gate, the netlist cheat sheet), and the assistant (desktop app only).
  const details = h("div", { class: "ins-body" });
  const assistantSpot = h("div", { class: "ins-assistant", hidden: true });
  const tabs = h("div", { class: "seg sm fill", role: "group", "aria-label": "Right-hand panel" });
  const hasAssistant = desktop() !== null;
  const inspector = h("aside", { class: "inspector", "aria-label": "Inspector" }, hasAssistant ? h("div", { class: "ins-tabs" }, tabs) : null, details, assistantSpot);
  let canvas: Canvas | null = null;
  let netStage: NetlistStage | null = null;

  const ws: Ws = {
    doc,
    signal,
    selection: null,
    problemGates: new Set(),
    drawCheck: null,
    netCheck: null,
    nameError: null,
    last: null,
    simStatus: { kind: "waiting", text: "Simulating…" },
    refresh(...parts: Part[]) {
      for (const part of new Set(parts)) {
        if (part === "head") renderHead();
        if (part === "stage") renderStage();
        if (part === "diagram") canvas?.redraw();
        if (part === "inspector") renderInspectorPart();
        if (part === "table") table.highlight();
      }
    },
    resimulate() {
      simulator.run(false);
    },
  };
  const simulator = createSimulator(ws);
  const table = createTable(ws, { pickRow: (inputs) => setInputs(inputs) });

  const body = h("div", { class: "ws-body" }, h("div", { class: "ws-main" }, stage, table.element), inspector);
  root.append(h("div", { class: "ws" }, head, body));

  // ---- the switches -----------------------------------------------------------------------------

  function toggleInput(id: string): void {
    if (!(id in doc.inputs)) return;
    doc.inputs[id] = doc.inputs[id] === 1 ? 0 : 1;
    renderInspectorPart(); // the switch moves at once; the lamps follow when the answer comes
    table.highlight();
    simulator.run(true);
  }

  function setInputs(inputs: Record<string, Bit>): void {
    doc.inputs = { ...doc.inputs, ...inputs };
    renderInspectorPart();
    table.highlight();
    simulator.run(true);
  }

  function reset(): void {
    for (const id of Object.keys(doc.inputs)) doc.inputs[id] = 0;
    doc.state = undefined;
    doc.steps = 0;
    renderInspectorPart();
    table.highlight();
    simulator.run(false);
  }

  /** After the circuit itself changed: its table and its simulation are out of date (soon, not at every key press). */
  let pending = 0;
  function circuitChanged(): void {
    clearTimeout(pending);
    pending = window.setTimeout(() => {
      table.reload();
      simulator.run(false);
    }, 150);
  }

  // ---- the header -------------------------------------------------------------------------------

  let menuOpen = false;

  function renderHead(): void {
    const { draft, source } = doc;
    const [badgeText, badgeClass] = badgeOf(doc);
    const meta = `${plural(draft.gates.length, "gate")} · ${plural(draft.wires.length, "wire")} · ${whereOf(doc)}${doc.dirty && source.kind !== "new" && source.kind !== "new-server" ? " · edited" : ""}`;
    const name = draft.name.trim() === "" ? "Untitled circuit" : draft.name;

    const modes = h("div", { class: "seg", role: "group", "aria-label": "Mode" });
    for (const [mode, label, key] of [
      ["sim", "Simulate", "Ctrl 1"],
      ["draw", "Draw", "Ctrl 2"],
      ["net", "Netlist", "Ctrl 3"],
    ] as const) {
      const button = h("button", { type: "button", "aria-pressed": doc.mode === mode ? "true" : "false", title: key }, label);
      button.addEventListener("click", () => void setMode(mode));
      modes.append(button);
    }

    const save = h("button", { type: "button", class: doc.dirty ? "btn primary" : "btn", title: saveHint(doc) }, saveLabel(doc));
    save.addEventListener("click", () => void saveNow());
    const exportButton = h("button", { type: "button", class: "btn export" }, "Export .net");
    exportButton.addEventListener("click", () => void exportNow());
    const more = h("button", { type: "button", class: "btn", "aria-haspopup": "menu", "aria-expanded": menuOpen ? "true" : "false" }, "More ▾");
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      menuOpen = !menuOpen;
      renderHead();
    });
    const close = h("button", { type: "button", class: "btn ghost" }, "Close");
    close.addEventListener("click", closeNow);

    head.replaceChildren(
      h(
        "div",
        { class: "ws-title" },
        h("div", { class: "ws-title-row" }, h("span", { class: "ws-name", title: name }, name), h("span", { class: `badge ${badgeClass}`.trim() }, badgeText)),
        h("span", { class: "ws-meta", title: meta }, meta),
      ),
      modes,
      h("div", { class: "ws-actions" }, save, exportButton, more, close, menuOpen ? moreMenu() : null),
    );
  }

  function moreMenu(): HTMLElement {
    const menu = h("div", { class: "menu", role: "menu" });
    const item = (label: string, run: () => void | Promise<void>, extra = ""): void => {
      const button = h("button", { type: "button", role: "menuitem", class: extra || null }, label);
      button.addEventListener("click", () => {
        menuOpen = false;
        renderHead();
        void run();
      });
      menu.append(button);
    };
    const signedIn = currentSession() !== null;
    const kind = doc.source.kind;
    item("Export as a .net file…", exportNow);
    if (kind === "file" || kind === "server") item("Save a copy to the library", () => attempt(() => copyToLibrary(doc)));
    if (signedIn && (kind === "library" || kind === "file" || kind === "new")) item("Upload to my account", () => attempt(async () => (await uploadToAccount(doc)) === null ? "" : "Uploaded: it's in your account now."));
    if (signedIn && kind === "server") item("Make a copy in my account", () => attempt(async () => ((await uploadToAccount(doc, `Copy of ${doc.draft.name}`)) === null ? "" : "Copied into your account.")));
    item("Ask the assistant to change it", () => openAssistant("change"));
    const canDelete = kind === "library" || (kind === "server" && doc.server !== undefined && currentSession()?.user.id === doc.server.circuit.owner.id);
    if (canDelete) {
      menu.append(h("hr"));
      item(kind === "library" ? "Delete from the library" : "Delete from the server", deleteNow, "danger");
    }
    return menu;
  }

  // Clicking anywhere else closes the menu.
  window.addEventListener(
    "click",
    () => {
      if (!menuOpen) return;
      menuOpen = false;
      renderHead();
    },
    { signal },
  );

  async function attempt(work: () => Promise<string>): Promise<void> {
    try {
      const message = await work();
      if (message !== "") toast(message);
    } catch (error) {
      toast(errorMessage(error), { error: true });
    }
  }

  let saving = false;
  async function saveNow(): Promise<void> {
    if (saving) return;
    saving = true;
    try {
      if (doc.mode === "net" && netStage !== null && !(await netStage.applyIfChanged())) {
        toast("The netlist has mistakes, so it wasn't saved. They're listed on the right.", { error: true });
        return;
      }
      const message = await saveDoc(doc);
      if (message === null) return;
      toast(message);
      ws.drawCheck = null;
      ws.problemGates = new Set();
      renderHead();
      renderInspectorPart();
      // Saved: a circuit on the server is simulated by the server again, now that it has this version.
      circuitChanged();
    } catch (error) {
      markProblems(error);
      toast(errorMessage(error), { error: true });
    } finally {
      saving = false;
    }
  }

  async function exportNow(): Promise<void> {
    await attempt(async () => (await exportNetlist(doc)) ?? "");
  }

  function closeNow(): void {
    const from = doc.source.kind;
    if (!closeDoc()) return;
    navigate(from === "library" ? "/library" : from === "server" ? "/circuits?scope=owned" : "/");
  }

  async function deleteNow(): Promise<void> {
    const where = doc.source.kind === "library" ? "your library" : "the server";
    if (!confirm(`Delete “${doc.draft.name}” from ${where}? This can't be undone.`)) return;
    const from = doc.source.kind;
    try {
      await deleteDoc(doc);
      toast(`Deleted “${doc.draft.name}”.`);
      navigate(from === "library" ? "/library" : "/circuits?scope=owned");
    } catch (error) {
      toast(errorMessage(error), { error: true });
    }
  }

  // ---- the modes --------------------------------------------------------------------------------

  async function setMode(mode: Mode): Promise<void> {
    if (mode === doc.mode) return;
    // Leaving the netlist editor: the text becomes the circuit first, if it changed.
    if (doc.mode === "net" && netStage !== null && !(await netStage.applyIfChanged())) {
      if (!confirm("The netlist has mistakes, so it can't become the circuit. Leave it, and lose your changes to the text?")) return;
      doc.netText = null;
      ws.netCheck = null;
    }
    doc.mode = mode;
    ws.selection = null;
    ws.nameError = null;
    renderHead();
    renderStage();
    renderInspectorPart();
  }

  function renderStage(): void {
    canvas?.dispose();
    canvas = null;
    netStage = null;
    if (doc.mode === "net") {
      netStage = createNetlistStage(ws, {
        applied: () => {
          renderInspectorPart();
          circuitChanged();
        },
        checked: () => renderInspectorPart(),
      });
      stage.replaceChildren(...netStage.nodes);
      return;
    }
    canvas = createCanvas(ws, {
      toggleInput,
      edited: () => {
        renderInspectorPart();
        circuitChanged();
      },
      selected: () => renderInspectorPart(),
    });
    stage.replaceChildren(...canvas.nodes);
  }

  // ---- the inspector ----------------------------------------------------------------------------

  function renderInspectorPart(): void {
    // Typing in one of its fields mustn't be interrupted by a redraw (the drawing redraws, the field stays).
    const active = document.activeElement;
    if (active instanceof HTMLElement && details.contains(active) && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
    details.replaceChildren(
      ...renderInspector(ws, {
        toggleInput,
        reset,
        edited: () => {
          drawingChanged(doc);
          ws.problemGates = new Set();
          ws.drawCheck = null;
          canvas?.redraw();
          renderInspectorPart();
          circuitChanged();
        },
        deleteSelection: () => canvas?.deleteSelection(),
        checkDrawing: () => void checkDrawing(),
        jumpToLine: (line) => netStage?.jumpTo(line),
      }),
    );
  }

  async function checkDrawing(): Promise<void> {
    try {
      const input = toCircuitInput(doc.draft);
      const summary =
        desktop() !== null
          ? unwrap(await requireDesktop().toNetlist({ name: input.name || "Untitled circuit", gates: input.gates, wires: input.wires })).circuit.summary
          : (await checkCircuit(input)).summary;
      ws.drawCheck = { ok: true, text: `Looks right: ${describeSummary(summary, doc.draft.gates.length)}` };
      ws.problemGates = new Set();
    } catch (error) {
      markProblems(error);
    }
    canvas?.redraw();
    renderInspectorPart();
  }

  /** Outlines in red the gates the last check or save complained about. */
  function markProblems(error: unknown): void {
    const ids = new Set<string>();
    for (const issue of errorDetails(error).issues) {
      if (issue.gateId !== undefined) ids.add(issue.gateId);
      const match = /^\/(gates|wires)\/(\d+)/.exec(issue.pointer ?? "");
      if (match?.[1] === "gates") {
        const gate = doc.draft.gates[Number(match[2])];
        if (gate !== undefined) ids.add(gate.id);
      }
      if (match?.[1] === "wires") {
        const wire = doc.draft.wires[Number(match[2])];
        if (wire !== undefined) ids.add(wire.to);
      }
    }
    ws.problemGates = ids;
    if (errorDetails(error).issues.length > 0) ws.drawCheck = { ok: false, error };
    canvas?.redraw();
  }

  // ---- the right-hand column: Details, or the assistant -----------------------------------------

  function showTab(tab: RightTab, remember = true): void {
    details.hidden = tab !== "details";
    assistantSpot.hidden = tab !== "assistant";
    // The assistant gets a little more room than the details: its drafts have a picture and a table.
    body.classList.toggle("with-assistant", tab === "assistant");
    tabs.replaceChildren(
      ...(
        [
          ["details", "Details", "Inputs and outputs, the selected gate, help"],
          ["assistant", "Assistant", "Ask for a circuit, or a change to this one (Ctrl J)"],
        ] as const
      ).map(([value, label, title]) => {
        const button = h("button", { type: "button", "aria-pressed": tab === value ? "true" : "false", title }, label);
        // The assistant's own code moves its panel in and out (it also opens from Ctrl J, the
        // sidebar and the More menu), and calls show() or hide() below.
        button.addEventListener("click", () => (value === "assistant" ? openAssistant() : closeAssistant()));
        return button;
      }),
    );
    if (remember) rememberTab(tab);
  }

  const startOnAssistant = rememberedTab() === "assistant";
  showTab("details", false);
  if (hasAssistant) {
    offerAssistantDock(
      {
        show(element) {
          assistantSpot.replaceChildren(element);
          showTab("assistant");
        },
        hide() {
          assistantSpot.replaceChildren();
          showTab("details");
        },
      },
      startOnAssistant,
      signal,
    );
  }

  // ---- the keyboard -----------------------------------------------------------------------------

  window.addEventListener(
    "keydown",
    (event) => {
      if (document.querySelector("#overlays .scrim") !== null) return; // a dialog is open
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (ctrl && key === "s") {
        event.preventDefault();
        void saveNow();
        return;
      }
      if (ctrl && (key === "1" || key === "2" || key === "3")) {
        event.preventDefault();
        void setMode(key === "1" ? "sim" : key === "2" ? "draw" : "net");
        return;
      }
      const target = event.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
      if (ctrl || event.altKey || typing) return;
      if (event.key === "Escape") {
        canvas?.cancelDrag();
        if (menuOpen) {
          menuOpen = false;
          renderHead();
        } else if (ws.selection !== null) {
          ws.selection = null;
          canvas?.redraw();
          renderInspectorPart();
        }
        return;
      }
      if (key === "t") table.toggle();
      if (doc.mode === "net") return;
      if (key === "f") canvas?.fit();
      if (event.key === "+" || event.key === "=") canvas?.zoomBy(1.15);
      if (event.key === "-") canvas?.zoomBy(1 / 1.15);
      if (doc.mode === "sim") {
        // 1 to 9 flip the inputs in the order the inspector lists them.
        if (/^[1-9]$/.test(event.key)) {
          const id = doc.draft.gates.filter((gate) => gate.type === "INPUT")[Number(event.key) - 1]?.id;
          if (id !== undefined) toggleInput(id);
        }
        if (key === "r") reset();
      }
      if (doc.mode === "draw") {
        if ((event.key === "Delete" || event.key === "Backspace") && ws.selection !== null) {
          event.preventDefault();
          canvas?.deleteSelection();
        }
        if (key === "a") canvas?.arrange();
      }
    },
    { signal },
  );

  // Another circuit opened (from the assistant, the palette, a double-clicked file): show that one.
  onDocChange(() => {
    if (currentDoc() !== doc) reload();
    else renderHead();
  }, signal);

  // Unsaved work: closing the window asks first (electron/main.ts shows the question).
  window.addEventListener(
    "beforeunload",
    (event) => {
      if (currentDoc()?.dirty === true) event.preventDefault();
    },
    { signal },
  );

  // What the command palette can ask of the workspace while it's on screen.
  setWorkspaceHooks({
    save: () => void saveNow(),
    setMode: (mode) => void setMode(mode),
    fit: () => canvas?.fit(),
    arrange: () => canvas?.arrange(),
    toggleTable: () => table.toggle(),
  });
  signal.addEventListener("abort", () => setWorkspaceHooks(null), { once: true });

  renderHead();
  renderStage();
  renderInspectorPart();
  simulator.run(false);
}

/** What the right-hand column shows; the choice is kept on this computer. */
type RightTab = "details" | "assistant";
const TAB_KEY = "circuitlab.rightTab";

function rememberedTab(): RightTab {
  try {
    return localStorage.getItem(TAB_KEY) === "assistant" ? "assistant" : "details";
  } catch {
    return "details";
  }
}

function rememberTab(tab: RightTab): void {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // not remembered
  }
}

function badgeOf(doc: OpenDoc): readonly [string, string] {
  switch (doc.source.kind) {
    case "library":
      return ["In your library", "sel"];
    case "file":
      return ["File", ""];
    case "new":
    case "new-server":
      return ["Not saved", "sig"];
    case "server":
      return doc.server?.circuit.visibility === "public" ? ["Public", "sel"] : ["Private", ""];
  }
}

function whereOf(doc: OpenDoc): string {
  switch (doc.source.kind) {
    case "library":
      return doc.updatedAt === undefined ? "saved" : `saved ${formatDate(doc.updatedAt)}`;
    case "file":
      return doc.source.path;
    case "new":
      return "not saved yet";
    case "new-server":
      return "not saved yet · Save puts it in your account";
    case "server":
      return doc.server === undefined ? "on the server" : `by ${doc.server.circuit.owner.displayName} · version ${doc.server.circuit.version}`;
  }
}
