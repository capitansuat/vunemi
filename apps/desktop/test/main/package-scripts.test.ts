/** The Linux and Windows package scripts ship vunemi-move, checked like the engines. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MOVE_VERSION } from "../../src/main/native-move.js";

const script = (name: string) => readFileSync(fileURLToPath(new URL(`../../../../scripts/${name}`, import.meta.url)), "utf8");

describe("package scripts", () => {
  it("Linux builds vunemi-move for the target and puts it in the resources, checked", () => {
    const text = script("package-linux.sh");
    expect(text).toContain('bash "$here/scripts/build-move-linux.sh" --arch "$arch"');
    expect(text).toContain('cp -p "$move_cache/vunemi-move" "$resources/vunemi-move"');
    expect(text).toMatch(/for bin in [^\n]*"\$resources\/vunemi-move"/);
  });

  it("Windows builds vunemi-move.exe for the target and puts it in the resources, checked", () => {
    const text = script("package-windows.mjs");
    expect(text).toContain('ps("build-move.ps1")');
    expect(text).toContain('[moveCache, "vunemi-move.exe"]');
  });

  it("every build script names the version native-move.ts looks for", () => {
    expect(script("build-move-linux.sh")).toContain(`version="\${VUNEMI_MOVE_VERSION:-${MOVE_VERSION}}"`);
    expect(script("windows/build-move.ps1")).toContain(`$version = "${MOVE_VERSION}"`);
  });
});
