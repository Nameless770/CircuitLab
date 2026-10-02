# CircuitLab testing (phase 8, extended in phases 9 and 10)

```bash
npm test
```

That builds everything, type-checks the tests, and runs all 762 of them in about 25 seconds. The
API's integration tests run twice: once with everything in memory, and once as production runs,
on a real PostgreSQL 18 and a real Redis 8.

**Docker must be running** (since phase 10). Each test file that needs Redis starts its own, in a
container (`redis:8-alpine`), and the test with several processes also starts a PostgreSQL
(`postgres:18-alpine`). Without Docker those files fail at once, and say so.

| Command | What it does |
| --- | --- |
| `npm test` | Build, type-check the tests, run them all |
| `npm run test:coverage` | The same, with a coverage report (`coverage/index.html`); fails below the thresholds |
| `npm run test:watch` | Re-runs tests as files change; run `npx tsc -b -w` alongside so the build stays current |
| `npx vitest run --project engine` | One package: `engine`, `netlist`, `runner`, `api-contract`, `api`, or `desktop` |
| `npm run smoke:desktop` | Clicks through the real desktop app with Playwright (see [desktop-app.md](desktop-app.md#testing)); not part of `npm test` |

The desktop app's unit tests test its source directly (Vite transforms them), not a build: its
window code is bundled by Vite, never compiled by `tsc` alone. `npm test` type-checks them with
`tsc -p apps/desktop`.

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
| runner | 10 | Worker threads give the engine's exact answers and errors; overload (503 material), cancellation, time-outs, closing; a task that runs out of memory crashes only its own worker; sequential steps with state crossing the thread; phase 10's compact pages |
| api-contract | 97 | `openapi.yaml` and the code agree on every limit, code, and mode; request validation; RFC 9457 problems; cursor paging (no skips or repeats while circuits are added); ETags; content negotiation; phase 10's job limits and job resource |
| api | 434 | The whole API over HTTP, all in memory (175) and on PostgreSQL and Redis (175); the time rules with an injected clock, on both (16); the app's smaller parts directly (55); database failures (3); Redis failures and settings (5); several processes sharing PostgreSQL and Redis (5) |

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

So all ~370 integration tests are also contract tests.

**The access rules are tested as the table they are.** Owner, editor, viewer, stranger, and a
signed-out visitor each try nine actions on a private and on a public circuit, expecting exactly
the status in [auth-design.md](auth-design.md)'s table: 90 rows, plus who may delete.

**PostgreSQL without installing it.** Each PostgreSQL test file starts its own PGlite (PostgreSQL 18
compiled to WebAssembly) on a free port. It migrates it with `prisma migrate deploy`, exactly as
production does, and runs the app on it with one database connection (PGlite's limit; see
[database-design.md](database-design.md)). The database-failure tests also stop and restart it
under a running app.

**Redis and BullMQ, for real (phase 10).** Nothing imitates Redis well enough for BullMQ, which
runs Lua scripts and blocking commands, so the tests use real Redis servers, in Docker, one per
test file ([containers.ts](../apps/api/test/support/containers.ts)):
- **The PostgreSQL suites now also use Redis:** the cache, the throttle, and jobs going through
  BullMQ, under the same tests as in memory. Two new suites run on both setups: the cache (hits,
  misses, versions, the access check first) and jobs (the whole lifecycle; downloads byte for byte
  equal to the synchronous ones; limits; who sees what; cancelling).
- **Several processes** ([processes.test.ts](../apps/api/test/processes.test.ts)): two API-only
  instances and a separate worker share one PostgreSQL and one Redis.
  - Jobs queued by one instance wait, are found by the other, are computed by the worker, and
    report progress to both.
  - The same request through either instance gets the same job, and the allowance holds across
    instances.
  - A worker stopped halfway hands its job to the next one.
  - The sign-in throttle and the cache are shared.

  Several processes can't share one PGlite, so this file runs PostgreSQL in a container too.
- **Redis failing** ([redis.test.ts](../apps/api/test/redis.test.ts)): starting without it; a
  separate Redis for the cache; Redis stopped under a running app (simulating carries on uncached,
  sign-in and new jobs answer 503, and everything recovers without a restart); Redis frozen (503
  after two seconds rather than a hung request).

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

Phase 10 planted eight more, in its own code (in the TypeScript sources, rebuilt each time), and
all were caught:

| Planted bug | Caught by |
| --- | --- |
| The cache key forgets the circuit version | `never answers from an old version` |
| The cache key forgets the state of a sequential step | `keeps sequential steps apart by the state they start from` |
| The cache is looked at before the access check | `checks who is asking before looking in the cache` |
| An identical unfinished job isn't handed back | the several-processes test |
| A third job is let in while two are unfinished | the several-processes test |
| The Redis throttle reads the real time, not the injected clock | the throttle's time test, on Redis |
| A result is still served after its 24 hours | `keeps a job's result for 24 hours, then answers 410` |
| The in-memory cache evicts the oldest entry, not the least recently used | the cache's unit test |

This is mutation testing by hand; a tool such as Stryker automates it.

**Coverage:** 95% of statements, 85% of branches, 97% of functions. It is measured on the built
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
- **db:check didn't run every query it claimed to.** It now fails unless every named query runs
  (41 since phase 10; found while extending it for phase 7).
- **Phase 10: a job that couldn't be queued counted against its owner.** While Redis was down, the
  job's record was kept as failed, and used up one of the user's 20 daily jobs for an outage that
  was ours. Now such a job is forgotten, like any request turned away with 503.
- **Phase 10: recovering took up to 20 seconds.** After Redis came back, BullMQ's own connections
  waited up to 20 seconds between attempts to reconnect (its default), so new jobs failed long
  after everything else worked again. They now retry as often as the app's own client: at most
  every 2 seconds.
- **Phase 10: a finished job couldn't be looked at while Redis was down,** because checking for its
  result failed. The job is now reported, without the result's link.

## Time, without waiting (phase 9)

The rules that depend on time are tested by moving a clock instead of waiting
([time.test.ts](../apps/api/test/time.test.ts)). The app receives its `Clock` through dependency
injection, so the tests hand it one they control and move it forward. They check that:
- **access tokens** expire after 15 minutes;
- **sessions** end after 30 days without a refresh, and live on when refreshed in time;
- **blocked sign-ins** unblock after 15 minutes;
- **circuits, edits, and runs** are stamped with that time.

Phase 10 added:
- **a job's result** expiring after 24 hours (410 after that);
- **the daily allowance** of 20 jobs growing again 24 hours after the oldest, as `Retry-After` says;
- **housekeeping** failing a lost job after an hour, and deleting expired sessions.

They run on both setups, so the Redis throttle and the job results answer to the injected clock
too; see [design-patterns.md](design-patterns.md).

## Not covered

- **Load and performance:** phase 12's system design.
- **A browser front end:** phase 13, if there is one.
- **Continuous integration:** a workflow running `npm test` (with Docker) and `npm run db:check`
  on every push fits phase 11, next to Docker.
- **The housekeeping schedule itself:** the tests run housekeeping directly, and check that the
  BullMQ schedule exists; they don't wait 10 minutes for it.
- **An upstream warning:** Prisma's PostgreSQL adapter triggers a `pg` deprecation warning
  ("client.query() when the client is already executing a query") inside transactions. It is in
  Prisma's code, not ours, and harmless with `pg` 8.
