// Media types and content negotiation. One resource can have several representations: a circuit
// is JSON or a netlist file; a truth table is a JSON page, NDJSON, or CSV. The client says what it
// sends (Content-Type) and what it wants back (Accept); the spec says what each operation offers.

import type { Bit, TruthTable, TruthTableRow } from "@circuitlab/engine";
import type { TruthTableStreamRow } from "./dto";
import type { TruthTableFormat } from "./pagination";
import { ApiError } from "./problems";
import { operation } from "./spec";

export const MEDIA_TYPES = {
  json: "application/json",
  problem: "application/problem+json",
  mergePatch: "application/merge-patch+json",
  netlist: "text/vnd.circuitlab.netlist",
  ndjson: "application/x-ndjson",
  csv: "text/csv",
} as const;

/**
 * The body's media type, if the operation accepts it.
 * @throws ApiError `unsupported-media-type` (415)
 */
export function requestMediaType(operationId: string, contentType: string | undefined): string {
  const offered = operation(operationId).requestMediaTypes;
  const sent = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (offered.includes(sent)) return sent;
  throw new ApiError("unsupported-media-type", `Send the body as ${offered.join(" or ")}${sent === "" ? "" : `, not ${sent}`}.`);
}

/**
 * The best response format for an Accept header, among those the operation offers.
 * @throws ApiError `not-acceptable` (406)
 */
export function responseMediaType(operationId: string, accept: string | undefined): string {
  const offered = operation(operationId).responseMediaTypes;
  const chosen = negotiate(accept, offered);
  if (chosen === undefined) throw new ApiError("not-acceptable", `This is available as ${offered.join(", ")}.`);
  return chosen;
}

export function truthTableFormat(mediaType: string): TruthTableFormat {
  return mediaType === MEDIA_TYPES.csv ? "csv" : mediaType === MEDIA_TYPES.ndjson ? "ndjson" : "json";
}

/**
 * Picks from `offered` (listed in the server's order of preference) the type the client rates
 * highest. Each offered type takes the quality of the most specific Accept range matching it:
 * `text/csv` beats `text/*`, which beats `*\/*`. No Accept header means "anything".
 */
export function negotiate(accept: string | undefined, offered: readonly string[]): string | undefined {
  if (accept === undefined || accept.trim() === "") return offered[0];
  const ranges = accept.split(",").map((part) => {
    const [range = "", ...params] = part.split(";").map((piece) => piece.trim().toLowerCase());
    const q = params.find((param) => param.startsWith("q="));
    return { range, quality: q === undefined ? 1 : Number(q.slice(2)) || 0 };
  });
  let best: { type: string; quality: number } | undefined;
  for (const type of offered) {
    const [family] = type.split("/");
    let match: { specificity: number; quality: number } | undefined;
    for (const { range, quality } of ranges) {
      const specificity = range === type ? 3 : range === `${family}/*` ? 2 : range === "*/*" ? 1 : 0;
      if (specificity > (match?.specificity ?? 0)) match = { specificity, quality };
    }
    if (match !== undefined && match.quality > 0 && match.quality > (best?.quality ?? 0)) best = { type, quality: match.quality };
  }
  return best?.type;
}

/**
 * Encodes truth-table pages as NDJSON or CSV, one text chunk per page, ready to stream:
 *
 *   await pipeline(Readable.from(encodeTruthTable(pool.truthTablePages(c, range), "csv")), response);
 *
 * CSV: a header `#,<inputs>,<outputs>`, then `<row>,<bits...>` lines (RFC 4180, CRLF endings).
 * Gate ids never contain commas or quotes, so no field needs quoting.
 * NDJSON: one self-describing object per line, values keyed by gate id.
 */
export async function* encodeTruthTable(
  pages: AsyncIterable<TruthTable> | Iterable<TruthTable>,
  format: "ndjson" | "csv",
): AsyncGenerator<string, void, undefined> {
  let first = true;
  for await (const page of pages) {
    const lines: string[] = [];
    if (format === "csv" && first) lines.push(`${["#", ...page.inputIds, ...page.outputIds].join(",")}\r\n`);
    first = false;
    for (const row of page.rows) lines.push(format === "csv" ? csvLine(row) : ndjsonLine(page, row));
    yield lines.join("");
  }
}

function csvLine(row: TruthTableRow): string {
  return `${[row.index, ...row.inputs, ...row.outputs].join(",")}\r\n`;
}

function ndjsonLine(page: TruthTable, row: TruthTableRow): string {
  const line: TruthTableStreamRow = { index: row.index, inputs: keyed(page.inputIds, row.inputs), outputs: keyed(page.outputIds, row.outputs) };
  return `${JSON.stringify(line)}\n`;
}

/** Pairs gate ids with their bits, e.g. ["A", "B"] and [1, 0] -> { A: 1, B: 0 }. */
function keyed(ids: readonly string[], bits: readonly Bit[]): Record<string, Bit> {
  const entries: [string, Bit][] = [];
  bits.forEach((bit, k) => {
    const id = ids[k];
    if (id !== undefined) entries.push([id, bit]);
  });
  return Object.fromEntries(entries);
}
