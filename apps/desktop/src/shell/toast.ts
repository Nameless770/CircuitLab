import { h } from "../dom";

/**
 * Short messages at the bottom of the window ("Saved."), which go away by themselves. At most
 * three at a time. A message can carry one action, such as Undo, and then stays a little longer.
 */

let container: HTMLElement | null = null;

export function startToasts(element: HTMLElement): void {
  container = element;
  container.classList.add("toasts");
  container.setAttribute("aria-live", "polite");
}

export interface ToastOptions {
  readonly action?: { readonly label: string; readonly run: () => void };
  /** Something went wrong: a red light instead of the signal colour. */
  readonly error?: boolean;
}

export function toast(text: string, options: ToastOptions = {}): void {
  if (container === null) return;
  const { action } = options;
  const item = h("div", { class: options.error === true ? "toast error" : "toast", role: options.error === true ? "alert" : "status" }, h("span", { class: "led" }), h("span", {}, text));
  if (action !== undefined) {
    const button = h("button", { type: "button" }, action.label);
    button.addEventListener("click", () => {
      item.remove();
      action.run();
    });
    item.append(button);
  }
  container.append(item);
  while (container.childElementCount > 3) container.firstElementChild?.remove();
  setTimeout(() => item.remove(), action === undefined ? 3400 : 7000);
}
