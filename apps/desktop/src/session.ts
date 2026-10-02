import type { AuthSession, UserResource } from "@circuitlab/api-contract";

/**
 * Who is signed in, kept in localStorage so a page reload doesn't sign you out.
 *
 * Known shortcut: any script running on this page could read localStorage, so an XSS bug would
 * leak the tokens. We never put user text into innerHTML (see dom.ts) and load no third-party
 * scripts, which keeps that risk low. The safer design is an httpOnly cookie for the refresh
 * token, but that needs changes to the API, so it's listed as a next step in docs/desktop-app.md.
 */
export interface Session {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly user: UserResource;
}

const STORAGE_KEY = "circuitlab.session";
const listeners: (() => void)[] = [];

/** Read fresh every time, so two open tabs always use the newest tokens. */
export function currentSession(): Session | null {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text === null ? null : (JSON.parse(text) as Session);
  } catch {
    return null; // storage blocked (private mode) or corrupted: act signed out
  }
}

export function saveSession(auth: AuthSession): void {
  const session: Session = { accessToken: auth.accessToken, refreshToken: auth.refreshToken, user: auth.user };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage blocked: nothing we can do; the user will have to sign in again after a reload.
  }
  notify();
}

export function clearSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore, same as above
  }
  notify();
}

/** Calls `listener` whenever someone signs in or out (in this tab or another one). */
export function onSessionChange(listener: () => void): void {
  listeners.push(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

// The "storage" event fires when *another* tab changes localStorage, e.g. signs out there.
window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY) notify();
});
