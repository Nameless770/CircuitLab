import { signOut } from "./api";
import { desktop } from "./desktop";
import { h } from "./dom";
import { currentDocument, documentLabel } from "./offline/document";
import { currentPath, navigate, onPageChange } from "./router";
import { currentSession, onSessionChange } from "./session";

/** The bar at the top of the window. Drawn again whenever the page or the signed-in user changes. */
export function startHeader(container: HTMLElement): void {
  const draw = (): void => container.replaceChildren(header());
  onSessionChange(draw);
  onPageChange(draw);
  draw();
}

function header(): HTMLElement {
  const session = currentSession();
  const path = currentPath();
  const openFile = currentDocument();

  const link = (href: string, text: string, active: boolean): HTMLElement =>
    h("a", { href: `#${href}`, class: active ? "nav-link active" : "nav-link", "aria-current": active ? "page" : null }, text);
  const onList = (scope: string): boolean => path.startsWith("/circuits?") && path.includes(`scope=${scope}`);

  const links: HTMLElement[] = [link("/", "Home", path === "/")];
  if (session !== null) {
    links.push(link("/circuits?scope=owned", "My circuits", onList("owned")));
    links.push(link("/circuits?scope=shared", "Shared with me", onList("shared")));
  }
  links.push(link("/circuits?scope=public", "Public", onList("public")));
  // Offline: the library, and the circuit that's open, if any.
  if (desktop() !== null) links.push(link("/library", "Library", path.startsWith("/library")));
  if (openFile !== null) links.push(link("/local", documentLabel(openFile), path.startsWith("/local")));

  // Settings only exist in the desktop app (the main process keeps them).
  const settings = desktop() === null ? null : link("/settings", "Settings", path === "/settings");
  const account =
    session === null
      ? h("div", { class: "account" }, settings, h("a", { class: "button small", href: "#/login" }, "Sign in"))
      : h(
          "div",
          { class: "account" },
          settings,
          h("span", { class: "muted", title: session.user.email }, session.user.displayName),
          h(
            "button",
            {
              class: "small",
              onclick: () => {
                void signOut().then(() => navigate("/"));
              },
            },
            "Sign out",
          ),
        );

  return h(
    "div",
    { class: "header-inner" },
    h("a", { class: "brand", href: "#/" }, h("img", { src: "favicon.svg", alt: "", width: 24, height: 24 }), "CircuitLab"),
    h("nav", { class: "nav" }, links),
    account,
  );
}
