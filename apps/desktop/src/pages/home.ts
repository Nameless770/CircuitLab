import { desktop, requireDesktop, unwrap } from "../desktop";
import { h } from "../dom";
import { EXAMPLES } from "../examples";
import { fileName, forgetRecent, openPath, openWithDialog, recentFiles, setDocument } from "../offline/document";
import { serverStatusLine } from "../online/server-status";
import { navigate, type PageContext } from "../router";
import { currentSession } from "../session";
import { errorBox, runAction } from "../ui";

/** The start screen: the two ways to use the app, side by side. */
export function homePage({ root, signal }: PageContext): void {
  root.append(
    h(
      "section",
      { class: "hero" },
      h("h1", {}, "CircuitLab"),
      h("p", { class: "lead" }, "Build digital logic circuits, flip their inputs, and watch the signals flow."),
    ),
    h("div", { class: "mode-grid" }, onlineCard(signal), offlineCard()),
  );
}

function onlineCard(signal: AbortSignal): HTMLElement {
  const session = currentSession();

  const actions =
    session === null
      ? [
          h("a", { class: "button primary", href: "#/login" }, "Sign in"),
          h("a", { class: "button", href: "#/register" }, "Create an account"),
          h("a", { class: "button", href: "#/circuits?scope=public" }, "Browse public circuits"),
        ]
      : [
          h("a", { class: "button primary", href: "#/circuits?scope=owned" }, "My circuits"),
          h("a", { class: "button", href: "#/circuits?scope=shared" }, "Shared with me"),
          h("a", { class: "button", href: "#/circuits/new" }, "New circuit"),
        ];

  return h(
    "section",
    { class: "card mode-card" },
    h("h2", {}, "Online"),
    h("p", {}, "Your circuits on the CircuitLab server: saved in your account, shareable with other people, with truth tables computed by the server."),
    session === null ? null : h("p", {}, "Signed in as ", h("strong", {}, session.user.displayName), "."),
    serverStatusLine(signal),
    h("div", { class: "button-row" }, actions),
  );
}

function offlineCard(): HTMLElement {
  const message = h("div");
  const isDesktop = desktop() !== null;

  const openButton = h("button", { class: "primary", disabled: !isDesktop }, "Open netlist file…");
  openButton.addEventListener("click", () => {
    void runAction(openButton, message, async () => {
      if (await openWithDialog()) navigate("/local");
    });
  });

  const exampleButtons = EXAMPLES.map((example) => {
    const button = h("button", { class: "link-button", title: example.description, disabled: !isDesktop }, example.name);
    button.addEventListener("click", () => {
      void runAction(button, message, async () => {
        const circuit = unwrap(await requireDesktop().parse(example.netlist));
        setDocument({ path: null, text: example.netlist, circuit });
        navigate("/local");
      });
    });
    return button;
  });

  const recent = recentFiles();
  const recentList =
    recent.length === 0
      ? null
      : h(
          "div",
          { class: "recent" },
          h("h3", {}, "Recent files"),
          h(
            "ul",
            { class: "plain-list" },
            recent.map((path) => {
              const button = h("button", { class: "link-button", title: path, disabled: !isDesktop }, fileName(path));
              button.addEventListener("click", () => {
                void openRecent(path, button, message);
              });
              return h("li", {}, button, h("span", { class: "muted small path" }, path));
            }),
          ),
        );

  return h(
    "section",
    { class: "card mode-card" },
    h("h2", {}, "Offline"),
    h("p", {}, "Netlist files (.net) on this computer, simulated right here. No account or server needed."),
    isDesktop ? null : h("p", { class: "alert alert-warning" }, "Offline mode needs the desktop app. You're seeing this page in a browser tab."),
    h("div", { class: "button-row" }, openButton, h("a", { class: "button", href: "#/local/new", "aria-disabled": !isDesktop }, "New circuit")),
    h("div", { class: "examples" }, h("span", { class: "muted" }, "Try an example: "), exampleButtons),
    message,
    recentList,
  );
}

async function openRecent(path: string, button: HTMLButtonElement, message: HTMLElement): Promise<void> {
  button.disabled = true;
  try {
    await openPath(path);
    navigate("/local");
  } catch (error) {
    // Moved or deleted since: say so, and drop it from the list.
    forgetRecent(path);
    message.replaceChildren(errorBox(error));
  } finally {
    button.disabled = false;
  }
}
