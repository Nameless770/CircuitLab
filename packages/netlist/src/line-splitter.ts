import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { NetlistError } from "./errors";
import { lineTooLongIssue } from "./parser";

export interface Line {
  readonly text: string;
  /** 1-based line number. */
  readonly number: number;
}

/**
 * Turns a stream of bytes into a stream of `Line` objects.
 *
 * Chunks from a file or socket end at arbitrary points: in the middle of a line, or even in the
 * middle of a multi-byte UTF-8 character such as "é". The StringDecoder holds back incomplete
 * characters, and `partial` holds an unfinished line until its line break arrives. `partial` is
 * capped, so input without line breaks cannot fill memory.
 */
export class LineSplitter extends Transform {
  private readonly decoder = new StringDecoder("utf8");
  private partial = "";
  private lineNumber = 0;
  private sawText = false;

  constructor(
    private readonly maxLineLength: number,
    private readonly source?: string,
  ) {
    super({ readableObjectMode: true });
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.consume(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.consume(this.decoder.end());
      if (this.partial !== "") this.emitLine(this.partial); // last line had no line break
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  private consume(text: string): void {
    if (!this.sawText && text !== "") {
      this.sawText = true;
      if (text.startsWith("﻿")) text = text.slice(1); // byte order mark, e.g. from Windows Notepad
    }
    const data = this.partial + text;
    let start = 0;
    for (let newline = data.indexOf("\n"); newline !== -1; newline = data.indexOf("\n", start)) {
      this.emitLine(data.slice(start, newline));
      start = newline + 1;
    }
    this.partial = data.slice(start);
    if (this.partial.length > this.maxLineLength) {
      throw new NetlistError([lineTooLongIssue(this.lineNumber + 1, this.maxLineLength)], this.source);
    }
  }

  private emitLine(raw: string): void {
    this.lineNumber++;
    const line: Line = { text: raw.endsWith("\r") ? raw.slice(0, -1) : raw, number: this.lineNumber };
    this.push(line);
  }
}
