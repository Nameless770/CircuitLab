import { register, signIn } from "../api";
import { h } from "../dom";
import { currentSession } from "../session";
import { errorMessage, field } from "../ui";
import { showOverlay } from "./overlay";
import { toast } from "./toast";

/**
 * Signing in, or creating an account, on the CircuitLab server: a dialog over whatever you were
 * looking at, so you carry on from there afterwards. Accounts are only for online mode; offline
 * work needs none.
 */
export type SignInTab = "in" | "up";

export function openSignIn(tab: SignInTab = "in", after?: () => void): void {
  let current: SignInTab = tab;
  const name = h("input", { type: "text", class: "input lg", maxlength: 100, autocomplete: "nickname" });
  const email = h("input", { type: "email", class: "input lg", maxlength: 254, autocomplete: "username" });
  const password = h("input", { type: "password", class: "input lg", maxlength: 256 });
  const message = h("div");
  const submit = h("button", { type: "submit", class: "btn xl primary" });
  const tabs = h("div", { class: "seg fill", role: "group", "aria-label": "Sign in or create an account" });
  const intro = h("p", {}, "Sign in to your account on the CircuitLab server to see your circuits and the ones shared with you.");
  const nameField = field("Your name", name, "Shown to people you share circuits with.");
  const passwordHint = h("span", { class: "field-hint" }, "At least 15 characters. A few random words work well, e.g. “purple kettle river stone”.");
  const form = h("form", { class: "modal" }, tabs, intro, nameField, field("Email", email), h("label", { class: "field" }, h("span", { class: "field-label" }, "Password"), password, passwordHint), message, submit);

  function show(): void {
    tabs.replaceChildren(
      ...(
        [
          ["in", "Sign in"],
          ["up", "Create an account"],
        ] as const
      ).map(([value, label]) => {
        const button = h("button", { type: "button", "aria-pressed": current === value ? "true" : "false" }, label);
        button.addEventListener("click", () => {
          current = value;
          message.replaceChildren();
          show();
        });
        return button;
      }),
    );
    const up = current === "up";
    intro.hidden = up;
    nameField.hidden = !up;
    passwordHint.hidden = !up;
    password.autocomplete = up ? "new-password" : "current-password";
    submit.textContent = up ? "Create account" : "Sign in";
  }

  let busy = false;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;
    const problem =
      current === "up" && name.value.trim() === ""
        ? "Enter your name."
        : !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim())
          ? "Enter a valid email address."
          : password.value === ""
            ? "Enter your password."
            : current === "up" && password.value.length < 15
              ? "The password needs at least 15 characters."
              : null;
    if (problem !== null) {
      message.replaceChildren(h("div", { class: "alert error", role: "alert" }, problem));
      return;
    }
    busy = true;
    submit.disabled = true;
    submit.textContent = current === "up" ? "Creating account…" : "Signing in…";
    message.replaceChildren();
    const work = current === "up" ? register({ displayName: name.value.trim(), email: email.value.trim(), password: password.value }) : signIn({ email: email.value.trim(), password: password.value });
    void work.then(
      () => {
        close();
        toast(`Signed in as ${currentSession()?.user.displayName ?? email.value.trim()}.`);
        after?.();
      },
      (error: unknown) => {
        busy = false;
        submit.disabled = false;
        show();
        message.replaceChildren(h("div", { class: "alert error", role: "alert" }, errorMessage(error)));
      },
    );
  });

  show();
  const close = showOverlay(form, { label: "Sign in" });
  (current === "up" ? name : email).focus();
}
