# CircuitLab

A digital logic circuit simulator, built in phases (see the roadmap below). Phases 1 to 8 are
done:
- **Phase 1:** a pure TypeScript engine.
- **Phase 2:** streaming netlist import, and simulation on worker threads.
- **Phase 3:** the REST API's contract.
- **Phase 4:** a NestJS server that serves that contract.
- **Phase 5:** the PostgreSQL schema.
- **Phase 6:** the API connected to PostgreSQL through Prisma, with migrations.
- **Phase 7:** accounts, JWT sign-in, private and public circuits, and sharing.
- **Phase 8:** tests: 579 of them, unit and integration, run with `npm test`.

Everything compiles to CommonJS.

```
packages/engine/        @circuitlab/engine        data model, validation, sorting, simulation, truth tables
                                                  (pure TypeScript: no Node or framework imports)
packages/netlist/       @circuitlab/netlist       reads and writes netlist files, streaming
packages/runner/        @circuitlab/runner        SimulationPool: runs simulations on worker threads
packages/api-contract/  @circuitlab/api-contract  openapi.yaml, plus the framework-free code that enforces it
packages/database/      @circuitlab/database      PostgreSQL 18 migrations, schema.prisma, the Prisma Client, a local dev server
apps/api/               @circuitlab/api           the NestJS app
docs/api-design.md      why the API looks the way it does
docs/database-design.md why the database looks the way it does
docs/auth-design.md     accounts, tokens, and who may do what
docs/testing.md         how it is tested, and what the tests found
examples/               demos, and sample netlists in examples/netlists/
*/test/                 each package's tests (Vitest)
```

**How the pieces depend on each other:**
- The engine depends on nothing.
- The netlist and runner packages depend only on the engine.
- The API contract depends on those three.
- The database package depends on nothing at runtime but Prisma (its check uses the engine and netlist).
- The app depends on all of them.

## Commands

```bash
npm install
npm run build          # tsc -b: builds every package, then the examples
npm test               # phase 8: builds, type-checks the tests, runs all of them (memory and PostgreSQL)
npm run test:coverage  # the same, with a coverage report in coverage/
npm run demo           # phase 1: truth tables and engine error messages
npm run demo:netlist   # phase 2: importing netlist files with streams
npm run demo:async     # phase 2: simulations on worker threads
npm run demo:api       # phase 3: the API's answers, request by request
npm run demo:http      # phase 4: the real server, driven over HTTP
npm run demo:auth      # phase 7: accounts, sharing, and tokens, over HTTP
npm run start:api      # phase 4: runs the API on http://localhost:3000/v1
npm run lint:api       # checks openapi.yaml (Redocly, fetched on first use)
npm run db:start       # phase 6: a local PostgreSQL 18 on port 5433, nothing to install (leave it running)
npm run db:migrate     # phase 6: applies the migrations (prisma migrate deploy)
npm run db:status      # which migrations a database has
npm run db:studio      # Prisma Studio, to browse the data
npm run db:check       # tests the migrations, constraints, queries and indexes on an embedded PostgreSQL 18
npm run clean
```

## Running the API

```bash
npm run start:api
```

That keeps circuits in memory. To keep them in PostgreSQL, copy `.env.example` to `.env` (it sets
`DATABASE_URL` for the local database), then, in separate terminals:

```bash
npm run db:start
```

```bash
npm run db:migrate
```

```bash
npm run start:api
```

Circuits belong to accounts, so register first. The answer holds an `accessToken`:

```bash
curl -X POST http://localhost:3000/v1/auth/register -H "Content-Type: application/json" -d '{"email": "ada@example.com", "password": "a long passphrase of mine", "displayName": "Ada"}'
```

```bash
curl -X POST http://localhost:3000/v1/circuits -H "Authorization: Bearer <accessToken>" -H "Content-Type: text/vnd.circuitlab.netlist" --data-binary @examples/netlists/full-adder.net
```

