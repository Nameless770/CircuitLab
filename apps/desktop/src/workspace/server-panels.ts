import type { CircuitResource, ShareResource, ShareRole, SimulationRunResource, TruthTableJobResource, Visibility } from "@circuitlab/api-contract";
import { cancelJob, downloadJobResult, getJob, listRuns, listShares, shareCircuit, startTruthTableJob, unshareCircuit, updateCircuit } from "../api";
import { appendAll, fileNameFor, formatDate, h, saveFile, sleep } from "../dom";
import { currentSession } from "../session";
import { emit } from "../shell/bus";
import { toast } from "../shell/toast";
import { errorBox, errorMessage, field, loading, runAction } from "../ui";
import type { Ws } from "./context";
import { docChanged } from "./store";

/**
 * For a circuit on the server, what only the server has, in the inspector's Simulate panel:
 * who owns it and who can see it, sharing (owner only), background truth-table jobs and the
 * history of runs (signed in). Each is a section that opens on a click, and loads only then.
 *
 * The inspector is drawn again after every simulation step, so the sections are made once per
 * version of the circuit and reused, instead of asking the server again each time.
 */
const made = new WeakMap<Ws, { readonly version: number; readonly panels: HTMLElement[] }>();

export function serverPanels(ws: Ws): HTMLElement[] {
  const server = ws.doc.server;
  if (ws.doc.source.kind !== "server" || server === undefined) return [];
  const known = made.get(ws);
  if (known !== undefined && known.version === server.circuit.version) return known.panels;
  const panels = makePanels(ws, server.circuit);
  made.set(ws, { version: server.circuit.version, panels });
  return panels;
}

function makePanels(ws: Ws, circuit: CircuitResource): HTMLElement[] {
  const session = currentSession();
  const isOwner = session?.user.id === circuit.owner.id;
  const panels = [about(ws, circuit, isOwner)];
  if (isOwner) panels.push(section("Sharing", (body) => sharing(circuit, body, ws.signal)));
  if (session !== null && circuit.summary.feedbackLoop === null) panels.push(section("Big tables", (body) => jobs(circuit, body, ws.signal)));
  if (session !== null) panels.push(section("Recent runs", (body) => runs(circuit, isOwner, body, ws.signal)));
  return panels;
}

/** A section that opens on a click; `fill` runs the first time it opens. */
function section(title: string, fill: (body: HTMLElement) => void, open = false): HTMLElement {
  const body = h("div", { class: "more-body" });
  const details = h("details", { class: "more", open }, h("summary", {}, h("span", { class: "label" }, title)), body);
  let filled = false;
  const fillOnce = (): void => {
    if (filled || !details.open) return;
    filled = true;
    fill(body);
  };
  details.addEventListener("toggle", fillOnce);
  fillOnce();
  return details;
}

// ---- who owns it, and who can see it ---------------------------------------------------------------

function about(ws: Ws, circuit: CircuitResource, isOwner: boolean): HTMLElement {
  return section(
    "On the server",
    (body) => {
      appendAll(
        body,
        h("p", {}, `By ${circuit.owner.displayName} · version ${circuit.version} · updated ${formatDate(circuit.updatedAt)}`),
        isOwner ? null : h("p", {}, `${circuit.owner.displayName} owns this circuit. If they shared it with you as an editor you can change it; otherwise you can look, simulate, and save a copy.`),
      );
      if (!isOwner) return;
      const message = h("div");
      const choice = h("div", { class: "seg sm fill", role: "group", "aria-label": "Who can see it" });
      for (const [value, label] of [
        ["private", "Private"],
        ["public", "Public"],
      ] as const) {
        const button = h("button", { type: "button", "aria-pressed": circuit.visibility === value ? "true" : "false", title: value === "public" ? "Anyone can see it (read-only)" : "Only you and the people you share it with" }, label);
        button.addEventListener("click", () => {
          if (circuit.visibility === value) return;
          void runAction(button, message, async () => setVisibility(ws, value));
        });
        choice.append(button);
      }
      body.append(field("Who can see it", choice), message);
    },
    true,
  );
}

