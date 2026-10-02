import "./styles.css";
import { desktop } from "./desktop";
import { h } from "./dom";
import { startHeader } from "./header";
import { openWithDialog } from "./offline/document";
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
import { currentPath, navigate, reload, route, setNotFoundPage, startRouter } from "./router";
import { errorMessage } from "./ui";

// Every screen of the app, by address. More specific paths come first.
route("/", homePage);
route("/login", signInPage);
route("/register", registerPage);

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

// The File menu (electron/main.ts) sends its commands here.
desktop()?.onMenuCommand((command) => {
  if (command === "home") navigate("/");
  if (command === "new") navigate("/local/new");
  if (command === "open") {
    openWithDialog().then(
      (opened) => {
        if (!opened) return;
        // Already on the file page? Show the new file there; otherwise go to it.
        if (currentPath() === "/local") reload();
        else navigate("/local");
      },
      (error: unknown) => alert(errorMessage(error)),
    );
  }
});

startHeader(document.getElementById("header") as HTMLElement);
startRouter(document.getElementById("app") as HTMLElement);
