import iconUrl from "../../build/icon.svg";
import { h } from "../dom";
import { currentPath, onPageChange } from "../router";
import { currentDoc, docLabel, onDocChange } from "../workspace/store";
import { openPalette } from "./palette";
import { currentTheme, onAppearanceChange, toggleTheme } from "./theme";

/**
 * The window's title bar: the app's name and where you are, the search box that opens the
 * command palette (Ctrl K), and the theme switch. Its empty parts move the window, and Windows
 * draws the minimize, maximize and close buttons over its right end (electron/main.ts).
 */
export function startTitleBar(element: HTMLElement): void {
  const draw = (): void => element.replaceChildren(...titleBar());
  onPageChange(draw);
  onDocChange(draw);
  onAppearanceChange(draw);
  draw();
}

const SCOPE_TITLES: Record<string, string> = { owned: "My circuits", shared: "Shared with me", public: "Public circuits" };

/** Where you are, in a few words. */
export function crumb(): string {
  const [path = "/", query = ""] = currentPath().split("?");
  if (path === "/") return "Home";
  if (path === "/library") return "Library";
  if (path === "/settings") return "Settings";
  if (path === "/circuits") return SCOPE_TITLES[new URLSearchParams(query).get("scope") ?? ""] ?? "Circuits";
  const doc = currentDoc();
  if (path === "/workspace" && doc !== null) return docLabel(doc);
  return "";
}

function titleBar(): HTMLElement[] {
  const doc = currentDoc();
  const onWorkspace = currentPath().startsWith("/workspace");
  const search = h("button", { type: "button", class: "tb-search", title: "Search circuits and commands (Ctrl K)" }, h("span", {}, "Search circuits and commands"), h("span", { class: "kbd solid" }, "Ctrl K"));
  search.addEventListener("click", openPalette);
  const theme = h("button", { type: "button", class: "tb-theme", title: "Switch theme" }, currentTheme() === "dark" ? "Light" : "Dark");
  theme.addEventListener("click", toggleTheme);
  return [
    h(
      "div",
      { class: "tb-brand" },
      h("img", { src: iconUrl, alt: "", width: 18, height: 18 }),
      h("span", { class: "tb-name" }, "CircuitLab"),
      h("span", { class: "faint" }, "/"),
      h("span", { class: "tb-crumb" }, crumb()),
      onWorkspace && doc?.dirty === true ? h("span", { class: "tb-dirty", title: "Unsaved changes" }) : null,
    ),
    search,
    h("div", { class: "tb-right" }, theme),
  ];
}
