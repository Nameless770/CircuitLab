# The CircuitLab desktop app

A Windows program (it should also work on macOS and Linux, but I've only tried Windows) to build
logic circuits, switch their inputs, and watch the signals. It has two modes:

- **Online:** your circuits on the CircuitLab API. Sign in, create circuits, share them, make
  them public, and let the server compute big truth tables in the background.
- **Offline:** circuits saved in the app's **library** on your computer, plus netlist files
  (`.net`) when you want them. No account and no server; the app simulates them itself with the
  same engine the API uses.

```bash
npm run dev:desktop     # develop: the app with hot reload (start the API too for online mode)
npm run start:desktop   # build it and run it as users would get it
npm run smoke:desktop   # click through the real app automatically (screenshots in apps/desktop/dist/smoke/)
npm run package:desktop # make the Windows installer: apps/desktop/release/CircuitLab-Setup-0.1.0.exe
```

Online mode needs the API: `npm run start:api` (it listens on port 3000). To use another server,
change its address in **Settings** (File > Settings, or the link in the top bar).

## How it fits together

```
┌──────────────── the app's window ────────────────┐
│ apps/desktop/src: plain TypeScript, built by Vite │
│ pages, the diagram, the editors                   │
└───────┬──────────────────────────────┬────────────┘
        │ fetch("/v1/...")             │ window.circuitlab.simulate(...)
        │                              │ (only the functions in electron/bridge.ts)
┌───────▼──────────────────────────────▼────────────┐
│ Electron main process (Node.js): electron/main.ts │
│ forwards /v1 to the API │ offline.ts: @circuitlab/ │
│                         │ engine + netlist, files  │
└───────┬───────────────────────────────────────────┘
        │ HTTP
┌───────▼──────────┐
│ the CircuitLab API│ (phases 4 to 10, unchanged)
└──────────────────┘
```

## The decisions, and why

### 1. Electron

**Why Electron.** The whole project is TypeScript. Electron's main process *is* Node.js, so offline
mode uses `@circuitlab/engine` and `@circuitlab/netlist` exactly as they are, the same code the
API runs. The window is Chromium, so the screens are ordinary HTML, CSS and TypeScript.

**What it costs.** Electron ships its own copy of Chromium, so the installer is big (111 MB, of
which our own code is about 340 KB).
Tauri makes much smaller apps, but its back end is Rust, which would mean rewriting the engine or
running Node beside it.

### 2. Plain TypeScript, no UI framework

No React or Angular: the screens are built with two small helpers, `h()` and `s()` in
[dom.ts](../apps/desktop/src/dom.ts), which create real DOM elements. Each page is a function that
draws itself into a box the router gives it.

**Never `innerHTML`.** Circuit names, descriptions and gate labels are typed by users. Put into
`innerHTML`, a circuit named `<img src=x onerror=...>` would run code on everyone who opens it
(XSS). The helpers only ever set text with `textContent`, which never runs anything.

### 3. One set of screens for both modes

The simulator and the truth table don't know whether a circuit is on the server or in a file. They
talk to a `CircuitBackend` ([backend.ts](../apps/desktop/src/circuit/backend.ts)) with three
functions: simulate, get a page of the truth table, export CSV. `onlineBackend()` calls the API,
and `offlineBackend()` calls the main process. It's the same idea as phase 9's simulation
strategies: one interface, interchangeable implementations.

### 4. Security: the window can only ask for a few things

- **No Node.js in the window** (`contextIsolation`, `sandbox`, `nodeIntegration: false`).
- **A narrow bridge.** [preload.ts](../apps/desktop/electron/preload.ts) exposes exactly the
  functions in [bridge.ts](../apps/desktop/electron/bridge.ts): open, save and parse netlists,
  simulate, and so on. It never exposes `ipcRenderer` itself, which would let the window send
  any message to the main process.
- **The main process checks what it gets.** Every circuit from the window goes through the
  engine's validation, the same as an upload to the API.
- **A Content-Security-Policy** in `index.html` allows only the app's own scripts.
- **Links to websites open in your browser**, never inside the app.
- **No escaping the app's folder.** The `app://` file handler refuses paths like `/../../secret`.

### 5. Talking to the API without CORS

The window always loads from `app://circuitlab/`, our own URL scheme, and every request it makes
goes through one function in the main process (`serveApp` in `main.ts`):
- `/v1/...` and `/health` are forwarded to the API, at the address in Settings;
- everything else is the window's own files: from Vite's dev server while developing (so hot
  reload still works), or from `dist/renderer` in the installed app.

So the window always calls relative paths such as `/v1/circuits`, and the API didn't need any
change, not even CORS headers.

**Why one forwarder.** At first Vite's proxy did the forwarding during development and the main
process did it in the built app. Two places doing one job have to agree, and only the main
process can read the Settings, so now it does the job alone, in both.

**Settings.** The server address is saved in `settings.json` in the app's data folder. The
Settings screen checks it before saving: it must be an `http://` or `https://` address
(`normalizeApiUrl` in [helpers.ts](../apps/desktop/electron/helpers.ts)). Accounts belong to a
server, so changing the server signs you out (it asks first). `CIRCUITLAB_API_URL`, when set,
overrides the saved address for one run; development and tests use that. A server put online as in
[deploy.md](deploy.md) works the same way: type its `https://` address.

### 6. Signing in

- **Tokens.** Register or sign in to get an access token (15 minutes) and a refresh token. Both
  are kept in the window's `localStorage`, so you stay signed in after a restart.
- **Expired tokens.** When the API answers `invalid-token`, [api.ts](../apps/desktop/src/api.ts)
  trades the refresh token for new ones and retries the request once. You never notice.
- **Only one refresh at a time.** The API ends the whole session if a refresh token is used
  twice (phase 7's reuse detection: it assumes the token was stolen). Several requests can find the
  token expired at the same moment, so they share one refresh (`refreshing` in api.ts) instead
  of each starting its own.

### 7. Drawing circuits

**Problem: the API stores gates and wires, but not where they are on screen.**

**Solution: automatic layout,** in [layout.ts](../apps/desktop/src/diagram/layout.ts).
- Inputs go in the first column, and every gate goes one column right of the gates that feed it
  (the same idea as the engine's topological sort).
- A feedback loop (a latch) is placed anyway instead of waiting forever.
- Outputs go in the last column.
- Within a column, each gate sits level with the gates that feed it, to keep wires short.

**If you move gates yourself,** the positions are saved on your computer
([saved-positions.ts](../apps/desktop/src/diagram/saved-positions.ts)). If the circuit changed
somewhere else and a gate has no saved position, the automatic layout is used instead, so gates
never pile up.

**Gate symbols** are the standard ones, drawn as SVG paths ([draw.ts](../apps/desktop/src/diagram/draw.ts)).
After a simulation, a wire is green when it carries a 1.

### 8. The editor

- **The rules are plain functions on plain data,** in
  [draft.ts](../apps/desktop/src/editor/draft.ts): add, connect, rename, change the number of
  inputs. Each change is checked there; for example, a new wire on an input pin replaces the old
  one. That makes them easy to unit test without a window.
- **The mouse handling** lives in [editor-view.ts](../apps/desktop/src/editor/editor-view.ts): it
  turns clicks and drags into those calls.
- **No listener per gate.** The drawing is redrawn from scratch after every change. Each gate,
  pin and wire carries `data-` attributes, and one listener on the whole drawing reads them
  ("event delegation").
- **"Check" asks the real validator:** the API's `dryRun=true`, or the engine offline. The gates
  it complains about are outlined in red.
- **Big circuits.** Netlists can be edited as text, which suits circuits too big to draw, and
  pasting.

### 9. Offline: the library, and files

**The problem.** At first, offline work could only be kept as a file: every save opened a Save
dialog, and nothing in the app listed what you had made.

**The library.** Saving now keeps the circuit inside the app ([library.ts](../apps/desktop/electron/library.ts)).
- **Save needs no dialog.** "Save" in the editor stores the circuit at once and opens its page,
  ready to try. The Library page (Ctrl+L) lists everything, newest first, with a search; the home
  screen shows the latest five.
- **One JSON file per circuit** in the app's data folder (`%APPDATA%\CircuitLab\library`). Each
  holds:
  - the netlist itself;
  - what a netlist can't hold: a description, and when it was created and last saved;
  - a summary (gates, inputs, outputs), so the Library page lists circuits without reading
    every netlist.
- **Why files, and not the window's `localStorage`?** Files survive clearing the app's cache, have
  no size limit, and can be backed up by copying a folder.
- **Saves can't half-happen.** Each save writes a temporary file and then renames it over the
  old one. If the app stops halfway, the old version is still whole.
- **Reading back is careful.** Ids are checked before they touch the disk, so `../` can't
  escape the folder. A damaged file is skipped rather than hiding every other circuit, and a
  `format` number lets a later version recognise old files
  ([library-entries.ts](../apps/desktop/electron/library-entries.ts), unit tested).

**Files still work, when you ask for them.** "Export as file…" writes a `.net` copy;
"Import netlist file…" and "Save to library" copy a file in. A file opened directly (File > Open,
or a double-click) still saves back to that file. Online circuits have "Save to library" too,
which keeps a copy that works without the server.

**How files and errors work:**
- **Files are netlists:** the format from phase 2, so files work with the rest of the project
  (`examples/netlists`, the API's netlist upload).
- **Errors cross over as data.** An error thrown in the main process reaches the window as a bare
  message. So every call returns either a value or a problem described as data, with the same
  codes as the API (`invalid-netlist`, `feedback-loop`, ...). The window shows both kinds of
  error the same way.

### 10. The installer

```bash
npm run package:desktop
```

This makes `apps/desktop/release/CircuitLab-Setup-0.1.0.exe`: the usual Windows setup wizard
(NSIS), with Start-menu and desktop shortcuts and an uninstaller in "Apps & features". It
installs for the current user only, so it needs no administrator rights.

- **The main process is bundled** ([vite.main.config.mts](../apps/desktop/vite.main.config.mts)).
  - **The problem:** in this repo, `@circuitlab/engine` and `@circuitlab/netlist` are workspace
    links in `node_modules`, and an installed app has no repo around it.
  - **The fix:** Vite copies their code into `dist/electron/main.js`, the same way it bundles the
    window's code. So the app needs no `node_modules` at all.
  - **What's left for tsc:** it only type-checks the Electron side now.
- **Only built files go in** ([electron-builder.yml](../apps/desktop/electron-builder.yml)):
  `dist/renderer`, `dist/electron` and `package.json`. No sources and no tests.
- **Electron's version is pinned** (`44.5.1`, not `^44.5.1`). The installer contains Electron
  itself, so it must be the exact version we tested; electron-builder refuses a range.
- **The icon** is [build/icon.svg](../apps/desktop/build/icon.svg), turned into `icon.png` by
  Electron itself (`npx electron scripts/make-icon.cjs`).
- **Double-click a `.net` file** and it opens in CircuitLab.
  - **The association:** `fileAssociations` in electron-builder.yml makes the installer register
    the file type for you; the uninstaller removes it.
  - **The file:** Windows starts the app with the file's path as an argument, and
    `netlistFileFromArgs` finds it.
  - **Only one CircuitLab at a time** (`requestSingleInstanceLock`). If it's already open, the new
    copy hands the file to the running one and quits, so you don't get a second window.
- **Testing the result.** `npm run smoke:packaged -w @circuitlab/desktop` runs the same 17-step
  smoke test against `release/win-unpacked/CircuitLab.exe`, which holds exactly the files the
  installer installs.

**It isn't code-signed,** so the first time you run the installer Windows shows "Windows
protected your PC". Click "More info", then "Run anyway". Signing needs a code-signing
certificate, which costs money and needs a verified identity; see the known shortcuts below.

### 11. The assistant

A panel in the netlist editor that drafts circuits with a model running in Ollama. How it works, and
how good it is, is in [assistant.md](assistant.md). What belongs here is how it sits in the app:

- **In the main process,** like offline mode: the window may only talk to its own origin, and
  Ollama is another address. [assistant.ts](../apps/desktop/electron/assistant.ts) chooses the model and
  prepares the draft (the circuit the window shows, and its truth table when it is small); the
  work is in `@circuitlab/assistant`, which Vite bundles into `main.js` like the engine.
- **Five more functions in the bridge:** `assistantStatus`, `setAssistant`, `askAssistant`,
  `cancelAssistant` and `onAssistantProgress`. The window sends a request and gets a draft back. The
  window never gives an address for the request to go to: that is a setting, checked when saved.
- **Progress is pushed, not asked for.** A question can take a few seconds, so the main process sends
  "attempt 2 of 3: fixing 1 problem" to the window as it goes. The bridge can only add listeners, never
  remove them, so there is one listener for the whole window, which passes progress on to whichever panel
  is waiting.
- **Cancel** aborts the request to Ollama (an `AbortController` per question). One question at a
  time: asking again stops the one before.
- **One more setting file part.** `settings.json` now also holds Ollama's address and the model.
  Each part is read on its own, so a bad address doesn't lose the others, and saving one part keeps the rest.
- **One place for it:** the netlist editor, which both modes use. Offline had no way to start a netlist
  from scratch, so there is now `#/local/new/netlist`.

## Testing

- **Unit tests** (`apps/desktop/test`, run by `npm test`): the layout, the editing rules, offline
  simulation, CSV export, a test that the window's copy of the pin counts still matches the
  engine's, and the assistant's part (which model is chosen, what the window is shown, settings that
  are read back).
- **The smoke test** ([smoke.mjs](../apps/desktop/scripts/smoke.mjs)) checks that the screens
  and pieces fit together:
  - **Setup.** It starts an API in memory and opens the *built* app with Playwright.
  - **Steps.** It clicks through both modes in 23 steps, and saves a screenshot of each:
    - starting with a `.net` file, and a second launch handing one over;
    - setting the server address in Settings;
    - examples, a latch;
    - the library: saving with no dialog, listing, searching, opening, deleting, exporting a file;
    - an account, sharing, a background job, editing, uploading;
    - the assistant, against a fake Ollama: choosing a model in Settings, drafting a circuit offline
      and online, using it, changing a circuit and undoing, Cancel, a refusal, Ollama not running.
  - **Isolation.** It uses a throwaway profile (`CIRCUITLAB_USER_DATA_DIR`), so it never signs
    you out or fills your list of recent files.

## Known shortcuts

Things I chose not to do yet, and why:

| Shortcut | Why it's acceptable for now | The proper fix |
| --- | --- | --- |
| Tokens live in `localStorage`, where a script running in the window could read them | No user text ever goes into `innerHTML`, the CSP blocks other scripts, and no third-party code is loaded | Keep the refresh token in the main process (or the OS keychain) instead of the window |
| Gate positions are kept per computer | The API has no field for them; the automatic layout covers everything else | Optional `x`/`y` on gates in the API: an additive change, so it fits in `/v1` |
| The library lives on one computer: nothing syncs it to another | Online mode is the shared place; "Upload to my account" and "Export as file…" move circuits | Sync the library with the account |
| Opening the Library page reads every saved circuit's file | Each is small: hundreds open in a blink | One index file listing them all |
| Edit buttons show for every signed-in user who isn't the owner | The API doesn't say whether you're a viewer or an editor; a viewer who tries to save gets a clear 403 | Add your role to the circuit response |
| Two app windows refreshing tokens at the same instant could end the session | It needs two windows and an expiring token at the same moment | Let the main process own the tokens, so there's one refresher |
| Offline simulation runs in the main process, so a huge page of rows could freeze the app briefly | A page is at most 4,096 rows; normal circuits take milliseconds | Run it on `@circuitlab/runner`'s worker threads, like the API |
| The drawing editor has no undo and no zoom, and stops at 400 gates | Big circuits can be edited as netlist text | Undo stack; zoom with the SVG viewBox |
| Saving a drawing to a file rewrites it, losing comments | The app warns before you do it; "Edit netlist" keeps the text exactly | Keep comments by editing the text instead of rewriting it |
| The assistant is in the netlist editor only, not the drawing editor | A circuit it drafts is saved like any other and then drawn automatically | A "describe it" box in the drawing editor |
| The installer isn't code-signed, so Windows SmartScreen warns before running it | Fine for a demo; signing needs a paid certificate and a verified identity | A code-signing certificate (or Azure Trusted Signing), set up in electron-builder |
| No automatic updates: a new version means running a new installer | Releases are rare | electron-updater, with the installers published somewhere it can check |
| The installer makes CircuitLab the program for every `.net` file, and other tools use that extension too (KiCad writes netlists as `.net`) | CircuitLab's own files are `.net`; you can pick another program with "Open with" | Ask during installation, or use a more specific extension |
| Double-clicking a file opens it on macOS only through a different event (`open-file`), which isn't handled | Only Windows is packaged | Handle `app.on("open-file")` when adding the macOS build |
| Only Windows is packaged | It's the machine I have | `mac` and `linux` targets in electron-builder.yml, built on those systems |
