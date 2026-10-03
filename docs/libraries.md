# Using the packages as libraries

The engine, the netlist reader and the worker-thread runner are packages of their own
(`@circuitlab/engine`, `@circuitlab/netlist`, `@circuitlab/runner`). The API and the desktop app are
built on them, and so can anything else be. This is their reference; [architecture.md](architecture.md)
shows how everything fits together, and [design-patterns.md](design-patterns.md) explains the patterns
inside them.

## Engine API

```ts
import { SequentialCircuit, compileCircuit, simulate, truthTable, validateCircuit } from "@circuitlab/engine";

validateCircuit(json);                         // ValidationIssue[] (every problem, not just the first)
const compiled = compileCircuit(json);         // validate + sort once; throws CircuitValidationError / CycleError
simulate(compiled, { A: 1, B: 0 });            // { outputs, signals, order }; throws SimulationInputError
truthTable(compiled, { offset: 0, limit: 100 });  // one page of rows; truthTableRows() is the lazy version

const latch = new SequentialCircuit(json);    // what simulationStrategy("sequential").prepare(json) makes
const step1 = latch.run({ S: 1, R: 0 });                      // { mode, outputs, signals, state, evaluations }
const step2 = latch.run({ S: 0, R: 0 }, step1.state);         // the state carries memory between steps
```

| Module | Contents |
| --- | --- |
| `types.ts` | `Bit`, `Gate` (discriminated union on `type`), `Wire`, `Circuit`, `GATE_TYPES` |
| `gates.ts` | The gate registry: `GATE_DEFINITIONS` (inputs, behaviour, description per type), and `GATE_ARITY` derived from it |
| `gate-factory.ts` | `createGateNode`: a gate as data becomes a runnable node |
| `validate.ts` | `validateCircuit`, `assertValidCircuit`: checks untrusted input |
| `topological-sort.ts` | `topologicalSort`: Kahn's algorithm, with the loop path on failure |
| `compile.ts` | `compileCircuit` / `CompiledCircuit`: a reusable evaluation plan |
| `simulate.ts` | `simulate` (combinational) |
| `strategies.ts` | `simulationStrategy(mode)`: the combinational and sequential strategies |
| `sequential.ts`, `components.ts` | Sequential simulation, and Tarjan's strongly connected components |
| `truth-table.ts` | `truthTable`, `truthTableRows`, `inputsForRow` (row number to input values, up to 53 inputs) |
| `errors.ts` | `CircuitLabError`, the base of `CircuitValidationError`, `CycleError`, `SimulationInputError`, `OscillationError`; `toJSON()` and `reviveError()` |

Circuit format: gates have an `id`, a `type` and an optional `label`. A wire connects the output
of gate `from` to input pin `toPin` of gate `to`. Pins are numbered from 0 and must be used without
gaps. Simulation inputs and outputs are keyed by the ids of the INPUT and OUTPUT gates.

| Gate type | Input pins |
| --- | --- |
| INPUT, CONST | 0 |
| OUTPUT, BUF, NOT | 1 |
| AND, OR, NAND, NOR, XOR, XNOR | 2 to 64 (a multi-input XOR computes odd parity) |

## Netlist files

One gate per line, with inputs listed in pin order. See [examples/netlists](../examples/netlists).

```
# Half adder                  <- "#" starts a comment
.name "Half adder"            <- optional circuit name

A = INPUT
B = INPUT
sum   = XOR(A, B)             <- a name can be used before the line that defines it
carry = AND(A, B)
S = OUTPUT(sum)  "Sum"        <- optional label: a JSON-style quoted string
one = CONST(1)
```

- **Names:** letters, digits, `_ . $ [ ]`, not starting with `.`.
- **Gate types:** case-insensitive. `BUFF` is also accepted (the ISCAS benchmark spelling).
- **Text handling:** UTF-8, and a byte order mark or Windows line endings are fine.

```ts
import { importNetlist, importNetlistFile, parseNetlist, formatNetlist } from "@circuitlab/netlist";

await importNetlistFile("adder.net.gz");          // streams from disk; ".gz" is decompressed on the fly
await importNetlist(request, { source: "upload" }); // any byte stream, e.g. an HTTP upload
parseNetlist(text);                               // text already in memory
Readable.from(formatNetlist(circuit));            // writes a circuit back out, lazily
```

**Errors:**
- **`NetlistError`** covers problems in the text. It lists every problem as `file:line:column [CODE] message`.
- **Stream errors pass through unchanged**, for example `ENOENT` or a corrupt gzip file.
- **Size limits:** `maxLineLength`, `maxGates` and `maxIssues` stop an oversized or garbage upload early.

## Simulating on worker threads

```ts
import { SimulationPool } from "@circuitlab/runner";

const pool = new SimulationPool();              // one worker per CPU, minus one
await pool.simulate(circuitJson, { A: 1, B: 0 }, { signal: AbortSignal.timeout(5000) });
for await (const page of pool.truthTablePages(circuitJson)) send(page.rows);
await pool.close();                             // waits for running tasks; destroy() doesn't
```

| When... | The promise rejects with |
| --- | --- |
| the circuit or inputs are invalid | the engine's own error (`CycleError`, ...), rebuilt with its data |
| the `signal` fires (timeout or cancel) | `signal.reason`; a running task's worker is stopped and replaced |
| a task needs more than `maxWorkerMemoryMb` | `WorkerCrashedError`; only that worker dies, and it is replaced |
| every worker is busy and `maxQueue` tasks are waiting | `PoolBusyError`, immediately |
| the pool is closed | `PoolClosedError` |

**Main-thread cost:** results have to be turned back into objects on the main thread, which blocks it.
- **Truth tables travel packed:** the rows are sent as a byte buffer that is handed over, not copied.
- **Page big tables:** use `truthTablePages`, which fetches 1024-row pages in parallel and lets the event loop run between them.

