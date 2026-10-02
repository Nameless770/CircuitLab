import type { CircuitResource, SimulationRunResource } from "@circuitlab/api-contract";
import { listRuns } from "../api";
import { formatDate, h } from "../dom";
import { errorBox, loading } from "../ui";

/** The server records every simulation (phase 5's simulation_runs table). This shows the latest. */
export function runsSection(circuit: CircuitResource, isOwner: boolean, signal: AbortSignal): HTMLElement {
  const body = h("div", {}, loading());

  async function refresh(): Promise<void> {
    body.replaceChildren(loading());
    try {
      const { items } = await listRuns(circuit.id, signal);
      body.replaceChildren(items.length === 0 ? h("p", { class: "muted" }, "No runs yet.") : runsTable(items));
    } catch (error) {
      if (!signal.aborted) body.replaceChildren(errorBox(error));
    }
  }

  const refreshButton = h("button", { class: "small" }, "Refresh");
  refreshButton.addEventListener("click", () => void refresh());
  void refresh();

  return h(
    "section",
    { class: "card section" },
    h("h2", {}, "Recent runs", refreshButton),
    h("p", { class: "muted" }, isOwner ? "Every simulation of this circuit, by anyone, newest first." : "Your simulations of this circuit, newest first."),
    body,
  );
}

function runsTable(runs: readonly SimulationRunResource[]): HTMLElement {
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "What"), h("th", {}, "Inputs → outputs"), h("th", {}, "Version"), h("th", {}, "Result"))),
      h(
        "tbody",
        {},
        runs.map((run) =>
          h(
            "tr",
            {},
            h("td", {}, formatDate(run.createdAt)),
            h("td", {}, run.kind === "truth_table" ? "Truth-table job" : `Simulation (${run.mode})`),
            h("td", { class: "small" }, describeRun(run)),
            h("td", {}, String(run.circuitVersion)),
            h("td", {}, h("span", { class: run.status === "succeeded" ? "badge ok" : run.status === "failed" ? "badge bad" : "badge" }, run.errorCode ?? run.status)),
          ),
        ),
      ),
    ),
  );
}

function describeRun(run: SimulationRunResource): string {
  if (run.kind === "truth_table") {
    const first = run.offset ?? 0;
    return run.limit === undefined ? `rows from ${first.toLocaleString()}` : `rows ${first.toLocaleString()}–${(first + run.limit - 1).toLocaleString()}`;
  }
  const values = (record: Readonly<Record<string, unknown>> | undefined): string =>
    record === undefined ? "–" : Object.entries(record).map(([id, value]) => `${id}=${String(value)}`).join(" ");
  return `${values(run.inputs)} → ${values(run.outputs)}`;
}
