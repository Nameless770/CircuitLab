import { describe, expect, it } from "vitest";
import styles from "../src/styles.css?raw";
import { SettingError, isLocalAddress, netlistFileFromArgs, normalizeApiUrl, normalizeOllamaUrl, readSavedSettings, windowColors } from "../electron/helpers";

describe("netlistFileFromArgs", () => {
  it("finds the .net file Windows passes when a file is double-clicked", () => {
    expect(netlistFileFromArgs(["C:\\Apps\\CircuitLab.exe", "C:\\circuits\\adder.net"])).toBe("C:\\circuits\\adder.net");
  });

  it("skips Electron's own flags, and the app folder during development", () => {
    expect(netlistFileFromArgs(["electron.exe", "--inspect=0", "C:\\repo\\apps\\desktop", "--remote-debugging-port=0", "D:\\x\\LATCH.NET"])).toBe("D:\\x\\LATCH.NET");
  });

  it("is null when the app was started without a file", () => {
    expect(netlistFileFromArgs(["C:\\Apps\\CircuitLab.exe"])).toBeNull();
    expect(netlistFileFromArgs(["electron.exe", "C:\\repo\\apps\\desktop", "notes.txt"])).toBeNull();
  });

  it("never takes the program itself, even if its name ends in .net", () => {
    expect(netlistFileFromArgs(["C:\\odd\\program.net"])).toBeNull();
  });
});

describe("normalizeApiUrl", () => {
  it("writes an address one way: no spaces, no trailing slash", () => {
    expect(normalizeApiUrl(" http://localhost:3000/ ")).toBe("http://localhost:3000");
    expect(normalizeApiUrl("https://circuits.example.com")).toBe("https://circuits.example.com");
  });

  it("keeps a path, for an API behind a proxy", () => {
    expect(normalizeApiUrl("https://example.com/circuitlab/")).toBe("https://example.com/circuitlab");
  });

  it("refuses what isn't an http or https address, with a message for people", () => {
    expect(() => normalizeApiUrl("localhost:3000")).toThrow(SettingError);
    expect(() => normalizeApiUrl("not an address")).toThrow(/isn't a web address/);
    expect(() => normalizeApiUrl("ftp://example.com")).toThrow(/http:\/\/ or https:\/\//);
    expect(() => normalizeApiUrl("http://ada:secret@example.com")).toThrow(/user name and password/);
    expect(() => normalizeApiUrl("http://example.com/?x=1")).toThrow(/\? or #/);
  });
});

describe("normalizeOllamaUrl", () => {
  it("writes the address one way, like the server address", () => {
    expect(normalizeOllamaUrl(" http://127.0.0.1:11434/ ")).toBe("http://127.0.0.1:11434");
    expect(normalizeOllamaUrl("http://gpu-box.local:11434")).toBe("http://gpu-box.local:11434");
  });

  it("refuses a bad address, with an example that fits Ollama", () => {
    expect(() => normalizeOllamaUrl("localhost:11434")).toThrow(SettingError);
    expect(() => normalizeOllamaUrl("nonsense")).toThrow(/Write it like http:\/\/localhost:11434/);
    expect(() => normalizeOllamaUrl("ftp://x")).toThrow(/http:\/\/ or https:\/\//);
  });
});

describe("isLocalAddress", () => {
  it("is true for this computer, in the ways it can be written", () => {
    for (const address of ["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434", "http://ollama.localhost:11434"]) expect(isLocalAddress(address), address).toBe(true);
  });

  it("is false for anything else, and for what isn't an address", () => {
    for (const address of ["http://192.168.1.20:11434", "https://ollama.example.com", "http://localhost.example.com", "nonsense", ""]) expect(isLocalAddress(address), address).toBe(false);
  });
});

describe("readSavedSettings", () => {
  it("reads every part, writing the addresses one way", () => {
    expect(readSavedSettings({ apiUrl: "http://localhost:3000/", assistantUrl: "http://127.0.0.1:11434/", assistantModel: " llama3.2:3b " })).toEqual({
      apiUrl: "http://localhost:3000",
      assistantUrl: "http://127.0.0.1:11434",
      assistantModel: "llama3.2:3b",
    });
  });

  it("keeps the good parts when one is bad, so a hand edit doesn't lose the rest", () => {
    expect(readSavedSettings({ apiUrl: "not an address", assistantUrl: "http://127.0.0.1:11434", assistantModel: "" })).toEqual({ assistantUrl: "http://127.0.0.1:11434" });
    expect(readSavedSettings({ apiUrl: 5, assistantModel: ["x"] })).toEqual({});
    expect(readSavedSettings({ assistantModel: "x".repeat(201) })).toEqual({});
  });

  it("copes with a file that isn't an object, and an old file with only the server address", () => {
    for (const data of [null, undefined, "text", 3, []]) expect(readSavedSettings(data)).toEqual({});
    expect(readSavedSettings({ apiUrl: "https://circuits.example.com" })).toEqual({ apiUrl: "https://circuits.example.com" });
  });

  it("reads the window's theme, and ignores one it doesn't know", () => {
    expect(readSavedSettings({ theme: "light" })).toEqual({ theme: "light" });
    expect(readSavedSettings({ theme: "dark", apiUrl: "http://localhost:3000" })).toEqual({ theme: "dark", apiUrl: "http://localhost:3000" });
    for (const theme of ["blue", "LIGHT", 1, null]) expect(readSavedSettings({ theme })).toEqual({});
  });
});

describe("windowColors", () => {
  /** The value of a colour token (--bg, ...) in the block of styles.css that starts with `selector`. */
  function token(selector: string, name: string): string | undefined {
    const block = styles.slice(styles.indexOf(selector), styles.indexOf("}", styles.indexOf(selector)));
    return new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`).exec(block)?.[1];
  }

  it("paints the frame in the same colours as the page's title bar, in both themes", () => {
    for (const theme of ["dark", "light"] as const) {
      const selector = `[data-theme="${theme}"] {`;
      expect(windowColors(theme), theme).toEqual({ background: token(selector, "bg"), titleBar: token(selector, "panel"), symbols: token(selector, "muted") });
    }
  });
});
