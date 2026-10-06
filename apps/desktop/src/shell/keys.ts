import { assistantFloating, assistantHasFocus, closeAssistant, openAssistant } from "../assistant/drawer";
import { desktop } from "../desktop";
import { goHome, goLibrary, goSettings, newCircuit, openNetlistFile, toggleSidebar } from "./commands";
import { closeTopOverlay, overlayOpen } from "./overlay";
import { openPalette } from "./palette";
import { openShortcuts } from "./shortcuts";

/**
 * The keyboard shortcuts that work on every screen (the workspace adds its own: Ctrl S, 1 to 9,
 * T, ...). The list is in shortcuts.ts, which `?` shows.
 */
export function startKeys(): void {
  window.addEventListener("keydown", (event) => {
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (ctrl && !event.shiftKey && !event.altKey && key === "k") {
      event.preventDefault();
      openPalette();
      return;
    }
    if (event.key === "Escape") {
      // The top dialog first, then the assistant's panel when it is over the screen. Whatever
      // closes, the key stops here (the workspace would otherwise also take it, and drop the selection).
      let closed = closeTopOverlay();
      if (!closed && assistantFloating()) {
        closeAssistant();
        closed = true;
      }
      // In the workspace's column the panel stays: Esc only leaves its text box, so the
      // workspace's own keys (1 to 9, T, F, ...) work again.
      if (!closed && assistantHasFocus() && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
        closed = true;
      }
      if (closed) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    if (overlayOpen()) return; // a dialog has the keyboard

    if (ctrl && !event.shiftKey && !event.altKey) {
      const actions: Record<string, () => void> = {
        n: () => newCircuit(),
        o: () => void openNetlistFile(),
        j: () => openAssistant(),
        h: goHome,
        l: goLibrary,
        b: toggleSidebar,
        ",": goSettings,
      };
      const action = actions[key];
      if (action !== undefined) {
        // In a browser tab (development) Ctrl+N and Ctrl+L belong to the browser.
        if (desktop() === null && (key === "n" || key === "l" || key === "o")) return;
        event.preventDefault();
        action();
      }
      return;
    }

    const target = event.target as HTMLElement;
    const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
    if (!typing && event.key === "?") {
      event.preventDefault();
      openShortcuts();
    }
  });
}
