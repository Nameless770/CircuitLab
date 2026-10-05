# CircuitLab testing (phase 8, extended in phases 9, 10 and 13, and for the assistant)

```bash
npm test
```

That builds everything, type-checks the tests, and runs all 1,011 of them in about 40 seconds. The
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
| `npx vitest run --project engine` | One package: `engine`, `netlist`, `assistant`, `runner`, `api-contract`, `api`, or `desktop` |
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
| assistant | 189 | The formulas the model writes (what they mean, and what is refused as unclear); the truth-table minimizer (all 256 tables of up to 3 inputs, random ones up to 8); circuits built from formulas, compared row by row with ordinary code through the real engine (adders, multiplexer, decoder, comparator, parity, an 8-input table needing over 64 products, a latch that remembers); every recipe in the prompt, against its own reference and the checks that every answer goes through; describing a circuit and building it again, for 33 circuits; the retry loop with a scripted model (what is sent back, three answers at most, a refusal isn't retried); the Ollama client against a fake web server, for every way it can fail |
| desktop | 78 | The layout and editing rules, offline simulation, settings (read back one part at a time), and the assistant's part: which model is used, what the window is shown for a draft |
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
- **Documentation and going online** (the "server" tests in [suites/all.ts](../apps/api/test/suites/all.ts), and
  [auth-limits.test.ts](../apps/api/test/auth-limits.test.ts)):
  - `/openapi.json` names the server it is on, and lists every operation; `/docs` serves the page and only
    the Swagger UI files it uses (nothing else in that package's folder, whatever the path tries); `/` leads
    there; none of it needs a token, not even a bad one.
  - `TRUST_PROXY`: the throttle counts by the address a proxy reports, and a made-up address further left
    in `X-Forwarded-For` isn't believed; with no proxy trusted, the header is ignored.
  - The address limit (`AUTH_RATE_LIMIT`), on memory and on PostgreSQL with Redis: 429 with `Retry-After`
    after the limit, sign-ins and registrations counted together, a count for each address, a new count
    each minute (by moving the clock), and refreshing a token or any other request not limited.

- **The scaling plan's first stage** (stage 1 of [system-design.md](system-design.md#stage-1-fix-the-sharp-edges)):
  - **The database wait limit** ([database-failures.test.ts](../apps/api/test/database-failures.test.ts)): a
    pool of one connection is held, and a second request gives up at its limit (300 ms) with a 503 and
    `Retry-After`, then works again when the connection is free. Making the pool run dry for real found
    that the timeout reaches the app as a plain `Error` that Prisma doesn't classify, so it was a 500 until
    the error mapping learned its words.
  - **`If-None-Match`:** a 304 loads no circuit (the repository's `find` is watched: once for a 200,
    never for a 304, JSON or netlist); a stale tag gets the new circuit and tag; a stranger with a tag that
    would match gets a 404, never a 304. The test fails on the old code.
  - **Retention** (the time tests, on memory and on PostgreSQL, by moving the clock 35 days; a unit test of
    the batching loop; `db:check` for the SQL): runs and lost jobs older than 30 days are deleted, newer
    ones aren't, a batch deletes no more than its limit, nothing is asked at 0 days, a run still unfinished
    is never deleted, and the oldest runs are found through `simulation_runs_created_idx`.

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

Phase 13 planted six more, in the built code, and all were caught:

| Planted bug | Caught by |
| --- | --- |
| The address limit lets one attempt too few through (`>=` for `>`) | `answers 429, with Retry-After, once an address has signed in 5 times` |
| Registrations aren't counted | `counts registrations too: they cost the same hash` |
| The proxy's header is believed from the far end (`trust proxy: true`) | `believes only the proxy's own hop` |
| The header is never believed (`trust proxy` never set) | eleven tests of the limit and the throttle by address |
| A new minute doesn't start a new count | `starts a new count with each minute` |
| Any file in Swagger UI's folder can be downloaded | `serves the documentation page, and only the Swagger UI files that it uses` |

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

## Continuous integration

[.github/workflows/ci.yml](../.github/workflows/ci.yml) runs on every push to `main` and on every pull
request, on fresh Ubuntu 24.04 machines from GitHub (pinned, because GitHub is moving the `ubuntu-latest`
label to 26.04 in the autumn of 2026, and a build that turns red on a day nobody changed anything is a
confusing way to find out). The badge at the top of the README shows the last result on `main`.

| Job | What it runs |
| --- | --- |
| Tests | `npm ci` (the versions in the lockfile), `npm test`, `npm run db:check`, `npm run lint:api` |
| Docker image and Compose files | `docker build`; `docker compose config` for the development setup and the production one; then the image is started with no database and asked for `/health`, `/docs` and `/openapi.json` |

- **Docker is already on those machines,** so the tests start the same Redis and PostgreSQL containers as
  on a laptop.
- **Electron isn't downloaded** (`ELECTRON_SKIP_BINARY_DOWNLOAD`): the desktop app's unit tests never start
  it.
- **A newer commit cancels** the older run on its branch, and the workflow can only read the repository.
- **Not run there:** the desktop smoke test (it drives the real window: `npm run smoke:desktop`), the load
  scripts (`scripts/load`), and a real deployment.

**Checked on Linux before it existed.** The project is developed on Windows, and its tests had only ever
run there. So the `tests` job was simulated: a Linux container with Node 24, 4 CPUs and access to Docker,
running the same commands on the project's files. All 782 tests, the migrations check and the lint passed,
in about two and a half minutes (`npm ci` 70 seconds, `npm test` 54, `db:check` 18). The workflow file
itself was checked with `actionlint`, which also runs `shellcheck` on its scripts.

**What the simulation found: line endings.** Its first run used files with Windows line endings (CRLF),
which is what a fresh `git clone` on Windows gives, because Git for Windows converts by default. One test
failed: "accepts Windows line endings and a byte-order mark" added its own `\r` to a fixture that already
had one. The repository stores LF, and so did the working copy of the machine it was written on, so it had
never happened there; anyone cloning on Windows would have seen it. Two fixes: the test first brings the
fixture to LF, so that it no longer depends on how the file was checked out; and
[.gitattributes](../.gitattributes) pins LF for text files in every checkout (`* text=auto eol=lf`), which
also keeps shell scripts and the Caddyfile working when they are mounted into Linux containers.

## Not covered

- **Load and performance:** measured by hand in phase 12, not by `npm test`: load numbers depend on
  the machine, so a test with a threshold would fail on a slow day. The scripts are in `scripts/load`,
  and the results in [system-design.md](system-design.md).
- **A browser front end:** there isn't one. The front end is the desktop app, covered by its unit tests and
  its smoke test.
- **A Windows run in CI:** the tests run on Linux there, and on Windows by whoever develops. The line-ending
  fix above is what keeps the two alike.
- **The housekeeping schedule itself:** the tests run housekeeping directly, and check that the
  BullMQ schedule exists; they don't wait 10 minutes for it.
- **An upstream warning:** Prisma's PostgreSQL adapter triggers a `pg` deprecation warning
  ("client.query() when the client is already executing a query") inside transactions. It is in
  Prisma's code, not ours, and harmless with `pg` 8.
