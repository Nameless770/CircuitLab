import "./styles.css";
import { desktop } from "./desktop";
import { h } from "./dom";
import { startHeader } from "./header";
import { openPath, openWithDialog } from "./offline/document";
import { registerPage, signInPage } from "./pages/account";
import { circuitListPage } from "./pages/circuit-list";
import { circuitPage } from "./pages/circuit-page";
import {
  editDrawingPage,
  editLocalDrawingPage,
  editLocalNetlistPage,
  editNetlistPage,
  newDrawingPage,
  newLocalDrawingPage,
  newNetlistPage,
} from "./pages/edit-pages";
import { homePage } from "./pages/home";
import { localPage } from "./pages/local-page";
import { newCircuitPage } from "./pages/new-circuit";
import { settingsPage } from "./pages/settings-page";
import { currentPath, navigate, reload, route, setNotFoundPage, startRouter } from "./router";
import { errorMessage } from "./ui";

// Every screen of the app, by address. More specific paths come first.
route("/", homePage);
route("/login", signInPage);
route("/register", registerPage);
route("/settings", settingsPage);

// Online: circuits in your account on the server.
route("/circuits", circuitListPage);
route("/circuits/new", newCircuitPage);
route("/circuits/new/draw", newDrawingPage);
route("/circuits/new/netlist", newNetlistPage);
route("/circuits/:id", circuitPage);
route("/circuits/:id/edit", editDrawingPage);
route("/circuits/:id/netlist", editNetlistPage);

// Offline: the netlist file open on this computer.
route("/local", localPage);
route("/local/new", newLocalDrawingPage);
route("/local/draw", editLocalDrawingPage);
route("/local/netlist", editLocalNetlistPage);

setNotFoundPage(({ root }) => {
  root.append(h("div", { class: "card empty-state" }, h("h1", {}, "Nothing here"), h("p", {}, h("a", { href: "#/" }, "Back to the home screen"))));
});

/** Shows the open netlist file: refreshes the file page if it's showing, otherwise goes there. */
function showOpenFile(): void {
  if (currentPath() === "/local") reload();
  else navigate("/local");
}

/** Opens a .net file double-clicked in Explorer. */
function openDoubleClickedFile(path: string): void {
  openPath(path).then(showOpenFile, (error: unknown) => alert(errorMessage(error)));
}

const bridge = desktop();
if (bridge !== null) {
  // The File menu (electron/main.ts) sends its commands here.
  bridge.onMenuCommand((command) => {
    if (command === "home") navigate("/");
    if (command === "new") navigate("/local/new");
    if (command === "settings") navigate("/settings");
    if (command === "open") {
      openWithDialog().then(
        (opened) => {
          if (opened) showOpenFile();
        },
        (error: unknown) => alert(errorMessage(error)),
      );
    }
  });
  // A file double-clicked while the app is open, and the one it was started with, if any.
  bridge.onOpenFile(openDoubleClickedFile);
  void bridge.takeStartupFile().then((path) => {
    if (path !== null) openDoubleClickedFile(path);
  });
}

startHeader(document.getElementById("header") as HTMLElement);
startRouter(document.getElementById("app") as HTMLElement);
