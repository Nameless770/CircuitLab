import { h } from "../dom";
import type { TruthTableWindow } from "./backend";

/**
 * Rows of a truth table as a small table, for the assistant's draft. (The workspace's own truth
 * table, which loads its rows as you scroll, is workspace/table.ts.)
 */
export function renderTruthTable(page: TruthTableWindow): HTMLElement {
  const header = h(
    "tr",
    {},
    h("th", { class: "num" }, "#"),
    page.inputs.map((id) => h("th", {}, id)),
    page.outputs.map((id, index) => h("th", { class: index === 0 ? "out divider" : "out" }, id)),
  );
  const rows = page.rows.map((row) =>
    h(
      "tr",
      {},
      h("td", { class: "num" }, row.index.toLocaleString()),
      row.inputs.map((bit) => h("td", {}, String(bit))),
      row.outputs.map((bit, index) => h("td", { class: [index === 0 ? "divider" : "", bit === 1 ? "one" : ""].join(" ").trim() || null }, String(bit))),
    ),
  );
  return h("table", { class: "tt small" }, h("thead", {}, header), h("tbody", {}, rows));
}
