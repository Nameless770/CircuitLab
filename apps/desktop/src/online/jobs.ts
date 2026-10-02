import type { CircuitResource, TruthTableJobResource } from "@circuitlab/api-contract";
import { cancelJob, downloadJobResult, getJob, startTruthTableJob } from "../api";
import { fileNameFor, h, saveFile, sleep } from "../dom";
import { errorBox, runAction } from "../ui";

/**
 * Truth tables too big to download at once are computed by the server in the background
 * (phase 10): start a job (202 Accepted), ask how it's going every few seconds (the API's
 * Retry-After says how often), and download the result when it's done.
 */
export function jobsPanel(circuit: CircuitResource, signal: AbortSignal): HTMLElement {
  const status = h("div");
  const start = h("button", { class: "small" }, "Compute in the background");
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
      await sleep(retryAfter * 1000, signal); // stops if the user leaves the page
      const answer = await getJob(job.links.self, signal);
      job = answer.job;
      retryAfter = answer.retryAfter ?? 2;
    }
    show(job);
  }

  function show(job: TruthTableJobResource): void {
    const percent = job.limit === 0 ? 100 : Math.floor((job.rowsDone / job.limit) * 100);
    const parts: (HTMLElement | string)[] = [
      h("p", {}, h("strong", {}, statusText(job)), ` ${job.rowsDone.toLocaleString()} of ${job.limit.toLocaleString()} rows.`),
      h("div", { class: "progress", role: "progressbar", "aria-valuenow": percent, "aria-valuemin": 0, "aria-valuemax": 100 }, h("div", { style: `width: ${percent}%` })),
    ];
    if (job.status === "queued" || job.status === "running") {
      const cancel = h("button", { class: "small" }, "Cancel");
      cancel.addEventListener("click", () => void cancelJob(job.links.self).catch((error: unknown) => status.append(errorBox(error))));
      parts.push(cancel);
    }
    const resultUrl = job.links.result;
    if (job.status === "succeeded" && resultUrl !== undefined) {
      const download = h("button", { class: "small primary" }, "Download result (CSV)");
      download.addEventListener("click", () => {
        void runAction(download, status, async () => saveFile(await downloadJobResult(resultUrl), `${fileNameFor(circuit.name)}-truth-table.csv`));
      });
      parts.push(download);
      if (job.expiresAt !== undefined) parts.push(h("p", { class: "muted small" }, `Kept on the server until ${new Date(job.expiresAt).toLocaleString()}.`));
    }
    status.replaceChildren(...parts);
  }

  return h(
    "div",
    { class: "section" },
    h("h3", {}, "Big tables"),
    h(
      "p",
      { class: "muted" },
      "Tables over 1,048,576 rows are too big to download at once. The server can compute any size in the background: start a job, watch it progress, and download the result when it's done (kept for 24 hours).",
    ),
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
