import type { CircuitListItem, ListScope } from "@circuitlab/api-contract";
import type { LibraryItem } from "../../electron/bridge";
import { listCircuits } from "../api";
import { desktop } from "../desktop";
import { formatDate, h, plural } from "../dom";
import { chooseNetlistFile, libraryItems, saveLibraryCircuit } from "../offline/storage";
import type { PageContext } from "../router";
import { currentSession } from "../session";
import { on } from "../shell/bus";
import { newCircuit, openLibraryCircuit, openServerCircuit } from "../shell/commands";
import { openSignIn } from "../shell/sign-in";
import { toast } from "../shell/toast";
import { errorBox, errorMessage, kbd } from "../ui";
import { lazyThumb, libraryThumb, serverThumb, type ThumbData } from "./thumbs";

/**
 * The lists of circuits, as cards with a picture: the library (`#/library`, circuits saved in the
 * app) and the server's (`#/circuits?scope=owned|shared|public`). Both can be searched by name and
 * narrowed to circuits with or without a loop; `/` jumps to the search box.
 */
type Filter = "all" | "comb" | "loop";

/** What a card shows, whichever list it's in. */
interface CardData {
  readonly name: string;
  readonly description?: string;
  readonly loop: boolean;
  readonly gates: number;
  readonly inputs: number;
  readonly outputs: number;
  readonly badge: readonly [string, string];
  readonly when: string;
  readonly thumb: () => Promise<ThumbData>;
  open(): void;
}

function card(data: CardData, signal: AbortSignal): HTMLElement {
  const thumb = h("div", { class: "thumb" });
  const element = h(
    "button",
    { type: "button", class: "ccard" },
    thumb,
    h(
      "div",
      { class: "ccard-body" },
      h("span", { class: "ccard-title" }, h("span", { title: data.name }, data.name), h("span", { class: `badge ${data.badge[1]}`.trim() }, data.badge[0])),
      h("span", { class: "ccard-desc" }, data.description ?? ""),
      h("span", { class: "ccard-meta" }, `${plural(data.gates, "gate")} · ${plural(data.inputs, "input")} → ${plural(data.outputs, "output")}`),
      h("span", { class: "ccard-meta faint" }, data.when),
    ),
  );
  element.addEventListener("click", () => data.open());
  lazyThumb(thumb, data.thumb, signal, data.gates);
  return element;
}

/** The search box and the All / Combinational / Remembers state switch. Calls `changed` when either changes. */
function tools(initialSearch: string, changed: (search: string, filter: Filter) => void, signal: AbortSignal): { element: HTMLElement; filter(): Filter } {
  let filter: Filter = "all";
  const search = h("input", { type: "search", value: initialSearch, placeholder: "Search by name", "aria-label": "Search by name", maxlength: 100 });
  const seg = h("div", { class: "seg sm", role: "group", "aria-label": "Show" });
  const drawSeg = (): void => {
    seg.replaceChildren(
      ...(
        [
          ["all", "All"],
          ["comb", "Combinational"],
          ["loop", "Remembers state"],
        ] as const
      ).map(([value, label]) => {
        const button = h("button", { type: "button", "aria-pressed": filter === value ? "true" : "false" }, label);
        button.addEventListener("click", () => {
          filter = value;
          drawSeg();
          changed(search.value.trim(), filter);
        });
        return button;
      }),
    );
  };
  drawSeg();
  search.addEventListener("input", () => changed(search.value.trim(), filter));
  // "/" jumps to the search box (when you're not typing somewhere already).
  window.addEventListener(
    "keydown",
    (event) => {
      const target = event.target as HTMLElement;
      if (event.key !== "/" || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || document.querySelector("#overlays .scrim") !== null) return;
      event.preventDefault();
      search.focus();
    },
    { signal },
  );
  return { element: h("div", { class: "list-tools" }, h("div", { class: "search" }, search, kbd("/")), seg), filter: () => filter };
}

const keep = (filter: Filter, loop: boolean): boolean => filter === "all" || (filter === "loop") === loop;

