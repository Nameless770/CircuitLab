import type { ListScope } from "@circuitlab/api-contract";
import { listCircuits, signOut } from "../api";
import { openAssistant } from "../assistant/drawer";
import { desktop } from "../desktop";
import { h, s } from "../dom";
import { libraryItems } from "../offline/storage";
import { currentPath, onPageChange } from "../router";
import { currentSession, onSessionChange } from "../session";
import { currentDoc, docLabel, onDocChange } from "../workspace/store";
import { on } from "./bus";
import { goHome, goLibrary, goServer, goSettings, newCircuit, showWorkspace } from "./commands";
import { openSignIn } from "./sign-in";
import { assistantState, serverLine, serverState } from "./status";
import { toast } from "./toast";

/**
 * The column on the left: New circuit, then where things are kept (this computer, the server),
 * the assistant, whether the server answers, and who is signed in.
 *
 * The numbers next to the places are counted when something changes (a save, a sign-in, the
 * server coming back), not at every redraw.
 */
const counts: { library: number | null; owned: string | null; shared: string | null; public: string | null } = { library: null, owned: null, shared: null, public: null };

export function startSidebar(element: HTMLElement): void {
  const draw = (): void => element.replaceChildren(...sidebar());
  onPageChange(draw);
  onDocChange(draw);
  onSessionChange(() => {
    draw();
    void countServer().then(draw);
  });
  on("status", draw);
  on("library", () => void countLibrary().then(draw));
  on("server", () => void countServer().then(draw));
  // The server's counts once it is known to answer (it's checked at startup, and every 30 seconds).
  let wasOnline = false;
  on("status", () => {
    const online = serverState().kind === "online";
    if (online && !wasOnline) void countServer().then(draw);
    wasOnline = online;
  });
  draw();
  void countLibrary().then(draw);
}

async function countLibrary(): Promise<void> {
  if (desktop() === null) return;
  try {
    counts.library = (await libraryItems()).length;
  } catch {
    counts.library = null;
  }
}

/** One page of up to 100 circuits per list: "100+" when there are more. */
async function countServer(): Promise<void> {
  const signedIn = currentSession() !== null;
  const scopes: ListScope[] = signedIn ? ["owned", "shared", "public"] : ["public"];
  if (!signedIn) {
    counts.owned = null;
    counts.shared = null;
  }
  await Promise.all(
    scopes.map(async (scope) => {
      try {
        const page = await listCircuits({ scope, limit: 100 });
        counts[scope] = `${page.items.length}${page.page.nextCursor === null ? "" : "+"}`;
      } catch {
        counts[scope] = null;
      }
    }),
  );
}

function sidebar(): HTMLElement[] {
  const path = currentPath();
  const session = currentSession();
  const doc = currentDoc();
  const scope = path.startsWith("/circuits?") ? new URLSearchParams(path.split("?")[1]).get("scope") : null;

  const newButton = h("button", { type: "button", class: "sb-new", title: "A new circuit, on an empty canvas" }, h("span", {}, "New circuit"), h("span", { class: "kbd" }, "Ctrl N"));
  newButton.addEventListener("click", () => newCircuit());

  const item = (label: string, current: boolean, run: () => void, meta: string, metaClass = ""): HTMLElement => {
    const button = h(
      "button",
      { type: "button", class: "nav-item", "aria-current": current ? "page" : null, title: label },
      h("span", { class: "led" }),
      h("span", { class: "nav-label" }, label),
      h("span", { class: `nav-meta ${metaClass}`.trim() }, meta),
    );
    button.addEventListener("click", run);
    return button;
  };

  const thisComputer = [item("Home", path === "/", goHome, "Ctrl H")];
  if (desktop() !== null) thisComputer.push(item("Library", path.startsWith("/library"), goLibrary, counts.library === null ? "" : String(counts.library)));
  if (doc !== null) thisComputer.push(item(docLabel(doc), path.startsWith("/workspace"), () => showWorkspace(), doc.dirty ? "●" : "", "dirty"));

  const serverItem = (listScope: ListScope, label: string): HTMLElement => {
    const meta = listScope !== "public" && session === null ? "sign in" : (counts[listScope] ?? "");
    return item(label, scope === listScope, () => goServer(listScope), meta);
  };

  const status = serverLine(serverState());
  const statusButton = h("button", { type: "button", class: "sb-status", title: "Online mode's server: change it in Settings" }, h("span", { class: `led ${status.tone}` }), h("span", {}, status.text));
  statusButton.addEventListener("click", goSettings);
  // A gear rather than the word, so the status line beside it has room.
  const gear = s(
    "svg",
    { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "aria-hidden": "true" },
    s("circle", { cx: 12, cy: 12, r: 3 }),
    s("path", { d: "M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" }),
  );
  const settings = h("button", { type: "button", class: "sb-gear", title: "Settings (Ctrl ,)", "aria-label": "Settings" }, gear);
  settings.addEventListener("click", goSettings);

  const parts: HTMLElement[] = [
    newButton,
    h("div", { class: "label sb-heading" }, "This computer"),
    ...thisComputer,
    h("div", { class: "label sb-heading later" }, "Server"),
    serverItem("owned", "My circuits"),
    serverItem("shared", "Shared with me"),
    serverItem("public", "Public"),
    h("div", { class: "sb-spacer" }),
  ];
  if (desktop() !== null) parts.push(assistantCard());
  parts.push(h("div", { class: "sb-foot" }, statusButton, settings));

  if (session !== null) {
    const out = h("button", { type: "button", class: "sb-plain" }, "Sign out");
    out.addEventListener("click", () => {
      void signOut().then(() => {
        toast("Signed out.");
        if (path.startsWith("/circuits?scope=owned") || path.startsWith("/circuits?scope=shared")) goHome();
      });
    });
    const name = session.user.displayName;
    parts.push(
      h(
        "div",
        { class: "sb-user" },
        h("span", { class: "avatar", "aria-hidden": "true" }, (name.trim()[0] ?? "?").toUpperCase()),
        h("span", { class: "sb-user-text" }, h("span", { class: "sb-user-name" }, name), h("span", { class: "sb-user-email", title: session.user.email }, session.user.email)),
        out,
      ),
    );
  } else {
    const signIn = h("button", { type: "button", class: "sb-signin" }, "Sign in");
    signIn.addEventListener("click", () => openSignIn("in"));
    parts.push(signIn);
  }
  return parts;
}

function assistantCard(): HTMLElement {
  const state = assistantState();
  const sub =
    state === null ? "Looking for Ollama…" : state.model === null ? (state.problem ?? "Ollama isn't available") : `${state.model} · ${state.local ? "on this computer" : "on another computer"}`;
  const card = h(
    "button",
    { type: "button", class: "sb-assistant", title: "Describe a circuit in words, and a model running in Ollama drafts it" },
    h("span", { class: "sb-assistant-title" }, "Ask the assistant", h("span", { class: "kbd" }, "Ctrl J")),
    h("span", { class: "sb-assistant-sub" }, sub),
  );
  card.addEventListener("click", () => openAssistant());
  return card;
}
