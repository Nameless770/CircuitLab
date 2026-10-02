/**
 * Small helpers for building the page out of real DOM elements.
 *
 * Why not template strings and innerHTML? Circuit names, descriptions, gate labels and display
 * names are typed by users. Put into innerHTML, a circuit named `<img src=x onerror=alert(1)>`
 * would run as code in everyone's browser (XSS). Text set through these helpers always goes
 * through textContent / createTextNode, which never interprets HTML.
 */

export type Child = Node | string | number | null | undefined | false;
type Children = (Child | readonly Child[])[];

/** Attributes, plus `on<event>` handlers: h("button", { class: "primary", onclick: save }, "Save"). */
export type Props = Record<string, string | number | boolean | null | undefined | ((event: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Children): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  setProps(element, props);
  append(element, children);
  return element;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Same as h(), for SVG elements (they need their own namespace). */
export function s<K extends keyof SVGElementTagNameMap>(tag: K, props: Props = {}, ...children: Children): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  setProps(element, props);
  append(element, children);
  return element;
}

function setProps(element: Element, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (typeof value === "function") element.addEventListener(key.replace(/^on/, ""), value);
    else element.setAttribute(key, value === true ? "" : String(value));
  }
}

/** Like element.append(), but skips null/undefined/false, so optional parts can be written inline. */
export function appendAll(element: Element, ...children: Children): void {
  append(element, children);
}

function append(element: Element, children: Children): void {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : String(child));
  }
}

/** Waits `ms` milliseconds, or rejects as soon as `signal` fires (the user left the page). */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Makes the browser save `blob` as a file, like clicking a download link. */
export function saveFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: fileName });
  document.body.append(link);
  link.click();
  link.remove();
  // The download has started by now; free the memory a little later to be safe.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** "Full adder (v2)" -> "full-adder-v2", for file names. */
export function fileNameFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "circuit" : slug;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function plural(count: number, word: string): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}
