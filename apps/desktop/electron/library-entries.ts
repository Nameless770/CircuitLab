import type { LibraryItem, LibrarySummary, LocalCircuit } from "./bridge";

/**
 * The library's rules as pure functions (library.ts does the file reading and writing), so they
 * can be unit tested (test/library-entries.test.ts).
 */

/** Written into every saved circuit, so a later version of the app knows how to read old ones. */
export const LIBRARY_FORMAT = 1;

/** What one file in the library folder holds: the item, plus the netlist itself. */
export interface LibraryEntry extends LibraryItem {
  readonly format: typeof LIBRARY_FORMAT;
  readonly netlist: string;
}

/** The longest description kept, the same limit as the API's. */
export const MAX_DESCRIPTION = 2000;

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Library ids are UUIDs the app makes, and each is a file name. Checking them before touching the
 * disk also means a crafted id such as "../../secret" never reaches the file system.
 */
export function isLibraryId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function summaryOf(circuit: LocalCircuit): LibrarySummary {
  return { gates: circuit.gates.length, inputs: circuit.summary.inputs, outputs: circuit.summary.outputs, feedbackLoop: circuit.summary.feedbackLoop };
}

export interface NewEntry {
  readonly id: string;
  /** The entry being replaced, or null for a new circuit. */
  readonly previous: LibraryEntry | null;
  readonly circuit: LocalCircuit;
  readonly netlist: string;
  readonly description: string | undefined;
  /** The current time, ISO 8601 (passed in, so tests don't depend on the clock). */
  readonly now: string;
}

/** The entry to write: a new one, or `previous` updated (keeping its creation time). */
export function makeEntry({ id, previous, circuit, netlist, description, now }: NewEntry): LibraryEntry {
  const text = description?.trim().slice(0, MAX_DESCRIPTION) ?? "";
  return {
    format: LIBRARY_FORMAT,
    id,
    name: circuit.name,
    ...(text !== "" && { description: text }),
    summary: summaryOf(circuit),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    netlist,
  };
}

/**
 * Checks what a library file contains. Null when it isn't an entry this version of the app can
 * read: damaged, edited by hand, or written by a newer version. Such files are skipped, not fatal.
 */
export function readEntry(data: unknown): LibraryEntry | null {
  if (typeof data !== "object" || data === null) return null;
  const entry = data as Record<string, unknown>;
  const fieldsOk =
    entry["format"] === LIBRARY_FORMAT &&
    isLibraryId(entry["id"]) &&
    typeof entry["name"] === "string" &&
    typeof entry["netlist"] === "string" &&
    typeof entry["createdAt"] === "string" &&
    typeof entry["updatedAt"] === "string" &&
    (entry["description"] === undefined || typeof entry["description"] === "string");
  return fieldsOk && isSummary(entry["summary"]) ? (data as LibraryEntry) : null;
}

function isSummary(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Record<string, unknown>;
  return (
    typeof summary["gates"] === "number" &&
    isStringList(summary["inputs"]) &&
    isStringList(summary["outputs"]) &&
    (summary["feedbackLoop"] === null || isStringList(summary["feedbackLoop"]))
  );
}

function isStringList(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** The entry without its netlist: what the Library page needs. */
export function itemOf(entry: LibraryEntry): LibraryItem {
  return {
    id: entry.id,
    name: entry.name,
    ...(entry.description !== undefined && { description: entry.description }),
    summary: entry.summary,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/** For sorting: the most recently changed first. ISO 8601 times sort correctly as text. */
export function newestFirst(a: LibraryItem, b: LibraryItem): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}
