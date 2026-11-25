/** The Windows installer as electron-builder is told to make it. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as {
  build: { win: { target: { target: string; arch: string[] }[] }; nsis: Record<string, unknown> };
};

it("installs for the user only, without asking for administrator rights", () => {
  expect(pkg.build.nsis.perMachine).toBe(false);
  expect(pkg.build.nsis.allowElevation).toBe(false);
  expect(pkg.build.nsis.oneClick).toBe(true);
});

it("is made for x64 and arm64, named by version and architecture", () => {
  const nsis = pkg.build.win.target.find((target) => target.target === "nsis");
  expect(nsis?.arch).toEqual(["x64", "arm64"]);
  expect(pkg.build.nsis.artifactName).toBe("Vunemi-Setup-${version}-${arch}.${ext}");
});