```bash
curl "http://localhost:3000/v1/circuits/<id>/truth-table" -H "Authorization: Bearer <accessToken>" -H "Accept: text/csv"
```

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 3000 | HTTP port |
| `SIMULATION_WORKERS` | CPUs − 1 | Worker threads in the shared simulation pool |
| `SIMULATION_QUEUE` | 100 | Simulations that may wait for a worker; beyond that the API answers 503 |
| `WORKER_MEMORY_MB` | 512 | Heap limit per worker thread |
| `SHUTDOWN_GRACE_MS` | 10000 | On shutdown, how long running simulations get before they are stopped |
| `DATABASE_URL` | none | PostgreSQL connection string. Without it, circuits are kept in memory and lost when the API stops |
| `DATABASE_POOL_SIZE` | 10 | Database connections. Must be 1 with the local dev database (`npm run db:start`) |
| `JWT_SECRET` | random | The key that signs access tokens, at least 32 characters. Without it a random key is made at startup, so a restart signs everyone out |

`start:api` reads `.env` if there is one; a variable set in the shell wins. With `DATABASE_URL`
set, the API refuses to start if the database is unreachable or not migrated, and says which.
`GET /health` shows whether the database is reachable (503 if not) and how busy the simulation
workers are.

### Inside the NestJS app

```
AppModule
├── ConfigModule       AppConfig from the environment, available everywhere (global)
├── StorageModule      the repositories: Prisma when DATABASE_URL is set, in-memory otherwise (global)
├── AuthModule         /v1/auth, /v1/users     AuthService; AuthenticationGuard checks every request's token
├── CircuitsModule     /v1/circuits            CircuitsService (who may do what) -> CircuitsRepository; sharing
├── SimulationModule   /v1/circuits/{id}/...   SimulationController -> SimulationService -> SimulationPoolService
└── HealthModule       /health
+ ProblemFilter        every error leaves as application/problem+json, via the contract's toProblem()
```

- **Controllers only translate HTTP.** Every rule comes from `@circuitlab/api-contract`, so the server
  serves `openapi.yaml` exactly: the integration tests check every response against it.
- **Handlers say who may call them.** `@CurrentUser()` needs a signed-in user (401 otherwise);
  `@OptionalUser()` also serves signed-out visitors, who may read public circuits. What a user may
  do with a circuit is decided in one place, `circuit-access.ts`.
- **The repositories are abstract classes used as injection tokens.**
  `StorageModule` binds them to Prisma or to in-memory implementations; the services never know
  which. With `If-Match`, a write applies only if the circuit is still at that version, so it can't
  lose a race.
- **`SimulationPoolService` owns the one shared worker pool.**
  - **Cancellation.** A request's work is cancelled when its client disconnects. Simulations and
    JSON pages have a 10-second limit (503 `simulation-timeout`). Downloads are produced only as
    fast as the client reads them.
  - **Shutdown.** On SIGTERM or SIGINT, Nest stops taking requests and drains those in flight.
    Then the pool closes, and any simulation still running after `SHUTDOWN_GRACE_MS` is stopped.

## REST API

The contract is [openapi.yaml](packages/api-contract/openapi.yaml), and the reasoning behind it is
in [docs/api-design.md](docs/api-design.md). In short:
- **Endpoints:** `/v1/circuits` (CRUD), `/v1/circuits/{id}/simulate`,
  `/v1/circuits/{id}/truth-table`, `/v1/circuits/{id}/runs` (recent simulations),
  `/v1/circuits/{id}/shares`, and `/v1/auth/...` with `/v1/users/me` for accounts.
- **Access:** circuits are private to their owner until shared (viewer or editor) or made public.
  A circuit you may not see answers 404, as if it didn't exist; 403 means you can see it but may
  not do that.
