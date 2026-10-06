import type { Bit } from "@circuitlab/engine";
import { backendFor, type TruthTableWindow } from "../circuit/backend";
import { h, plural } from "../dom";
import { toast } from "../shell/toast";
import { errorMessage } from "../ui";
import { summaryOf, type Ws } from "./context";

/**
 * The truth table, in a drawer under the drawing. Rows arrive 256 at a time as you scroll, so a
 * table of a million rows opens as fast as one of four. Row n is the input values written as n in
 * binary (the first input is the most significant bit), so the row that matches the switches is
 * easy to find and light up. Clicking a row sets the switches to it.
 */
const PAGE = 256;
const OPEN_KEY = "circuitlab.tableOpen";

export interface TableDrawer {
  readonly element: HTMLElement;
  /** The circuit changed: the rows are computed again. */
  reload(): void;
  /** The switches changed: another row is the current one. */
  highlight(): void;
  toggle(): void;
}

export interface TableActions {
  pickRow(inputs: Record<string, Bit>): void;
}

export function createTable(ws: Ws, actions: TableActions): TableDrawer {
  const element = h("section", { class: "drawer", "aria-label": "Truth table" });
  let open = readOpen();
  let generation = 0;
  let tbody: HTMLTableSectionElement | null = null;
  let observer: IntersectionObserver | null = null;
  ws.signal.addEventListener("abort", () => observer?.disconnect(), { once: true });

  function render(): void {
    generation += 1;
    observer?.disconnect();
    tbody = null;
    const summary = summaryOf(ws);
    const sequential = summary.feedbackLoop !== null;
    const empty = ws.doc.draft.gates.length === 0;
    const hasTable = !sequential && !empty && summary.outputs.length > 0;
    const intro = empty
      ? "No gates yet."
      : sequential
        ? "A circuit with a feedback loop has no truth table: its outputs depend on what it remembers, not only on its inputs."
        : summary.outputs.length === 0
          ? "Add an OUTPUT gate to see what the circuit computes."
          : `${plural(summary.inputs.length, "input")}, so ${(2 ** summary.inputs.length).toLocaleString()} rows: one for every combination of input values.`;

    const toggleButton = h("button", { type: "button", class: "drawer-toggle", "aria-expanded": open ? "true" : "false" }, h("span", { class: "chevron" }, "▾"), "Truth table");
    toggleButton.addEventListener("click", toggle);
    const exportButton = hasTable ? h("button", { type: "button", class: "btn sm" }, "Export CSV") : null;
    exportButton?.addEventListener("click", () => {
      exportButton.disabled = true;
      void backendFor(ws.doc)
        .exportCsv()
        .then(
          (message) => {
            if (message !== null) toast(message);
          },
          (error: unknown) => toast(errorMessage(error), { error: true }),
        )
        .finally(() => {
          exportButton.disabled = false;
        });
    });

    element.className = open ? "drawer" : "drawer closed";
    element.replaceChildren(h("div", { class: "drawer-head" }, toggleButton, h("span", { class: "drawer-intro", title: intro }, intro), exportButton, h("span", { class: "kbd" }, "T")));
    if (!open || !hasTable) return;

    const head = h(
      "tr",
      {},
      h("th", { class: "num" }, "#"),
      summary.inputs.map((id) => h("th", {}, id)),
      summary.outputs.map((id, index) => h("th", { class: index === 0 ? "out divider" : "out" }, id)),
    );
    tbody = h("tbody");
    const sentinel = h("div", { class: "more-rows" });
    const body = h("div", { class: "drawer-body" }, h("table", { class: "tt pickable" }, h("thead", {}, head), tbody), sentinel);
    element.append(body);
    tbody.addEventListener("click", (event) => {
      const row = (event.target as Element).closest("tr");
      const bits = row?.getAttribute("data-bits");
      if (bits === null || bits === undefined) return;
      actions.pickRow(Object.fromEntries(summary.inputs.map((id, index) => [id, bits[index] === "1" ? 1 : 0])));
    });

    const total = 2 ** summary.inputs.length;
    let loaded = 0;
    let busy = false;
    const mine = generation;
    const loadMore = async (): Promise<void> => {
      if (busy || loaded >= total || mine !== generation) return;
      busy = true;
      sentinel.textContent = "Loading rows…";
      try {
        const page = await backendFor(ws.doc).truthTablePage(loaded, PAGE, ws.signal);
        if (mine !== generation) return;
        appendRows(page);
        loaded = page.offset + page.rows.length;
        sentinel.textContent = loaded < total ? `${loaded.toLocaleString()} of ${total.toLocaleString()} rows: scroll for more` : "";
        highlight();
      } catch (error) {
        if (ws.signal.aborted || mine !== generation) return;
        sentinel.textContent = ws.doc.dirty ? `The truth table needs a finished circuit: ${errorMessage(error)}` : errorMessage(error);
      } finally {
        busy = false;
      }
    };
    // More rows when the bottom of the table scrolls into view.
    observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { root: body });
    observer.observe(sentinel);
    void loadMore();
  }

  function appendRows(page: TruthTableWindow): void {
    if (tbody === null) return;
    for (const row of page.rows) {
      tbody.append(
        h(
          "tr",
          { "data-index": row.index, "data-bits": row.inputs.join(""), title: "Set the inputs to this row" },
          h("td", { class: "num" }, row.index.toLocaleString()),
          row.inputs.map((bit) => h("td", {}, String(bit))),
          row.outputs.map((bit, index) => h("td", { class: [index === 0 ? "divider" : "", bit === 1 ? "one" : ""].join(" ").trim() || null }, String(bit))),
        ),
      );
    }
  }

  function highlight(): void {
    if (tbody === null) return;
    const ids = summaryOf(ws).inputs;
    const index = ids.reduce((n, id) => n * 2 + (ws.doc.inputs[id] === 1 ? 1 : 0), 0);
    tbody.querySelector("tr.current")?.classList.remove("current");
    tbody.querySelector(`tr[data-index="${index}"]`)?.classList.add("current");
  }

  function toggle(): void {
    open = !open;
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      // not remembered
    }
    render();
  }

  render();
  return { element, reload: render, highlight, toggle };
}

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}
