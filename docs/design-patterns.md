# CircuitLab design patterns (phase 9)

Phase 9 added three things the roadmap asked for: a gate factory, a strategy pattern for
simulation modes, and dependency injection throughout. Each was added because it solves a problem
in this code base, and each section below starts with that problem. The end of this document
lists the patterns earlier phases already used, and the ones deliberately left out.

`npm run demo:patterns` shows all three at work.

## 1. The gate registry and the gate factory

**The problem.** What a gate type is lived in three tables in the engine:
- the list of types;
- how many inputs each takes;
- what each computes.

Then the compiler had a `switch` over gate types to build its evaluation plan. A second simulation
mode would have needed a second `switch`, and a new gate type would have meant finding every one.

**The solution:**
- **One registry.** [`gates.ts`](../packages/engine/src/gates.ts) holds a `GATE_DEFINITIONS`
  record, one entry per type: arity, behaviour (an external input, a constant, or logic with its
  evaluator), and a description.
  - **No second copies:** `GATE_ARITY`, which validation and the netlist reader use, is derived from
    the registry.
  - **Completeness is checked by the compiler.** The record's type is
    `Record<GateType, GateDefinition>`, so a type without a definition doesn't compile.
- **One factory.** [`gate-factory.ts`](../packages/engine/src/gate-factory.ts) holds
  `createGateNode(gate, ...)`, which turns a gate described as data (JSON, a database row, a
  netlist line) into a node a simulation can run. It reads the registry to decide how.
  - **The only `switch` on how gates behave lives here.** No strategy has one.

**Why a registry and a factory, rather than a class per gate.** The textbook design has
`class AndGate extends Gate { evaluate() { ... } }` and a factory choosing the subclass. But
CircuitLab's gates spend their lives as data: in JSON bodies, in database rows, in netlist files,
and copied between worker threads, where class instances don't survive. So gates stay plain data,
behaviour is looked up by type in the registry (the table-driven form of the pattern), and the
factory makes runnable nodes only when a simulation needs them. Same intent: callers never
construct gate behaviour themselves, and it is defined in one place.

**Adding a gate type** is one registry entry. Its name must also appear in `openapi.yaml` and the
database's `gate_type` enum (a migration). Neither can be forgotten: a spec test and `db:check`
both compare their lists with the registry.

## 2. Simulation strategies

**The problem.** Simulation evaluated each gate once, in dependency order. That is right for
combinational logic, and impossible for a circuit with a feedback loop: a latch, a flip-flop, a
counter. Those circuits could be stored but not run. Phase 3 promised that phase 9 would run them.

**The solution: a second strategy behind the same interface**
([`strategies.ts`](../packages/engine/src/strategies.ts)):

```ts
const prepared = simulationStrategy(mode).prepare(circuit); // validate and prepare, once
const result = prepared.run(inputs, state);                 // as often as needed
```

