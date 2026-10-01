# CircuitLab API design (phase 3, extended in phases 6 to 8)

The contract is [`packages/api-contract/openapi.yaml`](../packages/api-contract/openapi.yaml).
This document explains the decisions behind it. `npm run demo:api` shows the API's answers,
request by request. Accounts and access (phase 7) are explained in
[auth-design.md](auth-design.md).

## Contract first

The OpenAPI document is written first and is the single source of truth:

- **Requests are validated against it at run time.** Its schemas are compiled with Ajv and used as
  they are, so the documented rules and the enforced rules are the same rules, not two copies that
  can drift apart.
- **Content negotiation reads it.** Which media types an operation accepts and returns comes from
  the spec itself.
- **It is linted** (`npm run lint:api`, Redocly's recommended rules).
- **The tests prove the responses match it.** Every response in the integration tests (phase 8) is
  checked against the spec: its status must be documented for that operation, and its body must
  match the schema given for that status. See [testing.md](testing.md).
- **Phase 13 serves it** with Swagger UI, rather than generating documentation from code.

`@circuitlab/api-contract` holds the spec and the framework-free code that enforces it.
Phase 4 wires it into NestJS, and phases 5 and 6 add storage.

## Resources

| Method and path | Purpose |
| --- | --- |
| `GET /v1/circuits` | List circuits: yours, shared with you, or public (`scope`); cursor pages, `sort`, `q` name search |
| `POST /v1/circuits` | Create from JSON or a netlist file; `dryRun=true` only validates |
| `GET /v1/circuits/{id}` | Get as JSON, or as a netlist file (`Accept`) |
| `PUT /v1/circuits/{id}` | Replace (JSON or netlist) |
| `PATCH /v1/circuits/{id}` | Rename, change the description, or change the visibility (JSON Merge Patch) |
| `DELETE /v1/circuits/{id}` | Delete |
| `POST /v1/circuits/{id}/simulate` | Evaluate once; `include=signals` adds every gate's signal |
| `GET /v1/circuits/{id}/truth-table` | Rows by `offset` and `limit`, as JSON pages, NDJSON, or CSV |
| `GET /v1/circuits/{id}/runs` | Recent simulations (phase 6) |
| `GET`, `POST /v1/circuits/{id}/shares`; `DELETE .../shares/{userId}` | Who it is shared with; share; stop sharing (phase 7) |
| `POST /v1/auth/register`, `/login`, `/refresh`, `/logout`; `GET /v1/users/me` | Accounts and tokens (phase 7) |

**Choice of methods:**
- **`simulate` is `POST`.** It takes a body, and it records a simulation run.
- **The truth table is `GET`.** It is a safe, cacheable read of rows that depend only on the circuit version.

**Stored circuits may contain feedback loops.** A latch is valid structure. The summary reports the
loop. Combinational simulation (the default) answers 422 `feedback-loop`; sequential simulation
(phase 9, `"mode": "sequential"`) runs it one step per request.

**Sequential steps keep no state on the server.** Each answer carries the circuit's `state` (the
values of the gates on its loops), and the client sends it back with the next step, like a page
cursor. So any API instance can serve any step, and nothing needs cleaning up when a client walks
away.

**Gate ids** are limited to netlist-safe names (letters, digits, `_ . $ [ ]`), for two reasons:
- **Every stored circuit can be exported as a netlist.**
- **CSV needs no quoting.**

## One resource, several representations

| Resource | Representations |
| --- | --- |
| Circuit | `application/json`, `text/vnd.circuitlab.netlist` (optionally gzipped on upload) |
| Truth table | `application/json` (one page), `application/x-ndjson` and `text/csv` (downloads) |

- **Clients choose** with `Content-Type` (what they send) and `Accept` (what they want back).
- **Mismatches** answer 415 (unsupported body type) or 406 (no acceptable response format).
- **Errors are always `application/problem+json`**, whatever `Accept` says.

## Errors

**Format.** Every error is an RFC 9457 problem document with these fields:
- `type`: a relative URL such as `/problems/invalid-circuit`.
- `title` and `status`.
- `detail`: a sentence for people.
- `instance`: the request path that failed.
- `code`: the last segment of `type`, easy to match in code.

**Validation errors** also list every problem found in `issues`, not just the first. Each issue says where the problem is:

| Location field | Points into |
| --- | --- |
| `pointer` | The JSON body, as an RFC 6901 JSON Pointer, e.g. `/gates/3/type` or `/inputs/B` |
| `parameter` | The query string |
| `line`, `column` | A netlist body |

**400 or 422.**
- **400** means the request could not be read: an unparseable body, a body that isn't an object,
  or a bad query parameter.
- **422** means it was read, but what it describes is invalid: a circuit, a netlist, or simulation
  inputs.

