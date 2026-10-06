/**
 * A few app-wide events, so that one part of the window can say "this changed" and every part that
 * shows it can redraw: the sidebar counts library circuits, the home screen lists them, and both
 * must know when one is saved.
 *
 * - `library`: a circuit was saved in, or deleted from, the library.
 * - `server`: circuits on the server changed (created, deleted), or the server address did.
 * - `status`: the server's or the assistant's status was checked again (shell/status.ts).
 * - `assistant`: the assistant's settings changed.
 */
export type Topic = "library" | "server" | "status" | "assistant";

const listeners = new Map<Topic, Set<() => void>>();

/** Calls `listener` whenever `topic` happens. Returns a function that stops it. */
export function on(topic: Topic, listener: () => void, signal?: AbortSignal): () => void {
  let set = listeners.get(topic);
  if (set === undefined) {
    set = new Set();
    listeners.set(topic, set);
  }
  set.add(listener);
  const stop = (): void => void listeners.get(topic)?.delete(listener);
  signal?.addEventListener("abort", stop, { once: true });
  return stop;
}

export function emit(topic: Topic): void {
  for (const listener of [...(listeners.get(topic) ?? [])]) listener();
}
