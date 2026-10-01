import { at } from "./util";

/** Binary min-heap of numbers. `pop` always returns the smallest value pushed so far. */
export class MinHeap {
  private readonly items: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(value: number): void {
    const items = this.items;
    // Open a hole at the end and move it up past every parent larger than `value`.
    let hole = items.length;
    items.push(value);
    while (hole > 0) {
      const parent = (hole - 1) >> 1;
      const parentValue = at(items, parent);
      if (parentValue <= value) break;
      items[hole] = parentValue;
      hole = parent;
    }
    items[hole] = value;
  }

  pop(): number | undefined {
    const items = this.items;
    const smallest = items[0];
    const last = items.pop();
    if (last === undefined || items.length === 0) return smallest;

    // The root is now a hole: move it down past every child smaller than `last`.
    let hole = 0;
    for (;;) {
      const left = 2 * hole + 1;
      if (left >= items.length) break;
      const right = left + 1;
      const child = right < items.length && at(items, right) < at(items, left) ? right : left;
      const childValue = at(items, child);
      if (childValue >= last) break;
      items[hole] = childValue;
      hole = child;
    }
    items[hole] = last;
    return smallest;
  }
}
