import type { AssistantStatus } from "../../electron/bridge";
import { desktop } from "../desktop";
import { emit } from "./bus";

/**
 * Whether online mode's server answers, and what the assistant would use. The sidebar shows both
 * at all times, so they are checked here once for everyone, every 30 seconds for the server, and
 * again whenever Settings changes an address. Every check ends with the "status" event.
 */
export type ServerState =
  | { readonly kind: "checking" }
  /** /health said ok; `ms` is how long the answer took. */
  | { readonly kind: "online"; readonly url: string; readonly ms: number; readonly memoryOnly: boolean }
  /** The server answers, but its database or Redis doesn't (/health says 503). */
  | { readonly kind: "unhealthy"; readonly url: string }
  | { readonly kind: "offline"; readonly url: string };

let server: ServerState = { kind: "checking" };
/** null until asked, and always outside the desktop app (the assistant is part of it). */
let assistant: AssistantStatus | null = null;

export function serverState(): ServerState {
  return server;
}

export function assistantState(): AssistantStatus | null {
  return assistant;
}

export async function checkServer(): Promise<void> {
  const url = (await desktop()?.getSettings())?.apiUrl ?? "the server";
  const started = performance.now();
  try {
    const response = await fetch("/health", { signal: AbortSignal.timeout(5000) });
    const body = (await response.json()) as { status?: string; code?: string; storage?: { kind?: string } };
    const ms = Math.round(performance.now() - started);
    // When the server can't be reached at all, the main process answers 503 itself, with the code
    // server-unavailable (electron/main.ts); the server's own 503 says status "unavailable".
    if (body.status === "ok") server = { kind: "online", url, ms, memoryOnly: body.storage?.kind !== "postgresql" };
    else if (body.code === "server-unavailable") server = { kind: "offline", url };
    else server = { kind: "unhealthy", url };
  } catch {
    server = { kind: "offline", url };
  }
  emit("status");
}

export async function checkAssistant(): Promise<void> {
  const bridge = desktop();
  if (bridge === null) return;
  assistant = await bridge.assistantStatus();
  emit("status");
}

export function startStatusChecks(): void {
  void checkServer();
  void checkAssistant();
  setInterval(() => void checkServer(), 30_000);
}

/** One line about the server, for the sidebar and the home screen. */
export function serverLine(state: ServerState = server): { readonly text: string; readonly tone: "ok" | "bad" | "off" } {
  switch (state.kind) {
    case "checking":
      return { text: "Checking the server…", tone: "off" };
    case "online":
      return { text: `Server online · ${state.ms} ms`, tone: "ok" };
    case "unhealthy":
      return { text: "Server answers, but its database or Redis doesn't", tone: "bad" };
    case "offline":
      return { text: "Server offline", tone: "bad" };
  }
}
