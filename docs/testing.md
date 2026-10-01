# CircuitLab testing (phase 8, extended in phase 9)

```bash
npm test
```

That builds everything, type-checks the tests, and runs all 633 of them in about 15 seconds. The
API's integration tests run twice: once with storage in memory, once on a real PostgreSQL 18.

| Command | What it does |
| --- | --- |
| `npm test` | Build, type-check the tests, run them all |
| `npm run test:coverage` | The same, with a coverage report (`coverage/index.html`); fails below the thresholds |
| `npm run test:watch` | Re-runs tests as files change; run `npx tsc -b -w` alongside so the build stays current |
| `npx vitest run --project engine` | One package: `engine`, `netlist`, `runner`, `api-contract`, or `api` |

## The choices

**Vitest.** NestJS now generates new projects with Vitest. Jest wasn't an option here: NestJS 12
ships only as ES modules, the app loads it through Node's `require(esm)`, and Jest's own module
loader doesn't support that. Node's built-in `node:test` would have worked, but has fewer tools
(matchers, table tests, coverage thresholds, watch mode).

**Tests run against the build.** A test imports `@circuitlab/engine` or `@circuitlab/api` like any
other user of the package, and gets the compiled `dist/`.
- **No second compiler.** What's tested is exactly what runs in production. Testing the sources
  directly would put another compiler in between (Vitest's), one that doesn't emit the decorator
  metadata NestJS's dependency injection depends on.
- **Vitest is told to load the builds natively**, like anything in `node_modules`
  (`server.deps.external` in [vitest.config.mts](../vitest.config.mts)).
- **The tests' types are checked too.** Vitest only strips types, so `npm test` runs
  `tsc -p tsconfig.test.json` first.
- **Cost:** a build before testing, which `npm test` does.

**One test, one rule.** Test names read as the rule they check ("refuses an edit based on an old
version (412) instead of overwriting someone's change"), so a failure says which promise broke.

## What is tested

| Project | Tests | What |
| --- | --- | --- |
| engine | 148 | Every gate type for every input combination (2 to 5 inputs, and 64-input gates on chosen vectors); known circuits against independent references; validation issues and their locations; sorting and cycles; simulation inputs; truth tables up to 2^53 rows; errors crossing JSON. Phase 9: the gate registry and factory; both simulation strategies (latches, flip-flops, a divide-by-two counter, oscillators, state checks); Tarjan's components against brute-force reachability |
| netlist | 20 | Reading, writing, and round trips; streamed input split at every possible byte (inside multi-byte characters too); every mistake in `broken.net` at its line; line-length and gate limits; gzip; cancellation |
| runner | 9 | Worker threads give the engine's exact answers and errors; overload (503 material), cancellation, time-outs, closing; a task that runs out of memory crashes only its own worker; sequential steps with state crossing the thread |
| api-contract | 90 | `openapi.yaml` and the code agree on every limit, code, and mode; request validation; RFC 9457 problems; cursor paging (no skips or repeats while circuits are added); ETags; content negotiation |
| api | 366 | The whole API over HTTP, against memory (160) and PostgreSQL (160); the time rules with an injected clock, on both (10); the app's smaller parts directly (33); startup and run-time database failures (3) |

**Known circuits, checked against independent references.** The half adder against its truth table;
the full adder against `S + 2·Cout = A + B + Cin`; a 6-bit ripple-carry adder for all 8,192
input rows; a 64-bit one against JavaScript's `BigInt` addition; ISCAS-85 c17 against its boolean
definition. A reference written differently from the code under test catches mistakes a copy of
the code would share.

**Random, but reproducible.** Random circuits and inputs come from a seeded generator, so a failure
happens again on the next run and can be debugged.

**Every response is checked against the contract.** The integration tests' HTTP client
([client.ts](../apps/api/test/support/client.ts)) checks each response against `openapi.yaml`:
- **Any 500 fails the test:** it is always a bug.
- **The status must be documented** for that operation.
- **Errors must be problem documents.**
- **JSON bodies must match** the schema the spec gives for that status.
- **Every operation must be exercised:** the last test fails if some operation was never called
  successfully.

So all ~300 integration tests are also contract tests.

**The access rules are tested as the table they are.** Owner, editor, viewer, stranger, and a
signed-out visitor each try nine actions on a private and on a public circuit, expecting exactly
the status in [auth-design.md](auth-design.md)'s table: 90 rows, plus who may delete.

**PostgreSQL without installing it.** Each PostgreSQL test file starts its own PGlite (PostgreSQL 18
compiled to WebAssembly) on a free port. It migrates it with `prisma migrate deploy`, exactly as
production does, and runs the app on it with one database connection (PGlite's limit; see
[database-design.md](database-design.md)). The database-failure tests also stop and restart it
under a running app.

## Do the tests catch bugs?

Coverage only says which lines ran. So, to check that the tests would notice bugs, 12 bugs were
planted by hand in the built code, one at a time. Every one made a test fail:

| Planted bug | Caught by |
| --- | --- |
| XOR computes even parity | half adder truth table |
| Truth-table row bits inverted | truth-table and known-circuit tests |
| Two wires on one pin go unnoticed | `finds two wires into one pin` |
| The min-heap loses its order (tie-breaks) | `returns a circuit already in a valid order unchanged` |
| A gate scheduled before its last input | the same, and the random-circuit ordering test |
| Editors may delete, share, publish | the access table |
| Shares ignored | the access table |
| A replayed refresh token doesn't end the session | `ends the whole session when a used refresh token comes back` |
| Tokens for another audience accepted | `refuses a token for another audience` |
| Forged time cursors accepted | `refuses a forged cursor` |
| A sixth password guess allowed | the throttle test |
| A cursor's own row repeated on the next page | `pages through ... with no skips or repeats` |

Phase 9 planted five more, in the code it added, and all were caught as well:

| Planted bug | Caught by |
| --- | --- |
| A loop's gates are never re-evaluated | the D latch and SR latch tests |
| Tarjan's components come out in the wrong order | the component and strategy-equivalence tests |
| The state passed in is ignored | `remembers: an SR latch is set, holds, is reset, and holds again` |
| The registry's NOR computes OR | the NOR gate tests |
| The token service ignores the injected clock | the access token expiring after 15 minutes |

This is mutation testing by hand; a tool such as Stryker automates it.

**Coverage:** 94% of statements, 85% of branches, 97% of functions. It is measured on the built
JavaScript and mapped back to the TypeScript through tsc's source maps. The thresholds sit a little
below that, so a change that drops coverage noticeably fails `npm run test:coverage`. Code running
in worker threads isn't measured (V8 coverage doesn't follow them); the pool tests check its
results instead.

## What the tests found

- **The sign-in throttle slowed down under attack.** Once its table of failed sign-ins was full
  (100,000 entries), every new failure scanned the whole table to make room for one more entry. An
  attacker making up email addresses could make each sign-in slower and slower. The fix: make room
  for 10,000 at a time, so a scan happens once per 10,000 failures.
- **The spec was missing responses.**
  - **503:** since phase 6 every endpoint can answer 503 when the database is down, but only the
    simulation endpoints documented it.
  - **401:** three endpoints that work signed out also refuse a bad token, which wasn't documented.
  - **Fix:** both added (18 responses), with spec tests that keep them documented.
- **The two storages disagreed about bad cursors.** PostgreSQL refused a forged time cursor (400);
  memory accepted it. The check moved into the contract, where both use it.
- **db:check didn't run every query it claimed to.** It now fails unless all 29 named queries
  run (found while extending it for phase 7).

## Time, without waiting (phase 9)

The rules that depend on time are tested by moving a clock instead of waiting
([time.test.ts](../apps/api/test/time.test.ts)). The app receives its `Clock` through dependency
injection, so the tests hand it one they control and move it forward. They check that:
- **access tokens** expire after 15 minutes;
- **sessions** end after 30 days without a refresh, and live on when refreshed in time;
- **blocked sign-ins** unblock after 15 minutes;
- **circuits, edits, and runs** are stamped with that time.

They run on both storages; see [design-patterns.md](design-patterns.md).

## Not covered

- **Load and performance:** phase 12's system design.
- **A browser front end:** phase 13, if there is one.
- **Continuous integration:** the project isn't in a git repository yet. A workflow running
  `npm test` and `npm run db:check` on every push fits phase 11, next to Docker.
- **An upstream warning:** Prisma's PostgreSQL adapter triggers a `pg` deprecation warning
  ("client.query() when the client is already executing a query") inside transactions. It is in
  Prisma's code, not ours, and harmless with `pg` 8.
