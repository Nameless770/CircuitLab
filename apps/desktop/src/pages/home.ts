import type { Bit } from "@circuitlab/engine";
import { openAssistant } from "../assistant/drawer";
import { localBackend } from "../circuit/backend";
import { desktop } from "../desktop";
import { drawDiagram } from "../diagram/draw";
import { pinCounts } from "../diagram/geometry";
import { autoLayout } from "../diagram/layout";
import { formatDate, h, s } from "../dom";
import { EXAMPLES } from "../examples";
import { fileName, libraryItems, recentFiles } from "../offline/storage";
import type { PageContext } from "../router";
import { currentSession } from "../session";
import { on } from "../shell/bus";
import { goLibrary, goServer, goTo, newCircuit, openExampleCircuit, openLibraryCircuit, openNetlistFile, openRecentFile } from "../shell/commands";
import { openSignIn } from "../shell/sign-in";
import { serverLine, serverState } from "../shell/status";
import { errorMessage, kbd } from "../ui";
import { openExample } from "../workspace/store";
import { exampleCircuit, exampleThumb, lazyThumb } from "./thumbs";

/** The start screen: what you can do, a circuit at work, the examples, and what's yours. */
export function homePage({ root, signal }: PageContext): void {
  const isDesktop = desktop() !== null;
  const action = (label: string, key: string, description: string, run: () => void, enabled = true): HTMLElement => {
    const button = h("button", { type: "button", class: "action", disabled: !enabled }, h("span", { class: "action-title" }, label, kbd(key)), h("span", { class: "action-desc" }, description));
    button.addEventListener("click", run);
    return button;
  };

  root.append(
    h(
      "div",
      { class: "home" },
      h(
        "div",
        { class: "home-top" },
        h(
          "div",
          { class: "home-intro" },
          h("div", {}, h("h1", {}, "CircuitLab"), h("p", { class: "lead" }, "Build digital logic circuits, flip their inputs, and watch the signals flow.")),
          h(
            "div",
            { class: "action-grid" },
            action("New circuit", "Ctrl N", "Start drawing on an empty canvas.", () => newCircuit()),
            action("Open netlist file…", "Ctrl O", "A .net file on this computer.", () => void openNetlistFile(), isDesktop),
            action("Ask the assistant", "Ctrl J", "Describe a circuit in words and let a model running on this computer draft it.", () => openAssistant(), isDesktop),
            action("Library", "Ctrl L", "Circuits saved in the app on this computer.", goLibrary, isDesktop),
          ),
        ),
        isDesktop ? hero(signal) : null,
      ),
      isDesktop ? examples(signal) : null,
      h("div", { class: "panel-grid" }, isDesktop ? libraryPanel(signal) : null, isDesktop ? recentPanel() : null, onlinePanel(signal)),
    ),
  );
}

/** The half adder at work: its inputs go 00, 01, 10, 11 again and again, and the signals light up. */
function hero(signal: AbortSignal): HTMLElement {
  const example = EXAMPLES[0];
  const svg = s("svg", { class: "circuit-diagram", role: "img", "aria-label": "The half adder, working" });
  const readout = h("span", {}, "");
  const button = h(
    "button",
    { type: "button", class: "hero", title: "Open the half adder" },
    h("div", { class: "hero-diagram" }, svg),
    h("span", { class: "hero-tag" }, h("span", { class: "led small sig" }), "half-adder.net · live"),
    h("span", { class: "hero-foot" }, readout, h("span", {}, "Open ›")),
  );
  if (example === undefined) return button;
  const combinations: readonly (readonly [Bit, Bit])[] = [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ];
  let step = 0;

  void exampleCircuit(example).then(async (circuit) => {
    const model = { gates: circuit.gates, wires: circuit.wires, pins: pinCounts(circuit.gates, circuit.wires), positions: autoLayout(circuit.gates, circuit.wires) };
    const backend = localBackend({ name: circuit.name, gates: circuit.gates, wires: circuit.wires });
    // The four answers, computed once.
    const answers = await Promise.all(combinations.map(([a, b]) => backend.simulate({ inputs: { A: a, B: b }, mode: "combinational" }, signal)));
    const show = (): void => {
      const [a, b] = combinations[step] ?? [0, 0];
      const answer = answers[step];
      if (answer === undefined) return;
      drawDiagram(svg, model, { signals: answer.signals, fit: true, flow: true });
      readout.textContent = `A=${a} B=${b}  →  S=${answer.outputs["S"] ?? "?"} C=${answer.outputs["C"] ?? "?"}`;
    };
    show();
    const timer = setInterval(() => {
      step = (step + 1) % combinations.length;
      show();
    }, 1500);
    signal.addEventListener("abort", () => clearInterval(timer), { once: true });
    button.addEventListener("click", () => {
      const [a, b] = combinations[step] ?? [0, 0];
      void openExample(example).then((doc) => {
        if (doc === null) return;
        doc.inputs = { A: a, B: b };
        goTo("/workspace");
      });
    });
  }, () => {});
  return button;
}

