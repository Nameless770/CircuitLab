// Two kinds of pagination, each suited to its data:
//
// - The circuit list changes while someone pages through it (people add and delete circuits).
//   Page N by offset would then skip or repeat items, so pages are cut by *cursor*: "the items
//   after this one, in this order". In SQL that is an index lookup instead of counting past
//   `offset` rows every time.
// - A truth table never changes for a given circuit version, and a row number is a permanent
//   address in it, so rows are paged by offset and limit, and any page can be reached directly.

import { MAX_TRUTH_TABLE_INPUTS, type TruthTable } from "@circuitlab/engine";
import type { CircuitPage, CircuitSummary, ListScope, TruthTablePage } from "./dto";
import { LIMITS } from "./limits";
import { ApiError } from "./problems";
import { circuitListItem, type CircuitHeader } from "./resources";

// ---------------------------------------------------------------------------------------------
// Circuit list: cursors
// ---------------------------------------------------------------------------------------------

export const CIRCUIT_SORTS = ["-createdAt", "-updatedAt", "name"] as const;
export type CircuitSort = (typeof CIRCUIT_SORTS)[number];

/** Where a page ended: the last item's sort value and id (the id breaks ties). */
export interface CircuitCursor {
  readonly sort: CircuitSort;
  readonly value: string;
  readonly id: string;
}

const CURSOR_FORMAT = 1;

/** Date.prototype.toISOString's format, which time-sorted cursors hold. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Opaque to clients: base64url of a small JSON array. Clients must not build or edit cursors. */
export function encodeCursor(cursor: CircuitCursor): string {
  return Buffer.from(JSON.stringify([CURSOR_FORMAT, cursor.sort, cursor.value, cursor.id])).toString("base64url");
}

/**
 * Reads a cursor from a query string. It is untrusted input, so its shape is checked. It doesn't
 * need to be tamper-proof: a forged cursor can only select a different page of circuits the
 * caller may see anyway.
 *
 * @throws ApiError `invalid-request` (400) for anything but a cursor from this API and this sort
 */
export function decodeCursor(token: string, sort: CircuitSort): CircuitCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    parsed = undefined;
  }
  const valid =
    Array.isArray(parsed) &&
    parsed.length === 4 &&
    parsed[0] === CURSOR_FORMAT &&
    (CIRCUIT_SORTS as readonly unknown[]).includes(parsed[1]) &&
    typeof parsed[2] === "string" &&
    typeof parsed[3] === "string";
  if (!valid) throw cursorError("is not a cursor from this API; copy page.nextCursor from the previous page");
  const [, cursorSort, value, id] = parsed as [number, CircuitSort, string, string];
  if (cursorSort !== sort) throw cursorError(`was made for sort=${cursorSort}; keep the same sort for every page`);
  // A time sort's value is exactly what sortValue wrote: an ISO 8601 timestamp in UTC.
  if (sort !== "name" && !TIMESTAMP.test(value)) throw cursorError("is not a cursor from this API; copy page.nextCursor from the previous page");
  return { sort, value, id };
}

function cursorError(message: string): ApiError {
  return new ApiError("invalid-request", "The cursor is not valid.", { issues: [{ code: "INVALID_CURSOR", message, parameter: "cursor" }] });
}

/** The sort value a cursor stores for a circuit. Timestamps are ISO 8601, which sorts correctly as text. */
function sortValue(record: CircuitHeader, sort: CircuitSort): string {
  switch (sort) {
    case "-createdAt":
      return record.createdAt.toISOString();
    case "-updatedAt":
      return record.updatedAt.toISOString();
    case "name":
      return record.name;
  }
}

/**
 * The list order, as a comparator: the reference for what storage must do. In SQL, for the
 * default sort:
 *
 *   ... WHERE (created_at, id) < ($cursorValue, $cursorId)   -- only with a cursor
 *   ORDER BY created_at DESC, id DESC LIMIT $limit + 1
 *
 * Names compare by character code (like COLLATE "C"), so the order is the same everywhere.
 */
export function compareCircuits(sort: CircuitSort): (a: CircuitHeader, b: CircuitHeader) => number {
  const descending = sort.startsWith("-");
  return (a, b) => {
    const order = compareText(sortValue(a, sort), sortValue(b, sort)) || compareText(a.id, b.id);
    return descending ? -order : order;
  };
}

