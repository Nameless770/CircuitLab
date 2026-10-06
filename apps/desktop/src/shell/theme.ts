import { desktop } from "../desktop";

/**
 * The window's look: a dark or light theme, and the colour a 1 is drawn in. Both are kept in this
 * computer's localStorage, and applied as attributes on <html> (styles.css does the rest).
 *
 * The main process is told the theme too, because Windows draws the minimize, maximize and close
 * buttons over our title bar, and their strip must match it (electron/main.ts).
 */
export type Theme = "dark" | "light";
export type SignalColour = "amber" | "green" | "cyan";

export const THEMES: readonly Theme[] = ["dark", "light"];
export const SIGNAL_COLOURS: readonly SignalColour[] = ["amber", "green", "cyan"];

const THEME_KEY = "circuitlab.theme";
const SIGNAL_KEY = "circuitlab.signal";
const listeners: (() => void)[] = [];

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.find((candidate) => candidate === value) ?? fallback;
  } catch {
    return fallback; // storage blocked: the default look
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered, that's all
  }
}

export function currentTheme(): Theme {
  return read(THEME_KEY, THEMES, "dark");
}

export function currentSignal(): SignalColour {
  return read(SIGNAL_KEY, SIGNAL_COLOURS, "amber");
}

/** Puts the saved look on the page. Called once at startup, and after every change. */
export function applyAppearance(): void {
  const theme = currentTheme();
  document.documentElement.dataset["theme"] = theme;
  document.documentElement.dataset["signal"] = currentSignal();
  void desktop()?.setWindowTheme(theme);
}

export function setTheme(theme: Theme): void {
  write(THEME_KEY, theme);
  changed();
}

export function toggleTheme(): void {
  setTheme(currentTheme() === "dark" ? "light" : "dark");
}

export function setSignal(colour: SignalColour): void {
  write(SIGNAL_KEY, colour);
  changed();
}

export function onAppearanceChange(listener: () => void): void {
  listeners.push(listener);
}

function changed(): void {
  applyAppearance();
  for (const listener of listeners) listener();
}