| Status | Codes |
| --- | --- |
| 400 | `invalid-request`, `malformed-body` |
| 401 | `unauthenticated` (sign in first), `invalid-token`, `invalid-credentials`; always with `WWW-Authenticate` |
| 403 | `forbidden`: you can see the circuit, but may not do this to it |
| 404 | `not-found`, also for a circuit you may not see |
| 406, 415 | `not-acceptable`, `unsupported-media-type` |
| 409 | `version-conflict` (a truth-table page from a newer circuit version), `email-taken` |
| 412 | `precondition-failed` (stale `If-Match`) |
| 413 | `content-too-large` |
| 422 | `invalid-circuit`, `invalid-netlist`, `invalid-inputs`, `feedback-loop`, `does-not-settle` (sequential mode), `too-many-inputs`, `computation-too-large`, `invalid-fields` (account and sharing bodies) |
| 429 | `too-many-requests` (failed sign-ins), with `Retry-After` |
| 500 | `internal-error`: the body never reveals details; the server logs them |
| 503 | `server-busy` and `server-unavailable` (shutting down, or the database is unreachable), with `Retry-After`; `simulation-timeout` |

**`toProblem(error)`** maps every error to its response. This covers the engine's errors, the
netlist reader's, the worker pool's, cancellation, and unexpected bugs. It is the single mapping,
so the same failure always gets the same answer.

## Validation in two layers

1. **The schema** checks shape and limits: types, required and unknown fields, gate-id format, a
   `value` only on CONST gates, and at most 10,000 gates and 50,000 wires. Unknown fields are
   rejected rather than silently dropped.
2. **The engine** checks what a schema cannot express: dangling wires, pin counts, duplicate ids,
   and wires driven by an OUTPUT.

**Simulation inputs are a deliberate exception.** The schema only checks that `inputs` is an
object. The values are left to the engine, which checks them together with the names the circuit
expects, so a wrong value, a missing input, and an unknown input are all reported in one answer.

## Pagination

**Circuit list: cursors.** The list changes while someone pages through it. With `page=N`,
inserting a circuit would shift every later page, so one item would be repeated and another
skipped.
- **How it works.** A cursor records where the previous page ended (its last item's sort value and
  id) and asks for "the items after that".
- **The same idea in SQL:**

  ```sql
  SELECT ... FROM circuits
  WHERE (created_at, id) < ($cursorCreatedAt, $cursorId)   -- only when a cursor is given
  ORDER BY created_at DESC, id DESC
  LIMIT $limit + 1                                          -- the extra row means "there is a next page"
  ```

- **Why it's also fast.** That is an index seek, as fast on page 1,000 as on page 1. `OFFSET 20000` has to walk past 20,000 rows every time.
- **No total count.** Counting a large table on every request is expensive.
- **Cursors are opaque but validated.** Clients mustn't build them, and a cursor made for another sort order is rejected.

**Truth-table rows: offset and limit.** A table never changes for a given circuit version, and row
`n` is always the same inputs (`n` in binary), so any page can be fetched directly.
- **Version pin.** Every link carries `version`, so following links after the circuit has been
  edited answers 409 instead of silently mixing rows from two different circuits.
- **Size limits.** JSON pages hold at most 4,096 rows. A CSV or NDJSON download holds at most
  1,048,576 rows, and a range that is too big is refused rather than silently cut short. Larger
  jobs belong to phase 10's background jobs.

## Conditional requests

Every circuit response carries `ETag: "<version>"`.
- **`If-None-Match`** on reads answers 304 with no body when the client's copy is still current.
  This saves bandwidth and prepares for caching (phase 10).
- **`If-Match`** on `PUT`, `PATCH`, and `DELETE` answers 412 if the circuit changed since the client
  loaded it. When two people edit the same circuit, the second save no longer silently erases the
  first. Sharing arrives in phase 7, so this matters.

## Overload and time limits

Simulations run on a fixed pool of worker threads (phase 2).

| Situation | Answer |
| --- | --- |
| All workers busy and the waiting queue full | 503 `server-busy` with `Retry-After: 1`: failing fast beats piling up requests until memory runs out |
| Server shutting down | 503 `server-unavailable` with `Retry-After: 5` |
| Past the 10-second limit | The worker is stopped; 503 `simulation-timeout` |
| A task needing more memory than a worker may use | 422 `computation-too-large`: the same request would fail again, so it's the client's to change |
| The client disconnects | Phase 4 aborts the task. `client-closed-request` (499, nginx's convention) exists only so logs record what happened |

## Evolution

- **Versioning.** Everything is under `/v1`. Additive changes (new endpoints, new optional fields or
  parameters) stay in v1; clients must ignore fields they don't know. A breaking change means `/v2`.
- **What later phases add, each one backward compatible:**

| Phase | Adds |
| --- | --- |
| 7 | Done: JWT authentication, `visibility`, and sharing, as planned. A circuit you may not see answers 404, not 403. See [auth-design.md](auth-design.md) |
| 9 | Done: `mode` and `state` on `simulate`, `mode` on responses and recorded runs, and 422 `does-not-settle`. All additions: a client that never sends `mode` sees the same API, plus a `mode` field. See [design-patterns.md](design-patterns.md) |
| 10 | Truth tables too large for one response as background jobs: `202 Accepted` with a job URL to poll. Also `Idempotency-Key` for safely retried POSTs, and 429 with `RateLimit` headers |
| 13 | Swagger UI serving `openapi.yaml`, and documentation pages at each problem `type` URL |