function head(title: string, count: string, description: string, ...actions: (HTMLElement | null)[]): HTMLElement {
  return h(
    "div",
    { class: "page-head" },
    h("div", {}, h("h1", { class: "page-title" }, title, h("span", { class: "count" }, count)), h("p", {}, description)),
    h("div", { class: "actions" }, actions),
  );
}

function newButton(forServer: boolean): HTMLElement {
  const button = h("button", { type: "button", class: "btn lg primary", title: forServer ? "A new circuit that Save puts in your account" : "A new circuit that Save puts in your library" }, "New circuit");
  button.addEventListener("click", () => newCircuit(forServer));
  return button;
}

// ---- the library --------------------------------------------------------------------------------

/** `#/library`: every circuit saved in the app, the most recently changed first. */
export async function libraryPage({ root, signal }: PageContext): Promise<void> {
  const inner = h("div", { class: "page-inner" });
  root.append(inner);
  if (desktop() === null) {
    inner.append(h("div", { class: "empty-box" }, h("h2", {}, "Library"), h("p", {}, "The library is part of the desktop app.")));
    return;
  }

  // Copies a netlist file into the library, so it's kept even if the file moves, and opens it.
  const importButton = h("button", { type: "button", class: "btn lg" }, "Import netlist file…");
  importButton.addEventListener("click", () => {
    importButton.disabled = true;
    void (async () => {
      try {
        const file = await chooseNetlistFile();
        if (file === null) return;
        const saved = await saveLibraryCircuit({ netlist: file.text });
        toast(`“${saved.item.name}” is in your library now.`);
        await openLibraryCircuit(saved.item.id);
      } catch (error) {
        toast(errorMessage(error), { error: true });
      } finally {
        importButton.disabled = false;
      }
    })();
  });

  const grid = h("div", { class: "card-grid" });
  const empty = h("p", { class: "muted" });
  let items: readonly LibraryItem[] = [];
  const listTools = tools("", () => show(), signal);
  const pageHead = head("Library", "", "Circuits saved in the app on this computer. Saving them needs no file, server or account.", importButton, newButton(false));
  inner.append(pageHead, listTools.element, grid, empty);

  function show(): void {
    const search = (listTools.element.querySelector("input")?.value ?? "").trim().toLowerCase();
    const shown = items.filter((item) => item.name.toLowerCase().includes(search) && keep(listTools.filter(), item.summary.feedbackLoop !== null));
    pageHead.querySelector(".count")?.replaceChildren(String(items.length));
    grid.replaceChildren(
      ...shown.map((item) =>
        card(
          {
            name: item.name,
            ...(item.description !== undefined && { description: item.description }),
            loop: item.summary.feedbackLoop !== null,
            gates: item.summary.gates,
            inputs: item.summary.inputs.length,
            outputs: item.summary.outputs.length,
            badge: item.summary.feedbackLoop !== null ? ["remembers state", "sig"] : ["offline", ""],
            when: `saved ${formatDate(item.updatedAt)}`,
            thumb: () => libraryThumb(item),
            open: () => void openLibraryCircuit(item.id),
          },
          signal,
        ),
      ),
    );
    empty.textContent =
      items.length === 0
        ? "Nothing saved yet. Draw a new circuit, open an example from the home screen, or import a netlist file: once saved, it shows up here."
        : shown.length === 0
          ? search === ""
            ? "No circuit in the library matches."
            : `No circuit's name contains “${search}”.`
          : "";
  }

  const load = async (): Promise<void> => {
    try {
      items = await libraryItems();
      show();
    } catch (error) {
      grid.replaceChildren(errorBox(error));
    }
  };
  on("library", () => void load(), signal);
  await load();
}

// ---- the server's lists ----------------------------------------------------------------------------

const TITLES: Record<ListScope, string> = { owned: "My circuits", shared: "Shared with me", public: "Public circuits" };
const DESCRIPTIONS: Record<ListScope, string> = {
  owned: "Your circuits on the CircuitLab server.",
  shared: "Circuits other people shared with you.",
  public: "Circuits anyone can see (read-only).",
};
const EMPTY: Record<ListScope, string> = {
  owned: "You have no circuits yet. Make one with “New circuit”, or upload one from your library.",
  shared: "Nobody has shared a circuit with you yet.",
  public: "Nobody has made a circuit public yet.",
};

