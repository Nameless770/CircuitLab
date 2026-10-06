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
change its address in **Settings** (Ctrl+, or the gear at the bottom of the sidebar).

## How it fits together

```
┌──────────────── the app's window ────────────────┐
│ apps/desktop/src: plain TypeScript, built by Vite │
│ the shell, the pages, the workspace, the diagram  │
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
and `localBackend()` calls the main process. It's the same idea as phase 9's simulation
strategies: one interface, interchangeable implementations.

`backendFor(circuit)` picks one: the server for a circuit on the server with no unsaved changes
(the server only knows the saved version), and this computer for everything else, including a
server circuit you are in the middle of editing. The inspector says which one answered
("Simulated by the server.", "Simulated on this computer.").

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
After a simulation, a wire is lit in the signal colour (amber unless you choose another in
Settings) when it carries a 1.

### 8. The editor

- **The rules are plain functions on plain data,** in
  [draft.ts](../apps/desktop/src/editor/draft.ts): add, connect, rename, change the number of
  inputs. Each change is checked there; for example, a new wire on an input pin replaces the old
  one. That makes them easy to unit test without a window.
- **The mouse handling** lives in [canvas.ts](../apps/desktop/src/workspace/canvas.ts): it
  turns clicks and drags into those calls. It also zooms (+, −, Fit), and keeps fitting the circuit
  to the window until you pick a zoom yourself.
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
- **Save needs no dialog.** "Save to library" stores the circuit at once. The Library page
  (Ctrl+L) shows everything as cards with a picture, newest first, with a search and a filter
  (combinational or "remembers state"); the home screen lists the latest five.
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

**Files still work, when you ask for them.** "Export .net" writes a `.net` copy; "Import netlist
file…" on the Library page copies a file in. A file opened directly (Ctrl+O, or a double-click)
still saves back to that file, and its More menu has "Save a copy to the library". Online circuits
have that too, which keeps a copy that works without the server.

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
- **Testing the result.** `npm run smoke:packaged -w @circuitlab/desktop` runs the same 23-step
  smoke test against `release/win-unpacked/CircuitLab.exe`, which holds exactly the files the
  installer installs.

**It isn't code-signed,** so the first time you run the installer Windows shows "Windows
protected your PC". Click "More info", then "Run anyway". Signing needs a code-signing
certificate, which costs money and needs a verified identity; see the known shortcuts below.

### 11. The assistant

A panel that drafts circuits with a model running in Ollama (Ctrl+J, or the card at the bottom of
the sidebar). How it works, and how good it is, is in [assistant.md](assistant.md). What belongs
here is how it sits in the app:

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
- **Two places for one panel** ([drawer.ts](../apps/desktop/src/assistant/drawer.ts)):
  - **In the workspace it sits beside the circuit,** in the right-hand column: an "Assistant" tab
    next to "Details". You can keep drawing, simulating or editing the netlist while you ask, and
    a draft you use goes into the circuit without leaving the mode you're in. The panel stays open
    for the next question. The column remembers its tab, so the assistant is still there when you
    come back to the workspace.
  - **On any other screen it slides in over the screen,** and closes when you use a draft (the
    workspace then shows it, simulated) or press Esc.
  - **How:** the panel is one element, made once and kept, so what you typed and the last draft
    survive. While the workspace is on screen it offers its column (`offerAssistantDock`), and the
    panel moves in there; otherwise it goes in the overlay layer. A panel already open over the
    screen moves into the column when you go to the workspace.
- **Two things to ask for:**
  - **"A new circuit":** the answer opens in the workspace, not saved yet. If the open circuit is a
    new, empty one, the answer goes into it instead, so Save still puts it where that circuit was
    going (your account, for a "New circuit" started from My circuits).
  - **"Change the open circuit"** (the choice it starts on beside a circuit): the model is shown
    the open circuit and answers with the whole changed circuit, which replaces it, unsaved.
- **Undo** (in the panel beside the circuit, or in the message at the bottom otherwise) brings back
  the circuit as it was before the change. It only works while the circuit is still as the
  assistant left it: after an edit of your own it refuses and says why, instead of throwing your
  edit away too. It compares a fingerprint of the circuit (gates, wires, pins, name, description,
  netlist text being typed); moving gates doesn't count. If you saved the change in between, Undo
  still works and the circuit becomes unsaved again.

### 12. The redesign: one window, one open circuit

In October 2026 the window was redesigned from a design handoff (`CircuitLab Desktop.dc.html`,
made in Claude Design). It changed how the app is laid out, not what it can do: every screen from
before is still there, restyled.

```
┌ title bar: logo / where you are · search (Ctrl K) · theme · Windows' buttons ┐
├ sidebar ──────────┬ the screen you're on ────────────────────────────────────┤
│ New circuit       │ Home, Library, the server's lists, Settings, or the       │
│ This computer     │ workspace:                                                │
│  Home, Library,   │ ┌ name, badge · Simulate|Draw|Netlist · Save · More ▾ ┐   │
│  the open circuit │ │ the drawing, or the netlist text │ Details|Assistant│   │
│ Server            │ │ the truth table (a drawer, T)    │ (inputs, outputs,│   │
│ assistant card    │ │                                  │  sharing, ... or │   │
│ status · account  │ │                                  │  the assistant)  │   │
│                   │ └──────────────────────────────────┴──────────────────┘   │
└───────────────────┴───────────────────────────────────────────────────────────┘
```

**One open circuit, three modes.** Before, every job had its own page: a circuit's page, a
drawing editor and a netlist editor, each in an online and an offline version (nine page files
doing overlapping things). Now there is one workspace
([page.ts](../apps/desktop/src/workspace/page.ts)), and the circuit you have open
([store.ts](../apps/desktop/src/workspace/store.ts)) stays open while you move around the app.
- **Simulate, Draw and Netlist are three views of it** (Ctrl+1, 2, 3), so switching keeps your
  unsaved changes. The sidebar and the title bar show a dot while there are some.
- **Where it came from decides what Save does:** the library, a file, the server, or nowhere yet
  ("Save to library", or "Save" for a file, or for your account). The More menu offers the rest
  (export, copy to the library, upload, delete, ask the assistant).
- **It survives a reload** (it's kept in `sessionStorage`), and closing the window with unsaved
  changes asks first. An example or a blank circuit only counts as unsaved once you change it.
- **Why:** fewer screens to keep in step, and switching between drawing and simulating no longer
  means saving first.

**The title bar is ours, its buttons are Windows'.**
- `titleBarStyle: "hidden"` removes Windows' title bar, so the page draws its own: where you are,
  the search box, the theme switch. `-webkit-app-region: drag` makes it move the window.
- `titleBarOverlay` keeps Windows' own minimize, maximize and close buttons on top of it, painted
  in our colours. The mock-up draws those three buttons itself; real ones keep snap layouts (hover
  over maximize), touch, and screen readers working for free. CSS `env(titlebar-area-width)` tells
  the page how much room they take.
- **Changing the theme repaints them:** the window asks the main process (`setWindowTheme` in the
  bridge), which also remembers the theme in `settings.json`. The next window then opens in the
  right colours instead of flashing dark first.
- **No menu bar shows on Windows** any more. Everything that was in it is in the command palette
  and on a shortcut; the menu itself stays for macOS.

**Two themes, three signal colours.** Every colour is a CSS variable (`--bg`, `--panel`,
`--sig`, ...) in [styles.css](../apps/desktop/src/styles.css), chosen by two attributes on
`<html>`: `data-theme` (dark or light) and `data-signal` (amber, green or cyan, the colour of a
1). Switching changes those attributes, nothing else. The choice is kept in `localStorage`. The
frame's colours in [helpers.ts](../apps/desktop/electron/helpers.ts) must match the stylesheet's,
so a unit test reads `styles.css` and compares them.

**The fonts come with the app:** Manrope and Geist Mono, from npm (`@fontsource-variable/...`),
bundled by Vite (about 140 KB). Loading them from Google Fonts would break offline mode, and the
Content-Security-Policy would have to allow another website.

**Keyboard first.** Ctrl+K opens a command palette: go anywhere, run any command, open an example,
a recent file or a library circuit by typing part of its name. `?` lists every shortcut:

| Keys | What they do |
| --- | --- |
| Ctrl+K | The command palette |
| Ctrl+N, Ctrl+O | A new circuit; open a netlist file |
| Ctrl+J | The assistant (in the workspace: its tab in the right-hand column) |
| Ctrl+H, Ctrl+L, Ctrl+, | Home, the library, Settings |
| Ctrl+B | Hide or show the sidebar |
| Ctrl+S | Save the open circuit |
| Ctrl+1, 2, 3 | Simulate, Draw, Netlist |
| 1 to 9 | Flip input 1 to 9 (Simulate) |
| R | Reset what a latch remembers (Simulate) |
| T | Open or close the truth table |
| F, +, − | Fit the drawing to the window; zoom in and out |
| A, Delete | Arrange the gates; delete the selection (Draw) |
| Esc | Close a dialog, or the assistant when it's over the screen; leave the assistant's text box; clear the selection |

**Pictures everywhere.** The home screen runs a half adder through its four input combinations,
and every card in the lists shows a small drawing of its circuit, lit by a local simulation
([thumbs.ts](../apps/desktop/src/pages/thumbs.ts)). They are drawn only when they scroll into
view, and not at all for circuits over 150 gates.

**Where the code is now:**
- `src/shell/`: the title bar, the sidebar, the command palette, dialogs, messages ("toasts"),
  shortcuts, the theme, the server and Ollama status checks;
- `src/workspace/`: the open circuit (store), the workspace page, the drawing (canvas), the
  netlist text, the inspector, the truth table, the server's panels;
- `src/pages/`: home, the lists of circuits, Settings;
- `src/assistant/drawer.ts`: the assistant's panel.

## Testing

- **Unit tests** (`apps/desktop/test`, run by `npm test`): the layout, the editing rules, offline
  simulation, CSV export, a test that the window's copy of the pin counts still matches the
  engine's, and the assistant's part (which model is chosen, what the window is shown, settings that
  are read back). The window has small copies of two things the engine and the netlist package
  do (finding a feedback loop, writing a netlist), because it can't run Node code; tests check
  them against the real ones on the example circuits.
- **The smoke test** ([smoke.mjs](../apps/desktop/scripts/smoke.mjs)) checks that the screens
  and pieces fit together:
  - **Setup.** It starts an API in memory and opens the *built* app with Playwright.
  - **Steps.** It clicks through both modes in 23 steps, and saves a screenshot of most:
    - starting with a `.net` file, and a second launch handing one over (saving a drawing over it
      asks first, because the file's comments will go);
    - setting the server address in Settings, and switching to the light theme (and that it's saved);
    - examples: input switches, the 1 to 9 keys, a truth-table row that sets the inputs, a latch;
    - drawing a circuit, Check, saving with no dialog, exporting a file;
    - the library: listing, searching, opening, the command palette, deleting;
    - a mistake in the netlist text, found and shown on its line;
    - an account, sharing, making a circuit public, a background job, editing a server circuit,
      uploading, the server's cache;
    - the assistant, against a fake Ollama: choosing a model in Settings, drafting a circuit (into the
      library, and into a new circuit for the account), changing the open circuit from the panel
      beside the drawing (still in Draw mode afterwards, the tab remembered, Undo, and Undo refusing
      after an edit of your own), Cancel, a refusal, Ollama not running.
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
| Save shows on every server circuit, even for someone who may only look | The API doesn't say whether you're a viewer or an editor; a viewer who tries to save gets a clear 403 | Add your role to the circuit response |
| Two app windows refreshing tokens at the same instant could end the session | It needs two windows and an expiring token at the same moment | Let the main process own the tokens, so there's one refresher |
| Offline simulation runs in the main process, so a huge page of rows could freeze the app briefly | A page is at most 4,096 rows; normal circuits take milliseconds | Run it on `@circuitlab/runner`'s worker threads, like the API |
| Draw mode has no undo (only the assistant's change can be undone), and stops drawing at 400 gates | Big circuits can be edited as netlist text | An undo stack of drafts; draw only the part of a big circuit that is on screen |
| Saving a drawing to a file rewrites it, losing comments | The app asks before it does; Netlist mode keeps the text exactly | Keep comments by editing the text instead of rewriting it |
| Gates you drag are remembered at once, even if you then close the circuit without saving | Positions only change how it looks, never what it does | Keep moved positions with the unsaved changes |
| The window's code has its own small copies of the loop finder and the netlist writer | The window can't run the engine's Node code; unit tests check the copies against the real ones | Build those parts of the engine for the browser too |
| No menu bar on Windows (the title bar is drawn by the page) | Every menu command is in the command palette (Ctrl+K) and on a shortcut | Draw a menu button in the title bar |
| The workspace's right-hand column shows the details or the assistant, not both | One column keeps the drawing wide; a click (or Ctrl+J) switches, and each keeps its state | Both at once, one above the other, or a column you can drag wider |
| The installer isn't code-signed, so Windows SmartScreen warns before running it | Fine for a demo; signing needs a paid certificate and a verified identity | A code-signing certificate (or Azure Trusted Signing), set up in electron-builder |
| No automatic updates: a new version means running a new installer | Releases are rare | electron-updater, with the installers published somewhere it can check |
| The installer makes CircuitLab the program for every `.net` file, and other tools use that extension too (KiCad writes netlists as `.net`) | CircuitLab's own files are `.net`; you can pick another program with "Open with" | Ask during installation, or use a more specific extension |
| Double-clicking a file opens it on macOS only through a different event (`open-file`), which isn't handled | Only Windows is packaged | Handle `app.on("open-file")` when adding the macOS build |
| Only Windows is packaged | It's the machine I have | `mac` and `linux` targets in electron-builder.yml, built on those systems |
