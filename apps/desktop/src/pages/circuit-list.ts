import type { CircuitListItem, ListScope } from "@circuitlab/api-contract";
import { listCircuits } from "../api";
import { formatDate, h, plural } from "../dom";
import { navigate, type PageContext } from "../router";
import { currentSession } from "../session";
import { errorBox, loading, pageHeader } from "../ui";
import { requireSignIn } from "./account";

const TITLES: Record<ListScope, string> = {
  owned: "My circuits",
  shared: "Shared with me",
  public: "Public circuits",
};

const EMPTY: Record<ListScope, string> = {
  owned: "You have no circuits yet. Make one with “New circuit”.",
  shared: "Nobody has shared a circuit with you yet.",
  public: "Nobody has made a circuit public yet.",
};

/** `#/circuits?scope=owned|shared|public&q=search`: one page at a time, "Load more" for the next. */
export async function circuitListPage({ root, query, signal }: PageContext): Promise<void> {
  const signedIn = currentSession() !== null;
  const asked = query.get("scope");
  const scope: ListScope = asked === "owned" || asked === "shared" || asked === "public" ? asked : signedIn ? "owned" : "public";
  if (scope !== "public" && !requireSignIn(root)) return;
  const search = query.get("q") ?? "";

  const searchInput = h("input", { type: "search", placeholder: "Search by name", value: search, maxlength: 100, "aria-label": "Search by name" });
  const searchForm = h("form", { class: "search" }, searchInput, h("button", { type: "submit" }, "Search"));
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const q = searchInput.value.trim();
    navigate(`/circuits?scope=${scope}${q === "" ? "" : `&q=${encodeURIComponent(q)}`}`);
  });

  const grid = h("div", { class: "circuit-grid" });
  const more = h("div", { class: "load-more" });
  root.append(
    pageHeader(TITLES[scope], signedIn ? h("a", { class: "button primary", href: "#/circuits/new" }, "New circuit") : null),
    h("div", { class: "toolbar" }, searchForm, search === "" ? null : h("a", { href: `#/circuits?scope=${scope}` }, "Clear search")),
    grid,
    more,
  );

  // The API pages with cursors: each page says where the next one starts (nextCursor).
  async function loadPage(cursor?: string): Promise<void> {
    more.replaceChildren(loading());
    try {
      const page = await listCircuits({ scope, search, ...(cursor !== undefined && { cursor }), signal });
      grid.append(...page.items.map((item) => circuitCard(item, scope)));
      more.replaceChildren();
      if (grid.childElementCount === 0) {
        grid.replaceWith(h("div", { class: "card empty-state" }, h("p", {}, search === "" ? EMPTY[scope] : `No circuit's name contains “${search}”.`)));
      }
      const next = page.page.nextCursor;
      if (next !== null) {
        const button = h("button", {}, "Load more");
        button.addEventListener("click", () => void loadPage(next));
        more.append(button);
      }
    } catch (error) {
      if (!signal.aborted) more.replaceChildren(errorBox(error));
    }
  }
  await loadPage();
}

function circuitCard(item: CircuitListItem, scope: ListScope): HTMLElement {
  const { summary } = item;
  return h(
    "a",
    { class: "card circuit-card", href: `#/circuits/${encodeURIComponent(item.id)}` },
    h("h3", {}, h("span", {}, item.name), item.visibility === "public" ? h("span", { class: "badge public" }, "Public") : h("span", { class: "badge" }, "Private")),
    item.description === undefined ? null : h("p", { class: "description" }, item.description),
    h(
      "div",
      { class: "meta" },
      h("span", {}, plural(summary.gates, "gate")),
      h("span", {}, `${plural(summary.inputs.length, "input")} → ${plural(summary.outputs.length, "output")}`),
      summary.feedbackLoop === null ? null : h("span", { class: "badge loop" }, "remembers state"),
    ),
    h("div", { class: "meta" }, scope === "owned" ? null : h("span", {}, `by ${item.owner.displayName}`), h("span", {}, `updated ${formatDate(item.updatedAt)}`)),
  );
}
