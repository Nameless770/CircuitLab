import { appendAll, h } from "../dom";
import { errorBox, loading, runAction, successBox } from "../ui";
import type { CircuitBackend, TruthTableWindow, ViewableCircuit } from "./backend";

const ROWS_PER_PAGE = 16;

/**
 * The truth table, one page at a time. Row n is the input values written as n in binary (first
 * input = most significant bit), so any page can be asked for directly by its first row number,
 * even in a table with millions of rows.
 */
export function truthTableSection(circuit: ViewableCircuit, backend: CircuitBackend, signal: AbortSignal, extra: HTMLElement | null = null): HTMLElement {
  const section = h("section", { class: "card section" }, h("h2", {}, "Truth table"));

  if (circuit.summary.feedbackLoop !== null) {
    section.append(
      h("p", { class: "muted" }, "A circuit with a feedback loop has no truth table: its outputs depend on what it remembers, not only on its inputs. Use “Try it” above to step through it."),
    );
    return section;
  }

  const inputCount = circuit.summary.inputs.length;
  const totalRows = 2 ** inputCount;
  const tableArea = h("div", {}, loading());
  const pager = h("div", { class: "pager" });
  const message = h("div");
  let offset = 0;

  async function show(newOffset: number): Promise<void> {
    offset = newOffset;
    try {
      const page = await backend.truthTablePage(offset, ROWS_PER_PAGE, signal);
      tableArea.replaceChildren(table(page));
      pager.replaceChildren(...pagerButtons(page));
    } catch (error) {
      if (!signal.aborted) tableArea.replaceChildren(errorBox(error));
    }
  }

  function pagerButtons(page: TruthTableWindow): HTMLElement[] {
    const lastOffset = Math.max(0, Math.floor((page.totalRows - 1) / ROWS_PER_PAGE) * ROWS_PER_PAGE);
    const go = (label: string, target: number, enabled: boolean): HTMLElement => {
      const button = h("button", { class: "small", disabled: !enabled }, label);
      button.addEventListener("click", () => void show(target));
      return button;
    };
    const first = page.offset + 1;
    const last = page.offset + page.rows.length;
    return [
      go("« First", 0, page.offset > 0),
      go("‹ Previous", Math.max(0, page.offset - ROWS_PER_PAGE), page.offset > 0),
      h("span", { class: "muted" }, `Rows ${first.toLocaleString()}–${last.toLocaleString()} of ${page.totalRows.toLocaleString()}`),
      go("Next ›", page.offset + ROWS_PER_PAGE, last < page.totalRows),
      go("Last »", lastOffset, last < page.totalRows),
    ];
  }

  const exportButton = h("button", { class: "small" }, "Export CSV");
  exportButton.addEventListener("click", () => {
    void runAction(exportButton, message, async () => {
      const result = await backend.exportCsv();
      if (result !== null) message.replaceChildren(successBox(result));
    });
  });

  appendAll(
    section,
    h(
      "p",
      { class: "muted" },
      `${inputCount} input${inputCount === 1 ? "" : "s"}, so ${totalRows.toLocaleString()} rows: one for every combination of input values.`,
    ),
    pager,
    tableArea,
    h("div", { class: "button-row section" }, exportButton, h("span", { class: "muted small" }, "Up to 1,048,576 rows (20 inputs).")),
    message,
    extra,
  );
  void show(0);
  return section;
}

function table(page: TruthTableWindow): HTMLElement {
  const header = h(
    "tr",
    {},
    h("th", { class: "row-number" }, "#"),
    page.inputs.map((id) => h("th", {}, id)),
    page.outputs.map((id, index) => h("th", { class: index === 0 ? "divider" : null }, id)),
  );
  const rows = page.rows.map((row) =>
    h(
      "tr",
      {},
      h("td", { class: "row-number" }, row.index.toLocaleString()),
      row.inputs.map((bit) => h("td", {}, String(bit))),
      row.outputs.map((bit, index) => h("td", { class: [index === 0 ? "divider" : "", bit === 1 ? "one" : ""].join(" ").trim() || null }, String(bit))),
    ),
  );
  return h("div", { class: "table-wrap" }, h("table", { class: "truth-table" }, h("thead", {}, header), h("tbody", {}, rows)));
}
