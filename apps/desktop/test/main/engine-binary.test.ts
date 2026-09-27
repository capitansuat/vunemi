import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINE_TAG, engineBinary } from "../../src/main/engine/binary.js";

const tmp = mkdtempSync(join(tmpdir(), "tenami-bin-"));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("where the engine lives", () => {
  it("is in the app's resources once packaged", () => {
    writeFileSync(join(tmp, "llama-server"), "");
    expect(engineBinary({ packaged: true, resourcesPath: tmp, home: "/nowhere" })).toBe(join(tmp, "llama-server"));
  });

  it("is in the build cache during development", () => {
    const cache = join(tmp, ".ocak-build", "engine-cache", ENGINE_TAG);
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "llama-server"), "");
    expect(engineBinary({ packaged: false, resourcesPath: "/nowhere", home: tmp })).toBe(join(cache, "llama-server"));
  });

  it("is missing rather than broken", () => {
    expect(engineBinary({ packaged: true, resourcesPath: "/nowhere", home: "/nowhere" })).toBeNull();
  });

  it("is built from the tag the app expects", () => {
    const script = readFileSync(fileURLToPath(new URL("../../../../scripts/build-engine.sh", import.meta.url)), "utf8");
    expect(script).toContain(`tag="\${OCAK_ENGINE_TAG:-${ENGINE_TAG}}"`);
  });
});
