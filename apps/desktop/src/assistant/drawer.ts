import { desktop } from "../desktop";
import { checkAssistant } from "../shell/status";
import { toast } from "../shell/toast";
import { makeChatPanel, type AskMode, type ChatPanel } from "./chat";

/**
 * The assistant: describe a circuit in words, and a language model running in Ollama on this
 * computer drafts it. What it drafts is only ever a draft: the app checks it (the main process
 * builds the netlist and reads it back), shows how it behaves, and puts it in the workspace only
 * when the person says so. See docs/assistant.md.
 *
 * The panel is a chat (chat.ts). This file decides where it is shown:
 * - in the workspace, in the right-hand column (the "Assistant" tab beside "Details"), so the
 *   circuit stays in view and you can keep drawing or simulating while you ask;
 * - on any other screen, sliding in over the screen from the right.
 */

/** Where the panel is: nowhere, over the screen, or in the workspace's right-hand column. */
type Placement = "closed" | "floating" | "docked";

/** The workspace's right-hand column, while the workspace is on screen. */
export interface AssistantDock {
  /** Puts the panel in the column, and shows it (the Assistant tab). */
  show(element: HTMLElement): void;
  /** The panel left the column: show the details again. */
  hide(): void;
}

/** The panel stays in memory while closed, so the chat is still there next time. */
let panel: ChatPanel | null = null;
let placement: Placement = "closed";
let dock: AssistantDock | null = null;

/** True while the panel slides over the screen (Esc closes it then). */
export function assistantFloating(): boolean {
  return placement === "floating";
}

/** True while the keyboard is in the panel (the request box, its buttons). */
export function assistantHasFocus(): boolean {
  return panel !== null && placement !== "closed" && panel.element.contains(document.activeElement);
}

/**
 * Opens the panel: in the workspace's column if the workspace is on screen, else over the screen.
 * `mode` says what the next message is for: a change to the open circuit, or a new circuit.
 * `focus: false` leaves the keyboard where it is (the workspace opening it by itself).
 */
export function openAssistant(mode?: AskMode, { focus = true }: { readonly focus?: boolean } = {}): void {
  const bridge = desktop();
  if (bridge === null) {
    toast("The assistant is part of the desktop app.", { error: true });
    return;
  }
  panel ??= makeChatPanel(bridge, { docked: () => placement === "docked", close: closeAssistant });
  const wasClosed = placement === "closed";
  if (dock !== null) {
    if (placement !== "docked") {
      panel.element.remove(); // it may have been over the screen
      panel.element.classList.add("docked");
      dock.show(panel.element);
      placement = "docked";
    }
  } else if (placement !== "floating") {
    panel.element.classList.remove("docked");
    (document.getElementById("overlays") ?? document.body).append(panel.element);
    placement = "floating";
  }
  if (mode !== undefined) panel.setMode(mode);
  panel.redraw();
  if (wasClosed) void checkAssistant(); // Ollama may have started (or stopped) since
  if (focus) panel.focus();
}

export function closeAssistant(): void {
  if (panel === null || placement === "closed") return;
  const wasDocked = placement === "docked";
  panel.element.remove();
  placement = "closed";
  if (wasDocked) dock?.hide();
}

/**
 * The workspace offers its right-hand column while it is on screen (until `signal` aborts).
 * `open`: show the panel there at once (the column was on the Assistant tab last time). A panel
 * already over the screen moves into the column.
 */
export function offerAssistantDock(next: AssistantDock, open: boolean, signal: AbortSignal): void {
  dock = next;
  signal.addEventListener(
    "abort",
    () => {
      if (dock !== next) return;
      dock = null;
      if (placement === "docked") {
        panel?.element.remove();
        placement = "closed";
      }
    },
    { once: true },
  );
  if (open || placement === "floating") openAssistant(undefined, { focus: false });
}
