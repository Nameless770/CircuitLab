import { errorBox } from "./ui";

/**
 * A tiny router for "hash" URLs such as `#/circuits/123`.
 *
 * Why hash URLs? The part after `#` is never sent to a server, so changing page never loads
 * anything: the same index.html stays open (from Vite's dev server, or app://circuitlab in the
 * built app), and this file decides which page to show.
 */

export interface PageContext {
  /** The element the page draws into. It's thrown away when the user navigates elsewhere. */
  readonly root: HTMLElement;
  /** Values from the path, e.g. { id: "123" } for "/circuits/:id". */
  readonly params: Readonly<Record<string, string>>;
  /** The query string after the path, e.g. "?scope=public". */
  readonly query: URLSearchParams;
  /**
   * Fires when the user leaves the page. Pass it to fetch() and to addEventListener() so requests,
   * timers and listeners started by the page stop by themselves.
   */
  readonly signal: AbortSignal;
}

export type Page = (context: PageContext) => void | Promise<void>;

interface Route {
  readonly pattern: RegExp;
  readonly keys: readonly string[];
  readonly page: Page;
}

const routes: Route[] = [];
let notFoundPage: Page = ({ root }) => {
  root.textContent = "Page not found.";
};

/** Registers a page for a path like "/circuits/:id". Earlier routes win. */
export function route(path: string, page: Page): void {
  const keys: string[] = [];
  const pattern = path.replace(/:(\w+)/g, (_match, key: string) => {
    keys.push(key);
    return "([^/]+)";
  });
  routes.push({ pattern: new RegExp(`^${pattern}$`), keys, page });
}

export function setNotFoundPage(page: Page): void {
  notFoundPage = page;
}

/** Goes to another page, e.g. navigate("/circuits/123"). */
export function navigate(path: string): void {
  location.hash = `#${path}`;
}

/**
 * Goes to another page *instead of* the current one: the current page leaves the history, so
 * Back skips it. For pages that only send you on, like `#/library/:id`.
 */
export function redirect(path: string): void {
  location.replace(`#${path}`);
}

/** The current path and query, e.g. "/circuits?scope=public". */
export function currentPath(): string {
  return location.hash.replace(/^#/, "") || "/";
}

/**
 * A page with unsaved work (the editor) can register a check here. It's asked before leaving,
 * and returning false keeps the user on the page.
 */
let leaveCheck: (() => boolean) | null = null;

export function setLeaveCheck(check: (() => boolean) | null): void {
  leaveCheck = check;
}

let appRoot: HTMLElement;
let shownPath = "";
let controller: AbortController | null = null;
let ignoreNextChange = false;
const pageChangeListeners: (() => void)[] = [];

/** Called after every page change (the header uses it to highlight the current tab). */
export function onPageChange(listener: () => void): void {
  pageChangeListeners.push(listener);
}

export function startRouter(root: HTMLElement): void {
  appRoot = root;
  window.addEventListener("hashchange", () => {
    if (ignoreNextChange) {
      ignoreNextChange = false;
      return;
    }
    if (leaveCheck !== null && !leaveCheck()) {
      // Stay: put the old address back. That fires hashchange once more, which we skip.
      ignoreNextChange = true;
      location.hash = `#${shownPath}`;
      return;
    }
    void show();
  });
  void show();
}

/** Shows the current page again from scratch, e.g. after signing in. */
export function reload(): void {
  void show();
}

async function show(): Promise<void> {
  controller?.abort(); // stop everything the previous page was doing
  controller = new AbortController();
  const { signal } = controller;
  leaveCheck = null;
  shownPath = currentPath();

  const [path = "/", queryString = ""] = shownPath.split("?");
  const query = new URLSearchParams(queryString);
  let page = notFoundPage;
  let params: Record<string, string> = {};
  for (const candidate of routes) {
    const match = candidate.pattern.exec(path);
    if (match !== null) {
      page = candidate.page;
      params = Object.fromEntries(candidate.keys.map((key, index) => [key, decodeURIComponent(match[index + 1] ?? "")]));
      break;
    }
  }

  // Each page gets a fresh element. If the user leaves while the page is still loading, late
  // updates land in this detached element and are never seen.
  const root = document.createElement("div");
  root.className = "page";
  appRoot.replaceChildren(root);
  window.scrollTo(0, 0);
  for (const listener of pageChangeListeners) listener();

  try {
    await page({ root, params, query, signal });
  } catch (error) {
    if (signal.aborted) return; // the user left; whatever failed doesn't matter any more
    console.error(error);
    root.replaceChildren(errorBox(error));
  }
}
