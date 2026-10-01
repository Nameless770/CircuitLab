/** True for JSON-style objects: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

const MAX_QUOTED_LENGTH = 40;

/**
 * Quotes an untrusted string for an error message: JSON escaping neutralises newlines and
 * control characters, and long strings are cut so a hostile payload can't bloat the message.
 */
export function quote(text: string): string {
  return JSON.stringify(text.length > MAX_QUOTED_LENGTH ? `${text.slice(0, MAX_QUOTED_LENGTH)}...` : text);
}

/** Short description of an untrusted value of any type, for "expected X, got Y" messages. */
export function showValue(value: unknown): string {
  if (typeof value === "string") return quote(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "function") return "a function";
  return String(value); // number, boolean, bigint, symbol, undefined
}

/**
 * Array access for indices that are in range by construction. With `noUncheckedIndexedAccess`
 * a plain `list[i]` is `T | undefined`; this turns an impossible miss into a loud bug report
 * instead of a silent `undefined`.
 */
export function at<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`Internal error: index ${index} is out of range (length ${list.length})`);
  }
  return item;
}
