# How CircuitLab fits together

Three pictures, from far to near: what talks to what when it runs, which package builds on which,
and what happens during one request. Each links to the document that explains the details.

## What runs, and what talks to what

```mermaid
flowchart LR
    subgraph clients["Clients"]
        desktop["Desktop app<br/>(Electron)"]
        swagger["Swagger UI<br/>at /docs"]
        tools["curl, scripts,<br/>other programs"]
    end

    offline["engine + netlist<br/>inside the app"]
    proxy["Reverse proxy<br/>(Caddy, HTTPS)"]

    subgraph server["Server (Docker Compose)"]
        api["API<br/>(NestJS)"]
        worker["Worker<br/>(big truth tables)"]
        pg[("PostgreSQL<br/>accounts, circuits,<br/>run history")]
        redis[("Redis<br/>job queue, sign-in<br/>throttle, job results")]
        cache[("Redis<br/>result cache")]
    end

    desktop -- "online mode" --> proxy
    desktop -. "offline mode" .-> offline
    swagger --> proxy
    tools --> proxy
    proxy --> api
    api --> pg
    api --> redis
    api --> cache
    worker --> pg
    worker --> redis
```

- **The desktop app has two modes.** Online, it calls the API like any client. Offline, it runs the
  engine and the netlist reader itself, with circuits saved on the computer
  ([desktop-app.md](desktop-app.md)).
- **The API is one program that serves everyone.** It keeps nothing between requests, so any number of
  copies can run side by side ([system-design.md](system-design.md)).
- **The worker is the same program started differently.** It computes truth tables too big for one
  response, from a queue in Redis, so the API's answers never wait for them
  ([caching-and-jobs.md](caching-and-jobs.md)).
- **PostgreSQL keeps what must last,** Redis what only needs to last a while or be shared by every
  copy ([database-design.md](database-design.md)). In the development setup (`docker compose up`)
  both kinds of Redis data share one Redis; the production file gives the cache a Redis of its own,
  which may forget old entries.
- **The reverse proxy exists only in production.** It adds HTTPS and tells the API each client's
  address ([deploy.md](deploy.md)). Locally, clients talk to the API directly.

## Which package builds on which

An arrow means "uses". Everything points toward the engine, which uses nothing.

```mermaid
flowchart TD
    engine["<b>engine</b><br/>circuits, validation, simulation"]
    netlist["<b>netlist</b><br/>circuits as text files"]
    runner["<b>runner</b><br/>simulation on worker threads"]
    assistant["<b>assistant</b><br/>drafts circuits with Ollama"]
    contract["<b>api-contract</b><br/>openapi.yaml, and the code that enforces it"]
    database["<b>database</b><br/>migrations, Prisma Client"]
    api["<b>api</b><br/>the NestJS app, and the worker"]
    desktop["<b>desktop</b><br/>the Electron app"]

    netlist --> engine
    assistant --> engine
    assistant --> netlist
    runner --> engine
    contract --> engine
    contract --> netlist
    contract --> runner
    api --> contract
    api --> database
    desktop -. "offline: runs them itself" .-> engine
    desktop -. "offline" .-> netlist
    desktop -. "the assistant" .-> assistant
    desktop -. "online: HTTP, and the contract's types" .-> api
```

- **The API also uses the engine, the netlist reader and the runner directly.** Those arrows are left
  out so that the picture stays readable.
- **The engine is pure TypeScript,** with no Node or framework imports, so it runs anywhere: in the
  worker threads, in the API, in the desktop app's main process.
- **The contract is the source of truth for the API.** `openapi.yaml` states every endpoint, and the
  code in `api-contract` validates requests against it. The app serves it as it is
  ([api-design.md](api-design.md)); the test client checks every response against it
  ([testing.md](testing.md)); Swagger UI at `/docs` shows it.
- **The database package depends on nothing at run time but Prisma.** Its migrations are SQL
  written by hand.

## One simulation, from request to answer

```mermaid
sequenceDiagram
    participant C as Client
    participant A as API
    participant P as PostgreSQL
    participant R as Redis (cache)
    participant W as Worker thread

    C->>A: POST /v1/circuits/{id}/simulate, with the inputs
    A->>A: check the access token (its signature only)
    A->>P: may this person read the circuit? (the answer includes its version)
    A->>R: is there a result for this version and these inputs?
    alt in the cache
        R-->>A: the result
    else not in the cache
        A->>P: load the gates and wires
        A->>W: simulate, on a worker thread
        W-->>A: outputs and every signal
        A->>R: keep the result
    end
    A->>P: record the run in the circuit's history
    A-->>C: 200, the outputs (Cache-Status says hit or miss)
```

- **The access check always comes first,** even for a cached answer. A cache hit skips the heavy
  part (loading the circuit, the worker thread), never the question "may this person see it?".
- **The circuit's version is part of the cache key,** so a changed circuit is never answered from
  an old result, and nothing has to be invalidated.
- **A cached answer is still a run.** It is recorded in the history, which costs a database write
  ([system-design.md](system-design.md) measured it).

## One big truth table, as a background job

A table too big for one response is computed in the background. The client asks, gets a URL, and
polls it.

```mermaid
sequenceDiagram
    participant C as Client
    participant A as API
    participant P as PostgreSQL
    participant Q as Redis (queue)
    participant W as Worker

    C->>A: POST .../truth-table/jobs
    A->>P: record the job as queued, if the person is within their allowance
    A->>Q: queue the job's id
    A-->>C: 202 Accepted, with the job's URL in Location

    W->>Q: take the next job
    W->>P: mark it running
    loop for each page of rows
        W->>Q: keep the computed page, report the progress
    end
    W->>P: mark it succeeded

    C->>A: GET the job's URL (again, every couple of seconds)
    A-->>C: its status, and how many rows are done
    C->>A: GET .../result
    A->>Q: read the stored rows
    A-->>C: the table, as CSV or NDJSON
```

- **The database record is the truth about a job;** the queue only delivers. If Redis lost the
  queue, no job would claim a result it doesn't have.
- **A worker that dies loses nothing:** its job goes back to the queue and another worker takes it.

## Where each kind of state lives

| State | Where | Why |
| --- | --- | --- |
| Accounts, circuits, sessions, run history, job status | PostgreSQL | Must last, and is queried by relations |
| Cached results, sign-in failure counts, address limits, the job queue, job results | Redis, or the API's memory without `REDIS_URL` | Short-lived, shared by every copy, needs expiry and atomic counters |
| Circuits saved offline, settings, recent files | The desktop app's own folder | Works with no server |
| Nothing | The API process itself | So any copy can answer any request |

## Ways to run it

| Setup | Command | What it is for |
| --- | --- | --- |
| Everything in memory | `npm run start:api` | Trying the API in seconds; everything is lost when it stops |
| PostgreSQL and Redis in Docker | `docker compose up --build` | Development, and a look at how production runs ([docker.md](docker.md)) |
| On a server, behind HTTPS | `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build` | A demo others can reach ([deploy.md](deploy.md)) |
| The desktop app, offline | `npm run dev:desktop` | Drawing and testing circuits with no server at all |
