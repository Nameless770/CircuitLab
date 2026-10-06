import { signOut } from "../api";
import { openAssistant } from "../assistant/drawer";
import { desktop } from "../desktop";
import { h } from "../dom";
import { EXAMPLES } from "../examples";
import { fileName, libraryItems, recentFiles } from "../offline/storage";
import { currentSession } from "../session";
import { closeDoc, currentDoc, docLabel } from "../workspace/store";
import {
  goHome,
  goLibrary,
  goServer,
  goSettings,
  newCircuit,
  openExampleCircuit,
  openLibraryCircuit,
  openNetlistFile,
  openRecentFile,
  showWorkspace,
  toggleSidebar,
  sidebarHidden,
  workspaceHooks,
} from "./commands";
import { showOverlay } from "./overlay";
import { openShortcuts } from "./shortcuts";
import { openSignIn } from "./sign-in";
import { currentTheme, toggleTheme } from "./theme";
import { toast } from "./toast";

/**
 * The command palette (Ctrl K): type a few letters of a command or a circuit's name, then Enter.
 * Everything the app does is in here, so nothing needs the mouse.
 */
interface Command {
  readonly group: string;
  readonly title: string;
  readonly hint?: string;
  run(): void;
}

let close: (() => void) | null = null;

export function openPalette(): void {
  if (close !== null) {
    close();
    return;
  }
  let commands = baseCommands();
  let shown: Command[] = commands;
  let active = 0;

  const input = h("input", { type: "text", placeholder: "Type a command or a circuit name", "aria-label": "Command or circuit name", autocomplete: "off", spellcheck: "false" });
  const list = h("div", { class: "palette-list", role: "listbox" });
  const box = h(
    "div",
    { class: "palette" },
    input,
    list,
    h("div", { class: "palette-foot" }, h("span", {}, "↑↓ move"), h("span", {}, "Enter run"), h("span", {}, "Esc close")),
  );

  function filter(): void {
    const query = input.value.trim().toLowerCase();
    shown = commands.filter((command) => query === "" || command.title.toLowerCase().includes(query) || command.group.toLowerCase().includes(query));
    active = Math.min(active, Math.max(0, shown.length - 1));
    draw();
  }

  function draw(): void {
    if (shown.length === 0) {
      list.replaceChildren(h("div", { class: "palette-empty" }, "Nothing matches."));
      return;
    }
    const items: HTMLElement[] = [];
    shown.forEach((command, index) => {
      if (index === 0 || shown[index - 1]?.group !== command.group) items.push(h("div", { class: "palette-group" }, command.group));
      const item = h(
        "button",
        { type: "button", class: index === active ? "palette-item active" : "palette-item", role: "option", "aria-selected": index === active ? "true" : "false" },
        h("span", {}, command.title),
        command.hint === undefined ? null : h("span", { class: "hint" }, command.hint),
      );
      item.addEventListener("click", () => run(command));
      item.addEventListener("mousemove", () => {
        if (active === index) return;
        active = index;
        draw();
      });
      items.push(item);
    });
    list.replaceChildren(...items);
    list.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  }

  function run(command: Command): void {
    close?.();
    setTimeout(command.run, 0); // after the palette has gone, so the command's own dialogs get the focus
  }

  input.addEventListener("input", () => {
    active = 0;
    filter();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = Math.min(shown.length - 1, active + 1);
      draw();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      active = Math.max(0, active - 1);
      draw();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = shown[active];
      if (command !== undefined) run(command);
    }
  });

  close = showOverlay(box, {
    top: true,
    label: "Command palette",
    onClose: () => {
      close = null;
    },
  });
  filter();
  input.focus();

  // The library's circuits join the list as soon as they're read.
  if (desktop() !== null) {
    void libraryItems().then(
      (items) => {
        if (close === null) return;
        commands = [...commands, ...items.map((item) => ({ group: "Library", title: item.name, hint: "open", run: () => void openLibraryCircuit(item.id) }))];
        filter();
      },
      () => {},
    );
  }
}

function baseCommands(): Command[] {
  const commands: Command[] = [];
  const add = (group: string, title: string, hint: string | undefined, run: () => void): void => {
    commands.push({ group, title, ...(hint !== undefined && { hint }), run });
  };
  const doc = currentDoc();
  const hooks = workspaceHooks();
  const isDesktop = desktop() !== null;
  const signedIn = currentSession() !== null;

  add("Go to", "Home", "Ctrl H", goHome);
  if (isDesktop) add("Go to", "Library", "Ctrl L", goLibrary);
  if (doc !== null) add("Go to", `Open circuit: ${docLabel(doc)}`, undefined, () => showWorkspace());
  add("Go to", "My circuits", undefined, () => goServer("owned"));
  add("Go to", "Shared with me", undefined, () => goServer("shared"));
  add("Go to", "Public circuits", undefined, () => goServer("public"));
  add("Go to", "Settings", "Ctrl ,", goSettings);

  add("Circuit", "New circuit", "Ctrl N", () => newCircuit());
  if (signedIn) add("Circuit", "New circuit in my account", undefined, () => newCircuit(true));
  if (isDesktop) add("Circuit", "Open netlist file…", "Ctrl O", () => void openNetlistFile());
  if (isDesktop) add("Circuit", "Ask the assistant", "Ctrl J", () => openAssistant());
  if (doc !== null) {
    add("Circuit", "Simulate", "Ctrl 1", () => (hooks === null ? showWorkspace("sim") : hooks.setMode("sim")));
    add("Circuit", "Draw", "Ctrl 2", () => (hooks === null ? showWorkspace("draw") : hooks.setMode("draw")));
    add("Circuit", "Edit netlist", "Ctrl 3", () => (hooks === null ? showWorkspace("net") : hooks.setMode("net")));
    if (hooks !== null) {
      add("Circuit", "Show or hide the truth table", "T", hooks.toggleTable);
      add("Circuit", "Fit drawing to window", "F", hooks.fit);
      add("Circuit", "Arrange automatically", "A", hooks.arrange);
      add("Circuit", "Save", "Ctrl S", hooks.save);
    }
    add("Circuit", "Close circuit", undefined, () => {
      if (closeDoc()) goHome();
    });
  }
  if (isDesktop) for (const example of EXAMPLES) add("Examples", `Open example: ${example.name}`, undefined, () => void openExampleCircuit(example));
  if (isDesktop) for (const path of recentFiles()) add("Recent files", fileName(path), undefined, () => void openRecentFile(path));

  add("App", currentTheme() === "dark" ? "Switch to light theme" : "Switch to dark theme", undefined, toggleTheme);
  add("App", sidebarHidden() ? "Show sidebar" : "Hide sidebar", "Ctrl B", toggleSidebar);
  add("App", "Keyboard shortcuts", "?", openShortcuts);
  if (signedIn) add("App", "Sign out", undefined, () => void signOut().then(() => toast("Signed out.")));
  else add("App", "Sign in…", undefined, () => openSignIn("in"));
  return commands;
}