function examples(signal: AbortSignal): HTMLElement {
  return h(
    "section",
    {},
    h("div", { class: "section-head" }, h("h2", {}, "Try an example"), h("span", { class: "muted" }, "Opens offline. No account or server needed.")),
    h(
      "div",
      { class: "card-grid examples" },
      EXAMPLES.map((example) => {
        const thumb = h("div", { class: "thumb" });
        const title = h("span", { class: "ccard-title" }, h("span", {}, example.name)); // + "remembers state" once read
        const card = h("button", { type: "button", class: "ccard" }, thumb, h("div", { class: "ccard-body" }, title, h("span", { class: "ccard-desc" }, example.description)));
        card.addEventListener("click", () => void openExampleCircuit(example));
        lazyThumb(thumb, () => exampleThumb(example), signal);
        void exampleCircuit(example).then((circuit) => {
          if (circuit.summary.feedbackLoop !== null) title.append(h("span", { class: "badge sig" }, "remembers state"));
        }, () => {});
        return card;
      }),
    ),
  );
}

const PREVIEW_SIZE = 5;

function libraryPanel(signal: AbortSignal): HTMLElement {
  const seeAll = h("button", { type: "button", class: "link-btn" }, "See all ›");
  seeAll.addEventListener("click", goLibrary);
  const rows = h("div", { class: "rows" }, h("p", { class: "loading" }, "Loading…"));
  const panel = h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h3", {}, "Your library"), seeAll), rows);

  const fill = (): void => {
    void libraryItems().then(
      (items) => {
        if (signal.aborted) return;
        seeAll.textContent = `See all ${items.length} ›`;
        if (items.length === 0) {
          rows.replaceChildren(h("p", {}, "Circuits you save appear here."));
          return;
        }
        rows.replaceChildren(
          ...items.slice(0, PREVIEW_SIZE).map((item) => {
            const row = h("button", { type: "button", class: "row-link" }, h("span", {}, item.name), h("span", { class: "meta" }, `saved ${formatDate(item.updatedAt)}`));
            row.addEventListener("click", () => void openLibraryCircuit(item.id));
            return row;
          }),
        );
      },
      (error: unknown) => rows.replaceChildren(h("p", {}, errorMessage(error))),
    );
  };
  on("library", fill, signal);
  fill();
  return panel;
}

function recentPanel(): HTMLElement {
  const open = h("button", { type: "button", class: "link-btn" }, "Open netlist file…");
  open.addEventListener("click", () => void openNetlistFile());
  const files = recentFiles();
  return h(
    "section",
    { class: "panel" },
    h("div", { class: "panel-head" }, h("h3", {}, "Recent files"), open),
    files.length === 0
      ? h("p", {}, "Netlist files you open appear here.")
      : files.slice(0, PREVIEW_SIZE).map((path) => {
          const row = h("button", { type: "button", class: "row-link stacked", title: path }, h("span", {}, fileName(path)), h("span", { class: "meta" }, path));
          row.addEventListener("click", () => void openRecentFile(path));
          return row;
        }),
  );
}

function onlinePanel(signal: AbortSignal): HTMLElement {
  const line = h("div", { class: "status-line" });
  const buttons = h("div", { class: "buttons" });
  const draw = (): void => {
    const session = currentSession();
    const state = serverState();
    const status = serverLine(state);
    const text = state.kind !== "online" ? status.text : session !== null ? `Signed in as ${session.user.displayName}` : "Server online · not signed in";
    line.replaceChildren(h("span", { class: `led ${status.tone}` }), h("span", { title: "url" in state ? state.url : "" }, text));
    const button = (label: string, run: () => void): HTMLElement => {
      const element = h("button", { type: "button", class: "btn" }, label);
      element.addEventListener("click", run);
      return element;
    };
    buttons.replaceChildren(
      session === null ? button("Sign in", () => openSignIn("in")) : button("My circuits", () => goServer("owned")),
      button("Browse public circuits", () => goServer("public")),
    );
  };
  on("status", draw, signal);
  draw();
  return h(
    "section",
    { class: "panel" },
    h("h3", {}, "Online"),
    h("p", {}, "Your circuits on the CircuitLab server: saved in your account, shareable with other people, with truth tables computed by the server."),
    line,
    buttons,
  );
}
