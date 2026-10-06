import { h } from "../dom";

/**
 * Dialogs that cover the window (sign in, the command palette, the keyboard shortcuts) live in
 * #overlays, over everything else, on a dimmed background ("scrim"). Clicking the background or
 * pressing Escape closes the top one. They are kept in a stack, so Escape closes them one at a time.
 */
const stack: (() => void)[] = [];

/** Shows `content` on a scrim, and returns the function that closes it. `top`: near the top of the window (the palette). */
export function showOverlay(content: HTMLElement, options: { readonly top?: boolean; readonly label: string; readonly onClose?: () => void }): () => void {
  const scrim = h("div", { class: options.top === true ? "scrim top" : "scrim" });
  content.setAttribute("role", "dialog");
  content.setAttribute("aria-modal", "true");
  content.setAttribute("aria-label", options.label);
  scrim.append(content);
  const returnFocus = document.activeElement;

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    const index = stack.indexOf(close);
    if (index >= 0) stack.splice(index, 1);
    scrim.remove();
    options.onClose?.();
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
  }

  scrim.addEventListener("mousedown", (event) => {
    if (event.target === scrim) close();
  });
  stack.push(close);
  (document.getElementById("overlays") ?? document.body).append(scrim);
  return close;
}

/** Escape: closes the top dialog. Returns false if none was open. */
export function closeTopOverlay(): boolean {
  const close = stack[stack.length - 1];
  if (close === undefined) return false;
  close();
  return true;
}

export function overlayOpen(): boolean {
  return stack.length > 0;
}