/** True if `record` comes after the cursor in the list order: the reference for the WHERE clause. */
export function isAfterCursor(record: CircuitHeader, cursor: CircuitCursor): boolean {
  const order = compareText(sortValue(record, cursor.sort), cursor.value) || compareText(record.id, cursor.id);
  return cursor.sort.startsWith("-") ? order < 0 : order > 0;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Builds a list page. Storage should fetch `limit + 1` records after the cursor: if the extra one
 * exists there is a next page, which saves counting the whole table. The links always name the
 * scope, so a `next` link lists the same circuits whoever follows it.
 */
export function circuitPage(
  fetched: readonly CircuitHeader[],
  query: { readonly limit: number; readonly sort: CircuitSort; readonly scope: ListScope; readonly cursor?: CircuitCursor; readonly q?: string },
  basePath: string,
): CircuitPage {
  const records = fetched.slice(0, query.limit);
  const last = records.at(-1);
  const nextCursor =
    fetched.length > query.limit && last !== undefined ? encodeCursor({ sort: query.sort, value: sortValue(last, query.sort), id: last.id }) : null;
  const link = (cursor: string | undefined): string =>
    withQuery(basePath, { scope: query.scope, limit: query.limit, sort: query.sort, q: query.q, cursor });
  return {
    items: records.map(circuitListItem),
    page: { limit: query.limit, nextCursor },
    links: {
      self: link(query.cursor === undefined ? undefined : encodeCursor(query.cursor)),
      next: nextCursor === null ? null : link(nextCursor),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Truth tables: offset and limit
// ---------------------------------------------------------------------------------------------

export type TruthTableFormat = "json" | "ndjson" | "csv";

/**
 * Checks that a truth table can be served for this circuit.
 * @throws ApiError `feedback-loop` or `too-many-inputs` (422)
 */
export function checkTruthTableAllowed(summary: CircuitSummary): void {
  if (summary.feedbackLoop !== null) {
    throw new ApiError("feedback-loop", `The circuit has a feedback loop (${summary.feedbackLoop.join(" -> ")}), so it has no truth table.`, {
      cycle: summary.feedbackLoop,
    });
  }
  if (summary.inputs.length > MAX_TRUTH_TABLE_INPUTS) {
    throw new ApiError(
      "too-many-inputs",
      `A truth table can have at most ${MAX_TRUTH_TABLE_INPUTS} inputs, so that every row number is exact; this circuit has ${summary.inputs.length}.`,
    );
  }
}

/**
 * Pins a sequence of pages to one circuit version (the `version` parameter).
 * @throws ApiError `version-conflict` (409) if the circuit has changed since
 */
export function checkExpectedVersion(expected: number | undefined, current: number): void {
  if (expected !== undefined && expected !== current) {
    throw new ApiError(
      "version-conflict",
      `The circuit changed (it is now version ${current}, not ${expected}) since these pages were started. Start again from the first page.`,
    );
  }
}

/**
 * Settles which rows to send. JSON pages default to 256 rows and hold at most 4,096. Downloads
 * default to "everything from offset", which must then be at most 1,048,576 rows: a download is
 * never silently cut short.
 *
 * @throws ApiError `invalid-request` (400) when the range is too big for the format
 */
export function truthTableRange(
  query: { readonly offset: number; readonly limit?: number },
  totalRows: number,
  format: TruthTableFormat,
): { offset: number; limit: number } {
  const { offset } = query;
  const remaining = Math.max(0, totalRows - offset);
  if (format === "json") {
    const limit = query.limit ?? LIMITS.truthTableRowsPerPage.default;
    if (limit > LIMITS.truthTableRowsPerPage.max) {
      throw rangeError("limit", `a JSON page holds at most ${fmt(LIMITS.truthTableRowsPerPage.max)} rows; ask for NDJSON or CSV to download more`);
    }
    return { offset, limit };
  }
  const limit = query.limit ?? remaining;
  if (Math.min(limit, remaining) > LIMITS.maxStreamedRows) {
    const reason =
      query.limit === undefined
        ? `this table has ${fmt(remaining)} rows from offset ${fmt(offset)}, more than one download may hold (${fmt(LIMITS.maxStreamedRows)}); ask for a range with offset and limit`
        : `one download holds at most ${fmt(LIMITS.maxStreamedRows)} rows`;
    throw rangeError("limit", reason);
  }
  return { offset, limit };
}

function rangeError(parameter: string, message: string): ApiError {
  return new ApiError("invalid-request", "The requested rows don't fit in one response.", { issues: [{ code: "RANGE_TOO_LARGE", message, parameter }] });
}

/**
 * Wraps one window of rows as a JSON page with links. Every link carries `version`, so following
 * them fails with 409 rather than mixing rows from two versions of the circuit.
 */
export function truthTablePage(
  table: TruthTable,
  context: { readonly circuitId: string; readonly version: number; readonly limit: number; readonly basePath: string },
): TruthTablePage {
  const { circuitId, version, limit, basePath } = context;
  const { totalRows, offset } = table;
  const at = (rowOffset: number): string => withQuery(basePath, { offset: rowOffset, limit, version });
  const lastOffset = totalRows === 0 ? 0 : Math.floor((totalRows - 1) / limit) * limit;
  return {
    circuitId,
    circuitVersion: version,
    inputs: table.inputIds,
    outputs: table.outputIds,
    totalRows,
    offset,
    limit,
    rows: table.rows,
    links: {
      self: at(offset),
      first: at(0),
      prev: offset > 0 ? at(Math.max(0, offset - limit)) : null,
      next: offset + limit < totalRows ? at(offset + limit) : null,
      last: at(lastOffset),
    },
  };
}

// ---------------------------------------------------------------------------------------------

/** An RFC 8288 `Link` header, e.g. `</v1/circuits?cursor=abc>; rel="next"`. */
export function linkHeader(links: Readonly<Record<string, string | null>>): string {
  return Object.entries(links)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([rel, url]) => `<${url}>; rel="${rel}"`)
    .join(", ");
}

function withQuery(path: string, params: Readonly<Record<string, string | number | undefined>>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value !== undefined) search.set(name, String(value));
  const text = search.toString();
  return text === "" ? path : `${path}?${text}`;
}

const fmt = (n: number): string => n.toLocaleString("en");
