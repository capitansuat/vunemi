/** The Windows installer and the Linux packages as electron-builder is told to make them. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as {
  build: {
    win: { target: { target: string; arch: string[] }[] };
    nsis: Record<string, unknown>;
    linux: { artifactName: string; target: { target: string; arch: string[] }[] };
    toolsets?: { appimage?: string };
  };
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

it("makes the Linux AppImage and .deb for x64 and arm64, under the names the feed and the site check", () => {
  for (const kind of ["AppImage", "deb"]) expect(pkg.build.linux.target.find((target) => target.target === kind)?.arch).toEqual(["x64", "arm64"]);
  expect(pkg.build.linux.artifactName).toBe("Vunemi-${version}-linux-${arch}.${ext}");
});

it("gives the AppImage the static runtime, which needs no libfuse2 and no libz.so", () => {
  // The legacy toolset's arm64 runtime asks for libz.so, which only zlib's
  // development package provides, so it wouldn't start on most arm64 systems.
  expect(pkg.build.toolsets?.appimage).toBe("1.0.3");
});