async function setVisibility(ws: Ws, visibility: Visibility): Promise<void> {
  const server = ws.doc.server;
  if (server === undefined) return;
  // A JSON Merge Patch: only what's sent changes. It makes a new version.
  const saved = await updateCircuit(server.circuit.id, { visibility }, server.etag);
  ws.doc.server = { circuit: saved.circuit, etag: saved.etag };
  emit("server");
  docChanged();
  ws.refresh("head", "inspector");
  toast(visibility === "public" ? "Public: anyone can see it now." : "Private: only you and the people you share it with.");
}

// ---- sharing ----------------------------------------------------------------------------------------

function sharing(circuit: CircuitResource, body: HTMLElement, signal: AbortSignal): void {
  const list = h("div", { class: "runs" }, loading());
  const message = h("div");

  async function refresh(): Promise<void> {
    try {
      const { items } = await listShares(circuit.id, signal);
      list.replaceChildren(...(items.length === 0 ? [h("p", {}, "Not shared with anyone yet.")] : items.map(shareRow)));
    } catch (error) {
      if (!signal.aborted) list.replaceChildren(errorBox(error));
    }
  }

  function shareRow(share: ShareResource): HTMLElement {
    const role = roleSelect(share.role);
    role.addEventListener("change", () => {
      // Sharing again with the same person changes their role.
      void shareCircuit(circuit.id, share.user.email, role.value as ShareRole).then(refresh, (error: unknown) => message.replaceChildren(errorBox(error)));
    });
    const remove = h("button", { type: "button", class: "btn sm danger" }, "Remove");
    remove.addEventListener("click", () => {
      void runAction(remove, message, async () => {
        await unshareCircuit(circuit.id, share.user.id);
        await refresh();
      });
    });
    return h("div", { class: "share-row" }, h("div", { class: "who" }, h("strong", {}, share.user.displayName), h("div", {}, share.user.email)), role, remove);
  }

  const email = h("input", { type: "email", class: "input", required: true, placeholder: "their@email.com", maxlength: 254 });
  const newRole = roleSelect("viewer");
  const add = h("button", { type: "submit", class: "btn primary self-start" }, "Share");
  const form = h("form", { class: "form" }, field("Email of their account", email), field("Role", newRole), add);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void runAction(add, message, async () => {
      await shareCircuit(circuit.id, email.value.trim(), newRole.value as ShareRole);
      email.value = "";
      await refresh();
    });
  });

  body.append(h("p", {}, "Viewers can look at the circuit and simulate it. Editors can also change it. Only you can delete it, share it, or make it public."), list, form, message);
  void refresh();
}

function roleSelect(selected: ShareRole): HTMLSelectElement {
  return h(
    "select",
    { class: "input", "aria-label": "Role" },
    h("option", { value: "viewer", selected: selected === "viewer" }, "Viewer"),
    h("option", { value: "editor", selected: selected === "editor" }, "Editor"),
  );
}

// ---- background truth-table jobs --------------------------------------------------------------------

/**
 * Truth tables too big to download at once are computed by the server in the background
 * (phase 10): start a job (202 Accepted), ask how it's going every few seconds (the API's
 * Retry-After says how often), and download the result when it's done.
 */