- **Representations:** JSON or netlist for circuits; JSON pages, NDJSON or CSV for truth tables.
- **Errors:** RFC 9457 problem documents that locate every issue.
- **Pagination:** cursors for the circuit list; offset and limit for truth-table rows.
- **Concurrency and overload:** ETags for caching and for preventing lost updates; 503 with
  `Retry-After` when the simulation workers are saturated or the database is unavailable.

`@circuitlab/api-contract` provides:
- **Request parsers** that validate against the spec itself (`parseCircuitInput`, `parseListCircuitsQuery`, ...).
- **`toProblem(error)`,** which maps any error to its HTTP response.
- **Pagination, ETag and content-negotiation helpers,** plus truth-table encoders.

The NestJS app (phase 4) plugs these into pipes, filters and controllers.

## Database

The PostgreSQL 18 schema is the SQL migrations in
[packages/database/prisma/migrations](packages/database/prisma/migrations), described for Prisma
Client by [schema.prisma](packages/database/prisma/schema.prisma). The statements behind the API
are in [queries.sql](packages/database/queries.sql), and the reasoning is in
[docs/database-design.md](docs/database-design.md). In short:
- **Tables:** users, circuits, gates, wires, simulation runs, circuit shares, and sign-in sessions.
- **Keys enforce the structure.** A wire's primary key makes "one wire per pin" impossible to
  break, and its foreign keys keep both ends inside the same circuit.
- **CHECK constraints** cover formats, ranges, and which fields each kind and status of run has.
- **Version numbers provide optimistic locking.**
- **Every query has an index.** That includes cursor pagination and trigram name search.

- **Migrations are SQL, written by hand,** because Prisma's schema language can't express CHECK
  constraints or partial indexes. `schema.prisma` mirrors them, and a drift check proves it.
- **Prisma 7 with the node-postgres driver adapter.** Queries use Prisma's API, except the cursor
  list query, which stays SQL (through `$queryRaw`) so PostgreSQL can serve it with one index scan.

`npm run db:check` runs all of this on a real PostgreSQL 18, embedded with PGlite, so nothing has
to be installed. `npm run db:start` serves the same PGlite on a normal PostgreSQL port for
development.

## Accounts and access

