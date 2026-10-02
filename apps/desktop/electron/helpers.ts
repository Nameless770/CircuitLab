/**
 * Small pure functions for the main process, kept apart from main.ts (which needs Electron) so
 * they can be unit tested (test/helpers.test.ts).
 */

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
  const trimmed = text.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SettingError(`“${trimmed}” isn't a web address. Write it like http://localhost:3000`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SettingError("The address must start with http:// or https://.");
  if (url.username !== "" || url.password !== "") throw new SettingError("Leave the user name and password out of the address.");
  if (url.search !== "" || url.hash !== "") throw new SettingError("The address can't contain ? or #.");
  // A path is allowed (an API behind a proxy, at https://example.com/circuitlab); /v1/... is added after it.
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
