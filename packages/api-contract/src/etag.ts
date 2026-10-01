// Conditional requests (RFC 9110). An ETag names one version of one representation:
//   - If-None-Match on reads: "I already have this"  -> 304, no body (saves bandwidth; caching).
//   - If-Match on writes:     "only if still this"   -> 412 if not (prevents lost updates when
//     two people edit the same circuit).

/** Strong ETag for a circuit. Each representation gets its own tag, as HTTP requires. */
export function circuitETag(version: number, representation: "json" | "netlist" = "json"): string {
  return representation === "json" ? `"${version}"` : `"${version}-netlist"`;
}

/** Strong ETag for a truth-table response: the rows depend only on the version and the range. */
export function truthTableETag(version: number, offset: number, limit: number, format: string): string {
  return `"${version}-rows-${offset}-${limit}-${format}"`;
}

/**
 * Evaluates `If-Match` before a change. True (go ahead) when the header is absent or `*`, or when
 * it names any representation of the current version.
 */
export function ifMatchPasses(header: string | undefined, version: number): boolean {
  if (header === undefined || header.trim() === "*") return true;
  return entityTags(header).some(({ weak, value }) => !weak && (value === String(version) || value.startsWith(`${version}-`)));
}

/** Evaluates `If-None-Match` on a read. True means the client's copy is current: answer 304. */
export function isNotModified(header: string | undefined, currentETag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === "*") return true;
  const current = currentETag.replace(/^W\//, "");
  return entityTags(header).some(({ value }) => `"${value}"` === current); // weak comparison: W/ is ignored
}

function entityTags(header: string): { weak: boolean; value: string }[] {
  return [...header.matchAll(/(W\/)?"([^"]*)"/g)].map((match) => ({ weak: match[1] !== undefined, value: match[2] ?? "" }));
}
