/**
 * Small pure functions for the main process, kept apart from main.ts (which needs Electron) so
 * they can be unit tested (test/helpers.test.ts).
 */

/** A library circuit that doesn't exist (deleted meanwhile, or a wrong id). */
export class NotInLibraryError extends Error {
  constructor() {
    super("This circuit isn't in the library any more.");
    this.name = "NotInLibraryError";
  }
}

/** A setting the user typed that can't be used. Its message is shown as is. */
export class SettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingError";
  }
}

/**
 * The netlist file the app was started with, if any. Double-clicking `adder.net` makes Windows run
 * `CircuitLab.exe "C:\...\adder.net"`. Electron's own `--flags` (and, during development,
 * electron.exe and the app's folder) are in the list too, so only a `.net` argument counts.
 */
export function netlistFileFromArgs(argv: readonly string[]): string | null {
  for (let index = argv.length - 1; index >= 1; index--) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("-") && /\.net$/i.test(argument)) return argument;
  }
  return null;
}

/**
 * Checks a server address typed in Settings and writes it one way: "http://localhost:3000/" and
 * " http://localhost:3000 " both become "http://localhost:3000".
 *
 * @throws SettingError explaining what's wrong
 */
export function normalizeApiUrl(text: string): string {
  return normalizeAddress(text, "http://localhost:3000");
}

/** Where Ollama listens, checked and written the same way. @throws SettingError */
export function normalizeOllamaUrl(text: string): string {
  return normalizeAddress(text, "http://localhost:11434");
}

/** True for an address on this computer, where nothing typed in the app leaves the machine. */
export function isLocalAddress(address: string): boolean {
  try {
    const { hostname } = new URL(address);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** What settings.json holds. Every part is optional: nothing saved means the default. */
export interface SavedSettings {
  /** Online mode's server. */
  readonly apiUrl?: string;
  /** Where Ollama listens, for the assistant. */
  readonly assistantUrl?: string;
  /** The Ollama model the assistant uses; without it, the first one Ollama lists. */
  readonly assistantModel?: string;
}

/**
 * Reads the parsed contents of settings.json. A part that is missing or can't be used is left
 * out, so one bad entry (an old address, a hand edit) doesn't lose the others.
 */
export function readSavedSettings(data: unknown): SavedSettings {
  if (typeof data !== "object" || data === null) return {};
  const record = data as Record<string, unknown>;
  const address = (value: unknown, normalize: (text: string) => string): string | undefined => {
    if (typeof value !== "string") return undefined;
    try {
      return normalize(value);
    } catch {
      return undefined;
    }
  };
  const apiUrl = address(record["apiUrl"], normalizeApiUrl);
  const assistantUrl = address(record["assistantUrl"], normalizeOllamaUrl);
  const model = record["assistantModel"];
  return {
    ...(apiUrl !== undefined && { apiUrl }),
    ...(assistantUrl !== undefined && { assistantUrl }),
    ...(typeof model === "string" && model.trim() !== "" && model.length <= 200 && { assistantModel: model.trim() }),
  };
}

function normalizeAddress(text: string, example: string): string {
  const trimmed = text.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SettingError(`“${trimmed}” isn't a web address. Write it like ${example}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SettingError("The address must start with http:// or https://.");
  if (url.username !== "" || url.password !== "") throw new SettingError("Leave the user name and password out of the address.");
  if (url.search !== "" || url.hash !== "") throw new SettingError("The address can't contain ? or #.");
  // A path is allowed (an API behind a proxy, at https://example.com/circuitlab); /v1/... is added after it.
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
