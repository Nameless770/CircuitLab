// The fonts of the design, inside the app so they work offline (latin and others, loaded as needed).
import "@fontsource-variable/manrope";
import "@fontsource-variable/geist-mono/wght.css";
import "./styles.css";
import { openAssistant } from "./assistant/drawer";
import { desktop } from "./desktop";
import { h } from "./dom";
import { homePage } from "./pages/home";
import { libraryPage, serverListPage } from "./pages/lists";
import { settingsPage } from "./pages/settings-page";
import { navigate, route, setNotFoundPage, startRouter, type PageContext } from "./router";
import { goHome, goLibrary, goSettings, goTo, newCircuit, openNetlistFile, sidebarHidden } from "./shell/commands";
import { startKeys } from "./shell/keys";
import { startSidebar } from "./shell/sidebar";
import { openSignIn, type SignInTab } from "./shell/sign-in";
import { startStatusChecks } from "./shell/status";
import { applyAppearance } from "./shell/theme";
import { startTitleBar } from "./shell/titlebar";
import { startToasts, toast } from "./shell/toast";
import { errorMessage } from "./ui";
import { enter, workspacePage } from "./workspace/page";
import { currentDoc, openBlank, openFileDoc, openLibraryDoc, openServerDoc, restoreDoc } from "./workspace/store";

// The look first, before anything is drawn.
applyAppearance();

// Every screen of the app, by address. More specific paths come first.
route("/", homePage);
route("/settings", settingsPage);
route("/library", libraryPage);
route("/circuits", serverListPage);
route("/workspace", workspacePage);

// Addresses that open a circuit, then show it in the workspace (#/workspace).
route("/library/:id", enter(({ params }) => openLibraryDoc(params["id"] ?? "")));
route("/local", enter(() => currentDoc() ?? restoreDoc()));
route("/local/draw", enter(() => currentDoc() ?? restoreDoc(), "draw"));
route("/local/netlist", enter(() => currentDoc() ?? restoreDoc(), "net"));
route("/local/new", enter(() => openBlank()));
route("/local/new/netlist", enter(blankNetlist(false), "net"));
route("/circuits/new", enter(() => openBlank(true)));
route("/circuits/new/draw", enter(() => openBlank(true)));
route("/circuits/new/netlist", enter(blankNetlist(true), "net"));
route("/circuits/:id", enter(({ params, signal }) => openServerDoc(params["id"] ?? "", signal)));
route("/circuits/:id/edit", enter(({ params, signal }) => openServerDoc(params["id"] ?? "", signal), "draw"));
route("/circuits/:id/netlist", enter(({ params, signal }) => openServerDoc(params["id"] ?? "", signal), "net"));

// Signing in is a dialog; these addresses open it over the home screen (then go on to `?next=`).
route("/login", signInPageFor("in"));
route("/register", signInPageFor("up"));

setNotFoundPage(({ root }) => {
  const home = h("button", { type: "button", class: "btn lg" }, "Back to the home screen");
  home.addEventListener("click", goHome);
  root.append(h("div", { class: "page-inner" }, h("div", { class: "empty-box" }, h("h2", {}, "Nothing here"), home)));
});

/** A new circuit in the netlist editor; `?ask=1` opens the assistant beside it. */
function blankNetlist(forServer: boolean) {
  return ({ query }: PageContext) => {
    const doc = openBlank(forServer);
    if (query.get("ask") === "1") setTimeout(() => openAssistant("new"), 0);
    return doc;
  };
}

function signInPageFor(tab: SignInTab) {
  return (context: PageContext): void => {
    homePage(context);
    const next = context.query.get("next");
    // Only paths inside the app, never something like "//evil.example".
    const safe = next !== null && next.startsWith("/") && !next.startsWith("//") ? next : null;
    openSignIn(tab, () => navigate(safe ?? "/circuits?scope=owned"));
  };
}

/** A .net file double-clicked in Explorer (or the one the app was started with). */
function openDoubleClickedFile(path: string): void {
  openFileDoc(path).then(
    (doc) => {
      if (doc !== null) goTo("/workspace");
    },
    (error: unknown) => toast(errorMessage(error), { error: true }),
  );
}

const bridge = desktop();
if (bridge !== null) {
  // The app menu (electron/main.ts) sends its commands here.
  bridge.onMenuCommand((command) => {
    if (command === "home") goHome();
    if (command === "new") newCircuit();
    if (command === "library") goLibrary();
    if (command === "settings") goSettings();
    if (command === "open") void openNetlistFile();
  });
  // A file double-clicked while the app is open, and the one it was started with, if any.
  bridge.onOpenFile(openDoubleClickedFile);
  void bridge.takeStartupFile().then((path) => {
    if (path !== null) openDoubleClickedFile(path);
  });
}

document.getElementById("frame")?.classList.toggle("no-sidebar", sidebarHidden());
startToasts(document.getElementById("toasts") as HTMLElement);
startTitleBar(document.getElementById("titlebar") as HTMLElement);
startSidebar(document.getElementById("sidebar") as HTMLElement);
startKeys();
startStatusChecks();
startRouter(document.getElementById("view") as HTMLElement);
