/**
 * Whether a pid left in the engine's pid file is still our engine, before a
 * new start stops it. By then the pid may belong to anything.
 */
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { processPath, staleEngine } from "../../src/main/engine/engine.js";

const onWindows = process.platform === "win32";
const ENGINE = "C:\\Users\\someone\\AppData\\Local\\Programs\\Vunemi\\resources\\llama-server.exe";

describe("a stale engine on Windows", () => {
  it("is our engine when its path is the engine's, in any letter case", () => {
    expect(staleEngine(4242, ENGINE, "win32", () => ENGINE.toLowerCase())).toBe(true);
  });

  it("is not another program", () => {
    expect(staleEngine(4242, ENGINE, "win32", () => "C:\\Windows\\notepad.exe")).toBe(false);
  });

  it("is not another llama-server.exe elsewhere on disk", () => {
    expect(staleEngine(4242, ENGINE, "win32", () => "C:\\Tools\\llama\\llama-server.exe")).toBe(false);
  });

  it("is not a process that is gone", () => {
    expect(staleEngine(4242, ENGINE, "win32", () => null)).toBe(false);
  });
});

describe("a stale engine on macOS and Linux", () => {
  const engine = "/Applications/Vunemi.app/Contents/Resources/llama-server";
  it("is our engine when its command starts with the engine", () => {
    expect(staleEngine(4242, engine, "darwin", () => `${engine} --port 1234 -m model.gguf`)).toBe(true);
  });

  it("is not another program", () => {
    expect(staleEngine(4242, engine, "linux", () => "/usr/bin/vim notes.txt")).toBe(false);
    expect(staleEngine(4242, engine, "darwin", () => null)).toBe(false);
  });
});

describe("asking Windows for a process's path", () => {
  it.runIf(onWindows)("finds a running program's own path, and nothing for a pid that is gone", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { windowsHide: true });
    try {
      const pid = child.pid!;
      expect(processPath(pid, "win32")?.toLowerCase()).toBe(process.execPath.toLowerCase());
      expect(staleEngine(pid, process.execPath, "win32")).toBe(true);
      expect(staleEngine(pid, ENGINE, "win32")).toBe(false);
    } finally {
      child.kill();
    }
    await new Promise((resolve) => child.once("exit", resolve));
    expect(processPath(child.pid!, "win32")).toBeNull();
  });
});
