import { createCircuitFromNetlist } from "../api";
import { h } from "../dom";
import { EXAMPLES } from "../examples";
import { navigate, type PageContext } from "../router";
import { pageHeader, runAction } from "../ui";
import { requireSignIn } from "./account";

/** Most bytes read from an uploaded netlist: the API's own body limit. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** `#/circuits/new`: the ways to start a circuit in your account. */
export function newCircuitPage({ root }: PageContext): void {
  if (!requireSignIn(root)) return;
  const message = h("div");

  const upload = h("input", { type: "file", accept: ".net,.txt,text/plain" });
  upload.addEventListener("change", () => {
    const file = upload.files?.[0];
    if (file === undefined) return;
    void runAction(uploadButton, message, async () => {
      if (file.size > MAX_UPLOAD_BYTES) throw new Error("That file is over 5 MB, the most the server takes.");
      await createAndOpen(await file.text());
    });
    upload.value = ""; // so choosing the same file again fires "change" again
  });
  const uploadButton = h("button", {}, "Choose a file…");
  uploadButton.addEventListener("click", () => upload.click());

  const exampleButtons = EXAMPLES.map((example) => {
    const button = h("button", { title: example.description }, example.name);
    button.addEventListener("click", () => {
      void runAction(button, message, () => createAndOpen(example.netlist));
    });
    return button;
  });

  root.append(
    pageHeader("New circuit"),
    message,
    h(
      "div",
      { class: "mode-grid" },
      h("section", { class: "card mode-card" }, h("h2", {}, "Draw it"), h("p", {}, "Place gates and connect them with the mouse."), h("div", { class: "button-row" }, h("a", { class: "button primary", href: "#/circuits/new/draw" }, "Open the editor"))),
      h("section", { class: "card mode-card" }, h("h2", {}, "Write a netlist"), h("p", {}, "Type the circuit as text, one gate per line."), h("div", { class: "button-row" }, h("a", { class: "button", href: "#/circuits/new/netlist" }, "Open the netlist editor"))),
      h("section", { class: "card mode-card" }, h("h2", {}, "Upload a netlist file"), h("p", {}, "A .net file from your computer, like the ones in examples/netlists."), h("div", { class: "button-row" }, uploadButton, upload)),
      h("section", { class: "card mode-card" }, h("h2", {}, "Start from an example"), h("p", {}, "Adds a copy of an example to your account."), h("div", { class: "button-row" }, exampleButtons)),
    ),
  );
  upload.hidden = true;
}

async function createAndOpen(netlist: string): Promise<void> {
  const created = await createCircuitFromNetlist(netlist);
  navigate(`/circuits/${encodeURIComponent(created.circuit.id)}`);
}
