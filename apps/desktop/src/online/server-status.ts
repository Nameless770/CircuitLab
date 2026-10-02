import { desktop } from "../desktop";
import { h } from "../dom";

/**
 * A line saying whether online mode's server answers, checked with the API's /health endpoint,
 * so a stopped server (or a wrong address) is obvious before anything else fails.
 */
export function serverStatusLine(signal: AbortSignal): HTMLElement {
  const line = h("p", { class: "server-status muted" }, "Checking the server…");
  void check(line, signal);
  return line;
}

async function check(line: HTMLElement, signal: AbortSignal): Promise<void> {
  const where = (await desktop()?.getSettings())?.apiUrl ?? "the server";
  try {
    const response = await fetch("/health", { signal });
    const health = (await response.json()) as { status?: string; storage?: { kind?: string } };
    if (health.status !== "ok") throw new Error("unhealthy");
    const storage = health.storage?.kind === "postgresql" ? "PostgreSQL" : "memory only: circuits are lost when it stops";
    line.replaceChildren(h("span", { class: "dot dot-ok" }), `Server online at ${where} (storage: ${storage}).`);
  } catch {
    if (signal.aborted) return;
    line.replaceChildren(
      h("span", { class: "dot dot-bad" }),
      `Can't reach the server at ${where}. Start it with `,
      h("code", {}, "npm run start:api"),
      ", change the address in ",
      h("a", { href: "#/settings" }, "Settings"),
      ", or use offline mode.",
    );
  }
}
