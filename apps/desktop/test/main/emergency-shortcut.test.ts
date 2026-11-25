/**
 * The emergency stop works from anywhere, so its shortcut must be one the
 * system lets an app register: Windows keeps Ctrl+Shift+Esc for Task Manager.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emergencyStopAccelerator } from "../../src/shared/ipc.js";

describe("the emergency stop shortcut", () => {
  it("stays the same on macOS and Linux and moves off Task Manager's keys on Windows", () => {
    expect(emergencyStopAccelerator("darwin")).toBe("CommandOrControl+Shift+Escape");
    expect(emergencyStopAccelerator("linux")).toBe("CommandOrControl+Shift+Escape");
    expect(emergencyStopAccelerator("win32")).toBe("Control+Alt+Shift+Escape");
  });

  it("is the one the menu shows and the one registered", () => {
    for (const file of ["../../src/main/presence.ts", "../../src/main/index.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).toContain("emergencyStopAccelerator(process.platform)");
      expect(source, file).not.toContain('"CommandOrControl+Shift+Escape"');
    }
  });
});