function jobs(circuit: CircuitResource, body: HTMLElement, signal: AbortSignal): void {
  const status = h("div", { class: "more-body" });
  const start = h("button", { type: "button", class: "btn md self-start" }, "Compute in the background");
  start.addEventListener("click", () => {
    void runAction(start, status, async () => {
      const job = await startTruthTableJob(circuit.id, circuit.version);
      await follow(job);
    });
  });

  async function follow(first: TruthTableJobResource): Promise<void> {
    let job = first;
    let retryAfter = 2;
    while (job.status === "queued" || job.status === "running") {
      show(job);
      await sleep(retryAfter * 1000, signal); // stops if the workspace goes away
      const answer = await getJob(job.links.self, signal);
      job = answer.job;
      retryAfter = answer.retryAfter ?? 2;
    }
    show(job);
  }

  function show(job: TruthTableJobResource): void {
    const percent = job.limit === 0 ? 100 : Math.floor((job.rowsDone / job.limit) * 100);
    const parts: HTMLElement[] = [
      h("p", {}, h("strong", {}, statusText(job)), ` ${job.rowsDone.toLocaleString()} of ${job.limit.toLocaleString()} rows.`),
      h("div", { class: "progress", role: "progressbar", "aria-valuenow": percent, "aria-valuemin": 0, "aria-valuemax": 100 }, h("div", { style: `width: ${percent}%` })),
    ];
    if (job.status === "queued" || job.status === "running") {
      const cancel = h("button", { type: "button", class: "btn sm self-start" }, "Cancel");
      cancel.addEventListener("click", () => void cancelJob(job.links.self).catch((error: unknown) => status.append(errorBox(error))));
      parts.push(cancel);
    }
    const resultUrl = job.links.result;
    if (job.status === "succeeded" && resultUrl !== undefined) {
      const download = h("button", { type: "button", class: "btn sm primary self-start" }, "Download result (CSV)");
      download.addEventListener("click", () => {
        void runAction(download, status, async () => saveFile(await downloadJobResult(resultUrl), `${fileNameFor(circuit.name)}-truth-table.csv`));
      });
      parts.push(download);
      if (job.expiresAt !== undefined) parts.push(h("p", {}, `Kept on the server until ${new Date(job.expiresAt).toLocaleString()}.`));
    }
    status.replaceChildren(...parts);
  }

  body.append(
    h("p", {}, "Tables over 1,048,576 rows are too big to download at once. The server can compute any size in the background: start a job, watch it progress, and download the result when it's done (kept for 24 hours)."),
    start,
    status,
  );
}

function statusText(job: TruthTableJobResource): string {
  switch (job.status) {
    case "queued":
      return "Waiting for a worker…";
    case "running":
      return "Computing…";
    case "succeeded":
      return "Done.";
    case "cancelled":
      return "Cancelled.";
    case "failed":
      return `Failed (${job.errorCode ?? "unknown error"}).`;
  }
}

// ---- the history of runs ------------------------------------------------------------------------

/** The server records every simulation (phase 5's simulation_runs table). This shows the latest. */
function runs(circuit: CircuitResource, isOwner: boolean, body: HTMLElement, signal: AbortSignal): void {
  const list = h("div", { class: "runs" }, loading());

  async function refresh(): Promise<void> {
    list.replaceChildren(loading());
    try {
      const { items } = await listRuns(circuit.id, signal);
      list.replaceChildren(...(items.length === 0 ? [h("p", {}, "No runs yet.")] : items.slice(0, 20).map(runRow)));
    } catch (error) {
      if (!signal.aborted) list.replaceChildren(h("div", { class: "alert error" }, errorMessage(error)));
    }
  }

  const refreshButton = h("button", { type: "button", class: "btn sm self-start" }, "Refresh");
  refreshButton.addEventListener("click", () => void refresh());
  body.append(h("p", {}, isOwner ? "Every simulation of this circuit, by anyone, newest first." : "Your simulations of this circuit, newest first."), list, refreshButton);
  void refresh();
}

function runRow(run: SimulationRunResource): HTMLElement {
  const badge = h("span", { class: run.status === "succeeded" ? "badge ok" : run.status === "failed" ? "badge bad" : "badge" }, run.errorCode ?? run.status);
  return h(
    "div",
    { class: "run" },
    h("div", { class: "top" }, h("span", {}, run.kind === "truth_table" ? "Truth-table job" : `Simulation (${run.mode})`), badge),
    h("div", { class: "detail", title: describeRun(run) }, describeRun(run)),
    h("div", { class: "detail" }, `${formatDate(run.createdAt)} · version ${run.circuitVersion}`),
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