| Strategy | How it evaluates | For |
| --- | --- | --- |
| `combinational` | Every gate once, in dependency order (Kahn's algorithm, phase 1); refuses loops | Circuits without memory |
| `sequential` | Gates outside loops once, in dependency order; each loop repeatedly until it settles, starting from the state the caller passes in | Latches, flip-flops, counters, and anything else |

**Every caller is the same code for both modes:** the worker threads, the API, and the demo
choose a strategy by name and use it without knowing how it works. A third mode would be a new
strategy, not changes to them.

**How sequential simulation works** ([`sequential.ts`](../packages/engine/src/sequential.ts)):
1. **Find the loops.** Tarjan's algorithm
   ([`components.ts`](../packages/engine/src/components.ts)) splits the circuit into strongly
   connected components: groups of gates that can all reach each other. A component of more than
   one gate, or a gate wired to itself, is a feedback loop. The components come out in dependency
   order. The algorithm is iterative rather than recursive, so a 100,000-gate chain doesn't
   overflow the stack.
2. **Evaluate in that order.**
   - **Gates outside loops:** once each, exactly as in combinational mode. So for a circuit without
     loops the two modes give the same answer; a test checks 200 random circuits.
   - **Each loop:** starts from its state (what its gates held at the end of the previous step; 0
     at first). Its gates are evaluated one at a time, in declaration order, and a gate is queued
     again when one of its inputs changes, until nothing changes: the loop has settled.
3. **Report the new state.** The state is the values of the gates on loops: the circuit's memory.
   Everything else follows from the inputs and the state.

**The state lives with the client, not the server.** Each request is one step. The answer carries
`state`, and the client sends it back with the next step. The server keeps no sessions of
simulations, and any instance can answer any step, which matters once there are several (phase 12).

**What can go wrong, and the answers:**
- **A loop that never settles.** An odd ring of inverters oscillates, in reality as here. Each loop
  gets a budget of evaluations (100 per gate; the strategy takes it as a setting), and running out
  throws `OscillationError`. The API answers it as 422 `does-not-settle`, naming the gates.
- **Races.** Released from S = R = 1, a real SR latch races to an unpredictable state. Here the
  fixed evaluation order makes the outcome reproducible but arbitrary. The documentation says so.
- **Power-up.** Starting from all zeros is an invalid state for a NAND latch (both outputs 0), so
  it resolves to one side by evaluation order. Real flip-flops also power up undefined, which is
  why real circuits have a reset; the tests clock a known value in first.

**Recorded runs say which strategy computed them.** A sequential run's outputs depend on more than
its inputs, so `simulation_runs.mode` was added (migration `20261001230000_simulation_mode`). A
CHECK keeps truth tables combinational: they list every input combination of a circuit without
memory.

## 3. Dependency injection throughout

NestJS has injected the services and repositories since phase 4: they receive their
collaborators, never construct them. Phase 9 removed the two places where that wasn't true.

**Time.** Session expiry, the sign-in throttle, access-token expiry, run timing, and storage
timestamps all asked `Date` for the time themselves. So none of the time rules could be tested
without waiting 30 days.
- **Now:** they receive a [`Clock`](../apps/api/src/common/clock.ts) instead.
- **Only one place reads the real time:** `SystemClock`. That holds across the app, and a search
  for `new Date()` in `apps/api/src` finds nothing else.
- **Tests and demos pass their own clock** to `createApp({ clock })` and move it forward:
  - access tokens expire after 15 minutes;
  - sessions end after 30 days without a refresh, and live on when refreshed in time;
  - blocked sign-ins unblock after 15 minutes.

  Those tests run on both storages, PostgreSQL included, since the repositories take their times
  from the clock too.

**The worker pool.** `SimulationPoolService` used to construct its own `SimulationPool`. Now
`SimulationModule` declares a factory provider (`createSimulationPool`, given the `AppConfig`),
and Nest injects the pool.
- **The service uses a pool and manages its shutdown,** but doesn't decide how one is built.
- **A test or a later phase can supply a different pool** without touching the service.

**Dependency injection without a framework.** The engine is plain functions, and there injection
means passing dependencies in. `sequentialStrategy({ maxEvaluationsPerGate })` takes its settings
as an argument, so tests use a tiny budget to provoke oscillation, and the default strategy uses
100.

## Patterns earlier phases already used

| Pattern | Where | Why |
| --- | --- | --- |
| Repository | `CircuitsRepository`, `UsersRepository`, ... (phases 4, 6, 7) | Services depend on what storage can do, not on PostgreSQL; the in-memory and Prisma implementations are interchangeable |
| Adapter | Prisma's driver adapter (`@prisma/adapter-pg`); `PasswordsService` around `argon2`; `jsonBody` around Express's body parser | Fit a library to the shape the rest of the code expects |
| Object pool | `SimulationPool` (phase 2) | Worker threads are expensive to start, so a fixed set is reused and tasks wait their turn |
| Message passing (command objects) | The `TaskRequest`/`TaskResponse` messages between the pool and its workers | Work crosses a thread boundary as plain data |
| Pipes and filters | Netlist import: bytes, gunzip, line splitter, parser (phase 2); truth-table downloads | Streams with backpressure: memory stays flat however big the file |
| Chain of responsibility | NestJS's request pipeline: middleware, guard (authentication), pipes (validation), handler, exception filter | Each concern in one place, applied to every request |
| Single source of truth | `openapi.yaml` (phase 3), `LIMITS`, the gate registry | One definition, enforced and documented from the same place; tests compare any copy with it |
| Policy as data | `circuit-access.ts`: the table of who may do what (phase 7) | The rules can be read, reviewed, and tested as the table they are |

## Patterns phase 10 added

Explained in [caching-and-jobs.md](caching-and-jobs.md):

| Pattern | Where | Why |
| --- | --- | --- |
| Cache-aside, with versioned keys | `SimulationService` and `ResultCache` | The service fills the cache. The circuit version in every key means nothing ever has to be invalidated |
| Asynchronous request-reply | `POST .../truth-table/jobs`: 202, a URL to poll, a result URL | Long work without holding a request open |
| Producer and consumer | `BullMqJobQueue` (API instances) and `BullMqJobWorkers` (any process) | Each side scales on its own |
| Compare-and-swap state machine | `JobsRepository`: every status change says which statuses it expects | Racing changes (cancel against finish) have exactly one winner |
| The same injection, for Redis | `RedisModule` and `JobsModule` bind the cache, throttle, results, and queue to Redis or memory | As `StorageModule` does for PostgreSQL: no service knows which it got |

## Patterns left out on purpose

- **A class per gate type.** Gates are data that cross JSON, the database, and threads; see
  section 1.
- **Singletons as global state.** A Nest provider is created once per app and handed to whoever
  needs it, so tests can build a fresh app (or several, with different storage) in one process.
  A global would make that impossible.
- **Service locator** (asking a container for dependencies at run time). Constructor injection
  shows each class's dependencies in its signature, and Nest checks them when the app starts.
