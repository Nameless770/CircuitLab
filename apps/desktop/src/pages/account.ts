import { register, signIn } from "../api";
import { h } from "../dom";
import { currentPath, navigate, type PageContext } from "../router";
import { currentSession } from "../session";
import { field, runAction } from "../ui";

/** Where to go after signing in: the page that asked for it (`?next=`), or your circuits. */
function nextPath(query: URLSearchParams): string {
  const next = query.get("next");
  // Only paths inside the app, never something like "//evil.example".
  return next !== null && next.startsWith("/") && !next.startsWith("//") ? next : "/circuits?scope=owned";
}

export function signInPage({ root, query }: PageContext): void {
  const next = nextPath(query);
  if (currentSession() !== null) {
    navigate(next);
    return;
  }
  const email = h("input", { type: "email", name: "email", required: true, autocomplete: "username", maxlength: 254 });
  const password = h("input", { type: "password", name: "password", required: true, autocomplete: "current-password", maxlength: 256 });
  const submit = h("button", { type: "submit", class: "primary" }, "Sign in");
  const message = h("div");

  const form = h(
    "form",
    { class: "card form narrow" },
    h("h1", {}, "Sign in"),
    h("p", { class: "muted" }, "Sign in to your account on the CircuitLab server to see your circuits and the ones shared with you."),
    field("Email", email),
    field("Password", password),
    message,
    h("div", { class: "form-actions" }, submit),
    h("p", { class: "muted" }, "No account yet? ", h("a", { href: `#/register?next=${encodeURIComponent(next)}` }, "Create one"), "."),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault(); // we send the form ourselves with fetch
    void runAction(submit, message, async () => {
      await signIn({ email: email.value.trim(), password: password.value });
      navigate(next);
    });
  });
  root.append(form);
  email.focus();
}

export function registerPage({ root, query }: PageContext): void {
  const next = nextPath(query);
  const displayName = h("input", { type: "text", name: "name", required: true, autocomplete: "nickname", maxlength: 100 });
  const email = h("input", { type: "email", name: "email", required: true, autocomplete: "username", maxlength: 254 });
  const password = h("input", { type: "password", name: "password", required: true, autocomplete: "new-password", minlength: 15, maxlength: 256 });
  const submit = h("button", { type: "submit", class: "primary" }, "Create account");
  const message = h("div");

  const form = h(
    "form",
    { class: "card form narrow" },
    h("h1", {}, "Create an account"),
    field("Your name", displayName, "Shown to people you share circuits with."),
    field("Email", email),
    // The API's rule (NIST's advice): length matters, not symbols.
    field("Password", password, "At least 15 characters. A few random words work well, e.g. “purple kettle river stone”."),
    message,
    h("div", { class: "form-actions" }, submit),
    h("p", { class: "muted" }, "Already have an account? ", h("a", { href: `#/login?next=${encodeURIComponent(next)}` }, "Sign in"), "."),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void runAction(submit, message, async () => {
      await register({ displayName: displayName.value.trim(), email: email.value.trim(), password: password.value });
      navigate(next);
    });
  });
  root.append(form);
  displayName.focus();
}

/**
 * For pages that need an account: true if signed in; otherwise shows a "please sign in" box
 * (which comes back here afterwards) and returns false.
 */
export function requireSignIn(root: HTMLElement): boolean {
  if (currentSession() !== null) return true;
  const back = encodeURIComponent(currentPath());
  root.append(
    h(
      "div",
      { class: "card empty-state" },
      h("h1", {}, "Please sign in"),
      h("p", {}, "This needs an account on the CircuitLab server. (Offline mode doesn't: try opening a netlist file from the home screen.)"),
      h("div", { class: "form-actions" }, h("a", { class: "button primary", href: `#/login?next=${back}` }, "Sign in"), h("a", { class: "button", href: `#/register?next=${back}` }, "Create an account")),
    ),
  );
  return false;
}
