import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LibraryCircuit, LibraryItem, LibrarySaveRequest } from "./bridge";
import { NotInLibraryError } from "./helpers";
import { isLibraryId, itemOf, makeEntry, newestFirst, readEntry, type LibraryEntry } from "./library-entries";
import { readNetlist } from "./offline";

/**
 * The library: offline circuits saved inside the app, so nobody has to pick a file to keep their
 * work. One JSON file per circuit in <app data>/library/, holding the netlist plus what a netlist
 * can't (a description, dates). The rules live in library-entries.ts; this class only reads and
 * writes the files.
 */
export class Library {
  private readonly folder: string;

  constructor(folder: string) {
    this.folder = folder;
  }

  /** Every saved circuit, the most recently changed first. */
  async list(): Promise<LibraryItem[]> {
    let names: string[];
    try {
      names = await readdir(this.folder);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return []; // nothing saved yet
      throw error;
    }
    const items: LibraryItem[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      // A damaged file is skipped rather than hiding every other circuit.
      const entry = await this.read(path.join(this.folder, name)).catch(() => null);
      if (entry !== null) items.push(itemOf(entry));
    }
    return items.sort(newestFirst);
  }

  /** @throws NotInLibraryError */
  async open(id: string): Promise<LibraryCircuit> {
    const entry = await this.entry(id);
    return { item: itemOf(entry), text: entry.netlist, circuit: readNetlist(entry.netlist, entry.name) };
  }

  /** @throws NetlistError if the netlist has mistakes (nothing is saved then), NotInLibraryError */
  async save(request: LibrarySaveRequest): Promise<LibraryCircuit> {
    const netlist = String(request.netlist);
    // Read it first: a circuit that doesn't read back is never saved.
    const circuit = readNetlist(netlist, "Untitled circuit");
    const previous = request.id === undefined ? null : await this.entry(request.id);
    const entry = makeEntry({
      id: previous?.id ?? randomUUID(),
      previous,
      circuit,
      netlist,
      description: typeof request.description === "string" ? request.description : undefined,
      now: new Date().toISOString(),
    });
    await mkdir(this.folder, { recursive: true });
    // Write a temporary file, then rename it over the real one: if the app stops halfway, the old
    // version is still whole, never half written.
    const file = this.fileOf(entry.id);
    await writeFile(`${file}.tmp`, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    await rename(`${file}.tmp`, file);
    return { item: itemOf(entry), text: netlist, circuit };
  }

  async delete(id: string): Promise<void> {
    await rm(this.fileOf(id), { force: true }); // already gone is fine: the outcome is the same
  }

  private async entry(id: string): Promise<LibraryEntry> {
    let entry: LibraryEntry | null;
    try {
      entry = await this.read(this.fileOf(id));
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") throw new NotInLibraryError();
      throw error;
    }
    if (entry === null) throw new NotInLibraryError();
    return entry;
  }

  private async read(file: string): Promise<LibraryEntry | null> {
    return readEntry(JSON.parse(await readFile(file, "utf8")));
  }

  /** @throws NotInLibraryError for anything that isn't a library id (such as "../x") */
  private fileOf(id: string): string {
    if (!isLibraryId(id)) throw new NotInLibraryError();
    return path.join(this.folder, `${id}.json`);
  }
}
