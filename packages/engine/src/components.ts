/**
 * The strongly connected components of a directed graph (Tarjan's algorithm): groups of nodes that
 * can all reach each other. In a circuit, a component of more than one gate, or a gate wired to
 * itself, is a feedback loop; every other gate is a component on its own.
 *
 * Components come back in dependency order: each one after every component that drives it. The
 * traversal follows node and successor order, so the result is deterministic. Iterative rather
 * than recursive, so a chain of 100,000 gates doesn't overflow the stack. O(V + E).
 *
 * @param successors for each node, the nodes it has edges to
 * @returns components as lists of nodes, each list in ascending order
 */
export function stronglyConnectedComponents(successors: readonly (readonly number[])[]): number[][] {
  const count = successors.length;
  const index = new Int32Array(count).fill(-1); // order of discovery
  const low = new Int32Array(count); // lowest index reachable from the node's subtree
  const onStack = new Uint8Array(count);
  const stack: number[] = [];
  const components: number[][] = [];
  let discovered = 0;

  const visit = (node: number): void => {
    index[node] = low[node] = discovered++;
    stack.push(node);
    onStack[node] = 1;
  };

  for (let root = 0; root < count; root++) {
    if (index[root] !== -1) continue;
    visit(root);
    // The call stack of the recursive version, made explicit: [node, next successor to look at].
    const frames: [number, number][] = [[root, 0]];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as [number, number];
      const [node, next] = frame;
      const targets = successors[node] ?? [];
      if (next < targets.length) {
        frame[1] = next + 1;
        const target = targets[next] as number;
        if (index[target] === -1) {
          visit(target);
          frames.push([target, 0]);
        } else if (onStack[target] === 1) {
          low[node] = Math.min(low[node] as number, index[target] as number);
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) low[parent[0]] = Math.min(low[parent[0]] as number, low[node] as number);
      if (low[node] === index[node]) {
        // `node` is the root of a component: everything above it on the stack belongs to it.
        const component: number[] = [];
        let member: number;
        do {
          member = stack.pop() as number;
          onStack[member] = 0;
          component.push(member);
        } while (member !== node);
        components.push(component.sort((a, b) => a - b));
      }
    }
  }
  // Tarjan's algorithm finishes a component only after every component it drives, so its output is
  // in reverse dependency order.
  return components.reverse();
}