/** `#/circuits?scope=owned|shared|public`: one page at a time, "Load more" for the next. */
export async function serverListPage({ root, query, signal }: PageContext): Promise<void> {
  const signedIn = currentSession() !== null;
  const asked = query.get("scope");
  const scope: ListScope = asked === "owned" || asked === "shared" || asked === "public" ? asked : signedIn ? "owned" : "public";
  const inner = h("div", { class: "page-inner" });
  root.append(inner);
  const pageHead = head(TITLES[scope], "", DESCRIPTIONS[scope], newButton(signedIn));
  inner.append(pageHead);

  if (scope !== "public" && !signedIn) {
    const signIn = h("button", { type: "button", class: "btn lg primary" }, "Sign in");
    signIn.addEventListener("click", () => openSignIn("in"));
    const create = h("button", { type: "button", class: "btn lg" }, "Create an account");
    create.addEventListener("click", () => openSignIn("up"));
    inner.append(
      h(
        "div",
        { class: "empty-box" },
        h("h2", {}, "Please sign in"),
        h("p", {}, "This needs an account on the CircuitLab server. (Offline mode doesn't: try opening a netlist file from the home screen.)"),
        h("div", { class: "form-actions" }, signIn, create),
      ),
    );
    return;
  }

  const grid = h("div", { class: "card-grid" });
  const more = h("div", { class: "load-more" });
  const empty = h("p", { class: "muted" });
  let items: CircuitListItem[] = [];
  let search = query.get("q") ?? "";
  let generation = 0;
  let timer = 0;
  const listTools = tools(search, (text, _filter) => {
    if (text !== search) {
      // The server searches: ask again, a moment after the typing stops.
      search = text;
      clearTimeout(timer);
      timer = window.setTimeout(() => void loadFirst(), 300);
    } else {
      show();
    }
  }, signal);
  inner.append(listTools.element, grid, more, empty);

  function show(): void {
    const shown = items.filter((item) => keep(listTools.filter(), item.summary.feedbackLoop !== null));
    grid.replaceChildren(
      ...shown.map((item) =>
        card(
          {
            name: item.name,
            ...(item.description !== undefined && { description: item.description }),
            loop: item.summary.feedbackLoop !== null,
            gates: item.summary.gates,
            inputs: item.summary.inputs.length,
            outputs: item.summary.outputs.length,
            badge: item.visibility === "public" ? ["Public", "sel"] : ["Private", "sunk"],
            when: `${scope === "owned" ? "" : `by ${item.owner.displayName} · `}updated ${formatDate(item.updatedAt)}`,
            thumb: () => serverThumb(item),
            open: () => openServerCircuit(item.id),
          },
          signal,
        ),
      ),
    );
    empty.textContent = items.length === 0 ? (search === "" ? EMPTY[scope] : `No circuit's name contains “${search}”.`) : shown.length === 0 ? "None of these match." : "";
  }

  // The API pages with cursors: each page says where the next one starts (nextCursor).
  async function load(cursor: string | undefined, mine: number): Promise<void> {
    more.replaceChildren(h("p", { class: "loading" }, "Loading…"));
    try {
      const page = await listCircuits({ scope, search, ...(cursor !== undefined && { cursor }), signal });
      if (mine !== generation) return;
      items = [...items, ...page.items];
      pageHead.querySelector(".count")?.replaceChildren(`${items.length}${page.page.nextCursor === null ? "" : "+"}`);
      show();
      more.replaceChildren();
      const next = page.page.nextCursor;
      if (next !== null) {
        const button = h("button", { type: "button", class: "btn lg" }, "Load more");
        button.addEventListener("click", () => void load(next, mine));
        more.append(button);
      }
    } catch (error) {
      if (!signal.aborted && mine === generation) more.replaceChildren(errorBox(error));
    }
  }

  async function loadFirst(): Promise<void> {
    generation += 1;
    items = [];
    grid.replaceChildren();
    await load(undefined, generation);
  }

  on("server", () => void loadFirst(), signal);
  await loadFirst();
}
