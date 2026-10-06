import type { ListScope } from "@circuitlab/api-contract";
import { desktop } from "../desktop";
import type { Example } from "../examples";
import { chooseNetlistFile, forgetRecent } from "../offline/storage";
import { currentPath, navigate, reload } from "../router";
import { errorMessage } from "../ui";
import { currentDoc, openBlank, openExample, openFileDoc, openLibraryDoc, openOpenedFile, type Mode } from "../workspace/store";
import { toast } from "./toast";

/**
 * What the app can be asked to do, from wherever it's asked: a button, the sidebar, the command
 * palette (Ctrl K), a keyboard shortcut, or the app menu. Each is written once, here.
 */

/** Shows `path`, even if it's already showing (then it's drawn again, e.g. with another circuit). */
export function goTo(path: string): void {
  if (currentPath() === path) reload();
  else navigate(path);
}

export function goHome(): void {
  navigate("/");
}

export function goLibrary(): void {
  navigate("/library");
}

export function goSettings(): void {
  navigate("/settings");
}

export function goServer(scope: ListScope): void {
  navigate(`/circuits?scope=${scope}`);
}

/** Shows the open circuit (the workspace), in another mode if asked. */
export function showWorkspace(mode?: Mode): void {
  const doc = currentDoc();
  if (doc !== null && mode !== undefined) doc.mode = mode;
  goTo("/workspace");
}

/** A blank drawing, saved in the library (or, `forServer`, in your account). */
export function newCircuit(forServer = false): void {
  if (openBlank(forServer === true) !== null) goTo("/workspace");
}

export async function openNetlistFile(): Promise<void> {
  if (desktop() === null) {
    toast("Opening files needs the desktop app.", { error: true });
    return;
  }
  try {
    const file = await chooseNetlistFile();
    if (file !== null && openOpenedFile(file) !== null) goTo("/workspace");
  } catch (error) {
    toast(errorMessage(error), { error: true });
  }
}

export async function openRecentFile(path: string): Promise<void> {
  try {
    if ((await openFileDoc(path)) !== null) goTo("/workspace");
  } catch (error) {
    // Moved or deleted since: say so, and drop it from the list.
    forgetRecent(path);
    toast(errorMessage(error), { error: true });
  }
}

export async function openExampleCircuit(example: Example): Promise<void> {
  try {
    if ((await openExample(example)) !== null) goTo("/workspace");
  } catch (error) {
    toast(errorMessage(error), { error: true });
  }
}

export async function openLibraryCircuit(id: string): Promise<void> {
  try {
    if ((await openLibraryDoc(id)) !== null) goTo("/workspace");
  } catch (error) {
    toast(errorMessage(error), { error: true });
  }
}

export function openServerCircuit(id: string): void {
  navigate(`/circuits/${encodeURIComponent(id)}`);
}

/** What the workspace can do while it's on screen, for the command palette. */
export interface WorkspaceHooks {
  save(): void;
  setMode(mode: Mode): void;
  fit(): void;
  arrange(): void;
  toggleTable(): void;
}

let hooks: WorkspaceHooks | null = null;

/** The workspace registers itself when it appears, and null when it goes. */
export function setWorkspaceHooks(next: WorkspaceHooks | null): void {
  hooks = next;
}

export function workspaceHooks(): WorkspaceHooks | null {
  return hooks;
}

const SIDEBAR_KEY = "circuitlab.sidebarHidden";

export function sidebarHidden(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

export function toggleSidebar(): void {
  const hidden = !sidebarHidden();
  try {
    localStorage.setItem(SIDEBAR_KEY, hidden ? "1" : "0");
  } catch {
    // not remembered
  }
  document.getElementById("frame")?.classList.toggle("no-sidebar", hidden);
}
