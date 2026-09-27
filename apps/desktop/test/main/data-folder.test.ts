import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { legacyDataFolder, moveLegacyData } from "../../src/main/data-folder.js";

let appData = "";
beforeEach(() => { appData = mkdtempSync(join(tmpdir(), "vunemi-data-")); });
afterEach(() => { rmSync(appData, { recursive: true, force: true }); });

function legacyWith(file: string, text: string): string {
  const legacy = legacyDataFolder(appData);
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, file), text);
  return legacy;
}

describe("moving the earlier build's data folder", () => {
  it("renames it and leaves a link at the old path", () => {
    const legacy = legacyWith("settings.json", "{\"a\":1}");
    const target = join(appData, "Vunemi");
    expect(moveLegacyData(legacy, target, () => false)).toBe("moved");
    expect(readFileSync(join(target, "settings.json"), "utf8")).toBe("{\"a\":1}");
    expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
    // An absolute path saved before the move still reaches the file.
    expect(readFileSync(join(legacy, "settings.json"), "utf8")).toBe("{\"a\":1}");
  });

  it("does it once: a second start leaves both alone", () => {
    const legacy = legacyWith("settings.json", "x");
    const target = join(appData, "Vunemi");
    moveLegacyData(legacy, target, () => false);
    expect(moveLegacyData(legacy, target, () => false)).toBe("kept");
  });

  it("never touches a folder when the new one already exists", () => {
    const legacy = legacyWith("settings.json", "old");
    const target = join(appData, "Vunemi");
    mkdirSync(target);
    expect(moveLegacyData(legacy, target, () => false)).toBe("kept");
    expect(lstatSync(legacy).isDirectory()).toBe(true);
    expect(readFileSync(join(legacy, "settings.json"), "utf8")).toBe("old");
  });

  it("has nothing to do on a fresh install", () => {
    expect(moveLegacyData(legacyDataFolder(appData), join(appData, "Vunemi"), () => false)).toBe("none");
  });

  it("waits while the earlier build is running from the folder", () => {
    const legacy = legacyWith("settings.json", "x");
    symlinkSync("somehost-4242", join(legacy, "SingletonLock"));
    const target = join(appData, "Vunemi");
    expect(moveLegacyData(legacy, target, (pid) => pid === 4242)).toBe("busy");
    expect(lstatSync(legacy).isDirectory()).toBe(true);
    // A lock left behind by a build that has since quit doesn't hold it up.
    expect(moveLegacyData(legacy, target, () => false)).toBe("moved");
  });
});
