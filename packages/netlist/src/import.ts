import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Circuit } from "@circuitlab/engine";
import { LineSplitter, type Line } from "./line-splitter";
import { DEFAULT_MAX_LINE_LENGTH, NetlistParser, type NetlistOptions } from "./parser";

export interface ImportOptions extends NetlistOptions {
  /** The bytes are gzip-compressed. `importNetlistFile` turns this on for names ending in ".gz". */
  readonly gzip?: boolean;
  /** Cancels the import. The promise then rejects with an AbortError. */
  readonly signal?: AbortSignal;
}

/**
 * Reads a netlist from any byte stream (file, HTTP upload, stdin, ...) one chunk at a time,
 * so the text is never held in memory all at once.
 *
 *   bytes -> [gunzip] -> LineSplitter -> parser
 *
 * `pipeline` connects the stages, passes backpressure along, and, on any failure, destroys every
 * stage so no file handle is left open. Failures reject the promise:
 *   - NetlistError for problems in the text, with line and column;
 *   - the stream's own errors unchanged (e.g. ENOENT, or Z_DATA_ERROR for a corrupt .gz file);
 *   - an AbortError if `signal` fires.
 */
export async function importNetlist(
  input: NodeJS.ReadableStream | AsyncIterable<string | Uint8Array>,
  options: ImportOptions = {},
): Promise<Circuit> {
  const parser = new NetlistParser(options);
  const splitter = new LineSplitter(options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH, options.source);
  // A Writable, not an `async (lines) => { for await ... }` stage: when the parser gives up
  // mid-file, its error must be the first one pipeline sees. Throwing inside `for await` would
  // first tear the stream down, and pipeline would report that AbortError instead.
  const toParser = new Writable({
    objectMode: true,
    write(line: Line, _encoding, callback) {
      try {
        parser.feedLine(line.text, line.number);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  const pipelineOptions = options.signal === undefined ? {} : { signal: options.signal };

  if (options.gzip === true) {
    await pipeline(input, createGunzip(), splitter, toParser, pipelineOptions);
  } else {
    await pipeline(input, splitter, toParser, pipelineOptions);
  }
  return parser.finish();
}

/** Streams a netlist file from disk. Files ending in ".gz" are decompressed on the fly. */
export function importNetlistFile(path: string, options: ImportOptions = {}): Promise<Circuit> {
  return importNetlist(createReadStream(path), { source: basename(path), gzip: path.endsWith(".gz"), ...options });
}
