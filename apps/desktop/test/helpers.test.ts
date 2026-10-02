import { describe, expect, it } from "vitest";
import { SettingError, netlistFileFromArgs, normalizeApiUrl } from "../electron/helpers";

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
