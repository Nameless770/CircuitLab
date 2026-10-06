import { h } from "../dom";
import { showOverlay } from "./overlay";

/** The list of keyboard shortcuts (press ?). */
const GROUPS: readonly { readonly title: string; readonly items: readonly (readonly [string, string])[] }[] = [
  {
    title: "Anywhere",
    items: [
      ["Commands and search", "Ctrl K"],
      ["New circuit", "Ctrl N"],
      ["Open netlist file", "Ctrl O"],
      ["Ask the assistant", "Ctrl J"],
      ["Home / Library", "Ctrl H / L"],
      ["Settings", "Ctrl ,"],
      ["Toggle sidebar", "Ctrl B"],
      ["This list", "?"],
    ],
  },
  {
    title: "Circuit",
    items: [
      ["Simulate / Draw / Netlist", "Ctrl 1 2 3"],
      ["Flip input 1–9", "1 … 9"],
      ["Truth table", "T"],
      ["Fit / zoom", "F  + −"],
      ["Reset a latch", "R"],
      ["Delete selection", "Del"],
      ["Arrange automatically", "A"],
      ["Save", "Ctrl S"],
    ],
  },
];

let close: (() => void) | null = null;

export function openShortcuts(): void {
  if (close !== null) {
    close();
    return;
  }
  const sheet = h(
    "div",
    { class: "modal wide" },
    h("h2", {}, "Keyboard shortcuts"),
    h(
      "div",
      { class: "keys-grid" },
      GROUPS.map((group) =>
        h(
          "div",
          { class: "keys-group" },
          h("span", { class: "label" }, group.title),
          group.items.map(([label, key]) => h("div", { class: "keys-row" }, h("span", {}, label), h("span", { class: "kbd key solid" }, key))),
        ),
      ),
    ),
  );
  close = showOverlay(sheet, {
    label: "Keyboard shortcuts",
    onClose: () => {
      close = null;
    },
  });
}
