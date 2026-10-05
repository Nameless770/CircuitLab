import { assistantPanel } from "../assistant/panel";
import { appendAll, h } from "../dom";
import { navigate, setLeaveCheck, type PageContext } from "../router";
import { errorDetails, pageHeader, runAction, successBox } from "../ui";

/**
 * Edit a circuit as netlist text: one gate per line. Good for big circuits, and for pasting.
 * Like the drawing editor, the page that opens it says how to check and save.
 */
export interface NetlistEditorOptions {
  readonly title: string;
  readonly text: string;
  readonly saveLabel: string;
  readonly cancelPath: string;
  readonly note?: string;
  check(text: string): Promise<string>;
  save(text: string): Promise<string | null>;
}

/** What a new netlist starts with. */
export const NETLIST_TEMPLATE = `# One gate per line:  name = TYPE(inputs, in pin order)  "optional label"
.name "My circuit"

A = INPUT
B = INPUT

both = AND(A, B)

Y = OUTPUT(both)
`;

export function openNetlistEditor({ root, signal, query }: PageContext, options: NetlistEditorOptions): void {
  let dirty = false;
  const text = h("textarea", { class: "code", spellcheck: "false", wrap: "off", "aria-label": "Netlist" }, options.text);
  text.addEventListener("input", () => {
    dirty = true;
  });
  const messages = h("div");

  const checkButton = h("button", {}, "Check");
  checkButton.addEventListener("click", () => {
    void runAction(checkButton, messages, async () => {
      try {
        messages.replaceChildren(successBox(await options.check(text.value)));
      } catch (error) {
        jumpToFirstProblem(error);
        throw error;
      }
    });
  });

  const saveButton = h("button", { class: "primary" }, options.saveLabel);
  saveButton.addEventListener("click", () => {
    void runAction(saveButton, messages, async () => {
      try {
        const next = await options.save(text.value);
        if (next === null) return;
        dirty = false;
        navigate(next);
      } catch (error) {
        jumpToFirstProblem(error);
        throw error;
      }
    });
  });

  /** Puts the cursor on the first line the error mentions, so the mistake is easy to find. */
  function jumpToFirstProblem(error: unknown): void {
    const issue = errorDetails(error).issues.find((candidate) => candidate.line !== undefined);
    if (issue?.line === undefined) return;
    const lines = text.value.split("\n");
    let start = 0;
    for (let index = 0; index < issue.line - 1 && index < lines.length; index++) start += (lines[index]?.length ?? 0) + 1;
    const end = start + (lines[issue.line - 1]?.length ?? 0);
    text.focus();
    text.setSelectionRange(start, end);
    const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight) || 20;
    text.scrollTop = Math.max(0, (issue.line - 4) * lineHeight);
  }

  window.addEventListener(
    "keydown",
    (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveButton.click();
      }
    },
    { signal },
  );
  setLeaveCheck(() => !dirty || confirm("You have unsaved changes. Leave without saving them?"));
  window.addEventListener(
    "beforeunload",
    (event) => {
      if (dirty) event.preventDefault();
    },
    { signal },
  );

  // The assistant drafts a circuit and puts it here only when asked to; what's typed here stays unsaved until saved.
  const assistant = assistantPanel({
    currentText: () => text.value,
    replaceText: (next) => {
      text.value = next;
      dirty = true;
      messages.replaceChildren();
    },
    startsEmpty: options.text.trim() === "" || options.text.trim() === NETLIST_TEMPLATE.trim(),
    focus: query.get("ask") === "1",
  });

  appendAll(
    root,
    pageHeader(options.title, checkButton, saveButton, h("a", { class: "button", href: `#${options.cancelPath}` }, "Cancel")),
    options.note === undefined ? null : h("p", { class: "alert alert-info" }, options.note),
    messages,
    assistant,
    h("div", { class: "netlist-layout" }, text, cheatSheet()),
  );
  if (query.get("ask") !== "1") text.focus(); // with ?ask=1 the cursor is in the assistant's box
}

function cheatSheet(): HTMLElement {
  return h(
    "aside",
    { class: "card cheatsheet" },
    h("h3", {}, "Netlist cheat sheet"),
    h("pre", {}, `.name "Half adder"\n\nA = INPUT\nB = INPUT  "a label"\none = CONST(1)\n\nsum   = XOR(A, B)\ncarry = AND(A, B)\n\nS = OUTPUT(sum)\nC = OUTPUT(carry)`),
    h(
      "ul",
      { class: "help" },
      h("li", {}, "Gate types: INPUT, OUTPUT, CONST, BUF, NOT, AND, OR, NAND, NOR, XOR, XNOR."),
      h("li", {}, "AND, OR, NAND, NOR, XOR and XNOR take 2 to 64 inputs; NOT, BUF and OUTPUT take one."),
      h("li", {}, "A name can be used before the line that defines it."),
      h("li", {}, "Names: letters, digits and _ . $ [ ], not starting with a dot."),
      h("li", {}, "# starts a comment."),
    ),
  );
}