[docs/auth-design.md](docs/auth-design.md) explains it all. In short:
- **Passwords:** 15 to 256 characters (NIST's rule), hashed with Argon2id.
- **Sign-in throttling:** 5 failures for one account from one address mean 15 minutes of 429.
- **Access tokens:** JWTs valid for 15 minutes, checked without touching the database.
- **Refresh tokens:** work once each. A reused one ends its session, since someone else holds a
  copy.
- **Permissions** are looked up on every request, never stored in a token.

## Testing

`npm test` runs 579 tests in about 15 seconds. [docs/testing.md](docs/testing.md) has the details.
- **Engine:** known circuits (adders, a multiplexer, ISCAS c17) are checked against independent
  references, and every gate type against every input combination.
- **API:** tested over HTTP twice, in memory and on a fresh, migrated PostgreSQL.
  - **Contract:** every response is checked against `openapi.yaml`.
  - **Access rules:** run as the table they are.
- **Do the tests catch bugs?** 12 deliberately planted bugs were all caught.
- **Coverage:** 94% of statements.

## Engine API

```ts
import { compileCircuit, simulate, truthTable, validateCircuit } from "@circuitlab/engine";

validateCircuit(json);                         // ValidationIssue[] (every problem, not just the first)
const compiled = compileCircuit(json);         // validate + sort once; throws CircuitValidationError / CycleError
simulate(compiled, { A: 1, B: 0 });            // { outputs, signals, order }; throws SimulationInputError
truthTable(compiled, { offset: 0, limit: 100 });  // one page of rows; truthTableRows() is the lazy version
```

| Module | Contents |
| --- | --- |
| `types.ts` | `Bit`, `Gate` (discriminated union on `type`), `Wire`, `Circuit`, `GATE_TYPES` |
| `gates.ts` | Pin counts per gate type (`GATE_ARITY`) and the gate logic |
| `validate.ts` | `validateCircuit`, `assertValidCircuit`: checks untrusted input |
| `topological-sort.ts` | `topologicalSort`: Kahn's algorithm, with the loop path on failure |
| `compile.ts` | `compileCircuit` / `CompiledCircuit`: a reusable evaluation plan |
| `simulate.ts` | `simulate` |
| `truth-table.ts` | `truthTable`, `truthTableRows`, `inputsForRow` (row number to input values, up to 53 inputs) |
| `errors.ts` | `CircuitLabError`, the base of `CircuitValidationError`, `CycleError`, `SimulationInputError`; `toJSON()` and `reviveError()` |

Circuit format: gates have an `id`, a `type` and an optional `label`. A wire connects the output
of gate `from` to input pin `toPin` of gate `to`. Pins are numbered from 0 and must be used without
gaps. Simulation inputs and outputs are keyed by the ids of the INPUT and OUTPUT gates.

| Gate type | Input pins |
| --- | --- |
| INPUT, CONST | 0 |
| OUTPUT, BUF, NOT | 1 |
| AND, OR, NAND, NOR, XOR, XNOR | 2 to 64 (a multi-input XOR computes odd parity) |

## Netlist files

One gate per line, with inputs listed in pin order. See [examples/netlists](examples/netlists).

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

## Roadmap

| # | Phase | Scope | Status |
| --- | --- | --- | --- |
| 1 | TypeScript | Core engine: types, validation, topological sort, cycle detection, `simulate()` | Done |
| 2 | Node internals | Import netlist files using streams; async simulation with proper error handling | Done |
| 3 | REST design | `/circuits`, `/circuits/:id/simulate`, `/circuits/:id/truth-table`, validation, pagination | Done |
| 4 | NestJS | Wrap the engine in modules, controllers, and services | Done |
| 5 | PostgreSQL | Schema for users, circuits, gates, wires, and simulation runs | Done |
| 6 | Prisma | Database access and migrations | Done |
| 7 | Auth | JWT login, private and public circuits, sharing | Done |
| 8 | Testing | Engine unit tests and API integration tests | Done |
| 9 | Design patterns | Gate factory, strategy pattern for simulation modes, dependency injection | |
| 10 | Redis and queues | Cached results; large truth tables as BullMQ jobs | |
| 11 | Docker | `docker-compose up` starts the API, Postgres, and Redis | |
| 12 | System design | Design document for scaling to thousands of users | |
| 13 | Polish | README, architecture diagram, Swagger, deployed demo | |

## Tooling notes

- **TypeScript is pinned to 6.0.x.** TypeScript 7, the native port, drops the JavaScript compiler API that tools such as the NestJS CLI and ts-jest depend on. Nothing here uses either any more (the tests run on Vitest), and the tsconfig avoids every option TypeScript 7 removed, so trying 7 should only need a version bump.
- **Node versions:**
  - The runner needs Node 20.3 or later, for `AbortSignal.any`.
  - The API and the database package need 22.18 or later, for Prisma 7.
  - The tests need 22.12 or later, for Vitest 5.
  - Development uses Node 24.
- **Prisma is pinned to 7.10.0,** the latest stable release. npm's `latest` tag points at an 8.0
  release candidate. `npm audit` reports advisories in the Prisma CLI's own dependencies
  (`deepmerge-ts`, and `mysql2`, which a PostgreSQL project never loads); its suggested fix is
  downgrading to Prisma 6.
- **Passwords use the `argon2` package,** which ships prebuilt native binaries and handles the
  standard hash format. Node 24 also has a built-in `crypto.argon2`, but it returns raw bytes,
  leaving that format to the caller.
- **NestJS 12 ships as ES modules; the app stays CommonJS like everything else.** It loads Nest
  through Node's `require(esm)`, with `"module": "nodenext"` in its tsconfig, as NestJS's migration
  guide advises. The Nest CLI isn't used; `tsc -b` builds the app with the rest of the repository.
