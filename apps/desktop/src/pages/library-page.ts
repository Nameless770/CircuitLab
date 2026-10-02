import type { LibraryItem } from "../../electron/bridge";
import { desktop, requireDesktop, unwrap } from "../desktop";
import { formatDate, h, plural } from "../dom";
import { libraryItems, openFromLibrary, saveInLibrary } from "../offline/document";
import { navigate, redirect, type PageContext } from "../router";
import { errorBox, loading, pageHeader, runAction } from "../ui";

/** `#/library`: every circuit saved in the app, the most recently changed first. */
export async function libraryPage({ root, query }: PageContext): Promise<void> {
  if (desktop() === null) {
    root.append(h("div", { class: "card empty-state" }, h("h1", {}, "Library"), h("p", {}, "The library is part of the desktop app.")));
    return;
  }
  const message = h("div");

  // Copies a netlist file into the library, so it's kept even if the file moves.
  const importButton = h("button", {}, "Import netlist file…");
  importButton.addEventListener("click", () => {
    void runAction(importButton, message, async () => {
      const result = await requireDesktop().openFile();
      if (result === null) return; // cancelled
      await saveInLibrary(unwrap(result).text, undefined);
      navigate("/local");
    });
  });

  const search = h("input", { type: "search", placeholder: "Search by name", value: query.get("q") ?? "", "aria-label": "Search by name" });
  const grid = h("div", { class: "circuit-grid" }, loading());
  root.append(
    pageHeader("Library", h("a", { class: "button primary", href: "#/local/new" }, "New circuit"), importButton),
    h("p", { class: "muted" }, "Circuits saved in the app on this computer. Saving them needs no file, server or account."),
    h("div", { class: "toolbar" }, search),
    message,
    grid,
  );

  let items: readonly LibraryItem[];
  try {
    items = await libraryItems();
  } catch (error) {
    grid.replaceChildren(errorBox(error));
    return;
  }

  // The list is already in memory, so searching just filters it as you type.
  function show(): void {
    const text = search.value.trim().toLowerCase();
    const shown = items.filter((item) => item.name.toLowerCase().includes(text));
    if (items.length === 0) {
      grid.replaceChildren(
        h(
          "div",
          { class: "card empty-state" },
          h("p", {}, "Nothing saved yet. Draw a new circuit, open an example from the home screen, or import a netlist file: once saved, it shows up here."),
        ),
      );
    } else if (shown.length === 0) {
      grid.replaceChildren(h("p", { class: "muted" }, `No circuit's name contains “${search.value.trim()}”.`));
    } else {
      grid.replaceChildren(...shown.map(libraryCard));
    }
  }
  search.addEventListener("input", show);
  show();
  search.focus();
}

function libraryCard(item: LibraryItem): HTMLElement {
  const { summary } = item;
  return h(
    "a",
    { class: "card circuit-card", href: `#/library/${encodeURIComponent(item.id)}` },
    h("h3", {}, h("span", {}, item.name), summary.feedbackLoop === null ? null : h("span", { class: "badge loop" }, "remembers state")),
    item.description === undefined ? null : h("p", { class: "description" }, item.description),
    h("div", { class: "meta" }, h("span", {}, plural(summary.gates, "gate")), h("span", {}, `${plural(summary.inputs.length, "input")} → ${plural(summary.outputs.length, "output")}`)),
    h("div", { class: "meta" }, h("span", {}, `saved ${formatDate(item.updatedAt)}`)),
  );
}

/** `#/library/:id`: opens a library circuit, then shows it on the offline circuit page. */
export async function openLibraryItemPage({ root, params }: PageContext): Promise<void> {
  root.append(loading("Opening…"));
  await openFromLibrary(params["id"] ?? ""); // a failure (deleted meanwhile) is shown by the router
  redirect("/local");
}
