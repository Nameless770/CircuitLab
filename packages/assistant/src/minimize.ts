/**
 * Turns a truth table into the fewest AND-terms that, OR-ed together, give the same table (the
 * Quine-McCluskey method). It is what builds gates for a formula like `A + B + C >= 2`, which says
 * what a circuit does but not how to wire it.
 *
 * A term is a row of "must be 1", "must be 0" or "doesn't matter" for each input. The first input
 * is the leftmost, the most significant bit of the row number.
 */
export type Literal = 0 | 1 | "any";
export type Term = readonly Literal[];

/** A product term while it's being worked out: the bits that are fixed, and the bits that don't matter. */
interface Implicant {
  readonly value: number;
  readonly free: number;
}

/**
 * @param table  `table[row]` is the output (0 or 1) for that row; `table.length` is 2 to the power of `variables`
 * @returns the terms to OR together: [] when the output is always 0, and one all-"any" term when it is always 1
 */
export function minimize(table: readonly number[], variables: number): Term[] {
  const minterms: number[] = [];
  table.forEach((output, row) => {
    if (output === 1) minterms.push(row);
  });
  if (minterms.length === 0) return [];

  const chosen = cover(minterms, primeImplicants(minterms));
  return chosen.map((implicant) =>
    Array.from({ length: variables }, (_, index): Literal => {
      const bit = 1 << (variables - 1 - index);
      return (implicant.free & bit) !== 0 ? "any" : (implicant.value & bit) !== 0 ? 1 : 0;
    }),
  );
}

const keyOf = (implicant: Implicant): string => `${implicant.value}/${implicant.free}`;

function popcount(value: number): number {
  let count = 0;
  for (let rest = value; rest !== 0; rest &= rest - 1) count++;
  return count;
}

/** Joins terms that differ in exactly one input, again and again; what can't be joined any more is prime. */
function primeImplicants(minterms: readonly number[]): Implicant[] {
  const primes: Implicant[] = [];
  let level = new Map<string, Implicant>(minterms.map((minterm) => [keyOf({ value: minterm, free: 0 }), { value: minterm, free: 0 }]));
  while (level.size > 0) {
    const joined = new Set<string>();
    const next = new Map<string, Implicant>();
    const list = [...level.values()];
    for (let first = 0; first < list.length; first++) {
      for (let second = first + 1; second < list.length; second++) {
        const a = list[first] as Implicant;
        const b = list[second] as Implicant;
        const difference = a.value ^ b.value;
        if (a.free !== b.free || popcount(difference) !== 1) continue;
        const merged: Implicant = { value: a.value & b.value, free: a.free | difference };
        next.set(keyOf(merged), merged);
        joined.add(keyOf(a));
        joined.add(keyOf(b));
      }
    }
    for (const implicant of list) if (!joined.has(keyOf(implicant))) primes.push(implicant);
    level = next;
  }
  return primes;
}

const covers = (implicant: Implicant, minterm: number): boolean => ((minterm ^ implicant.value) & ~implicant.free) === 0;

/** Picks the terms that are the only way to reach some row first, then the one that reaches the most rows left, until all are reached. */
function cover(minterms: readonly number[], primes: readonly Implicant[]): Implicant[] {
  const chosen: Implicant[] = [];
  const uncovered = new Set(minterms);
  const take = (implicant: Implicant): void => {
    if (chosen.includes(implicant)) return;
    chosen.push(implicant);
    for (const minterm of [...uncovered]) if (covers(implicant, minterm)) uncovered.delete(minterm);
  };

  for (const minterm of minterms) {
    const reaching = primes.filter((prime) => covers(prime, minterm));
    if (reaching.length === 1) take(reaching[0] as Implicant);
  }
  while (uncovered.size > 0) {
    let best: Implicant | undefined;
    let bestGain = 0;
    for (const prime of primes) {
      const gain = [...uncovered].filter((minterm) => covers(prime, minterm)).length;
      // On a tie, the term with more "doesn't matter" inputs is smaller; after that the order of the list decides.
      if (gain > bestGain || (gain === bestGain && best !== undefined && popcount(prime.free) > popcount(best.free))) {
        best = prime;
        bestGain = gain;
      }
    }
    if (best === undefined) break; // can't happen: every row is covered by some prime term
    take(best);
  }
  // The same circuit every time: terms in the order of the first row each one reaches.
  const firstRow = (implicant: Implicant): number => minterms.find((minterm) => covers(implicant, minterm)) ?? 0;
  return chosen.sort((a, b) => firstRow(a) - firstRow(b));
}
