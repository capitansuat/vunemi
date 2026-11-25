/** An update (a Windows installer, a Linux AppImage) is run only with the user's own signature over its platform, version, architecture and contents. */
import { generateKeyPairSync, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signedMessage, verifyUpdate } from "../../src/main/updates/signature.js";
import { linuxSource, localLinuxSource, readFeed, windowsSource } from "../../src/main/updates/feed.js";

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pub: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey };
};
const ours = pair();
const theirs = pair();
const SHA = "a".repeat(64);
const signed = (version: string, arch: "x64" | "arm64", sha256 = SHA, key = ours.privateKey, platform: "windows" | "linux" = "windows") =>
  sign(null, signedMessage(platform, version, arch, sha256), key).toString("base64");

describe("the update signature", () => {
  it("signs Windows' bytes exactly as the published Windows releases were signed", () => {
    expect(signedMessage("windows", "0.5.0", "arm64", SHA).toString("utf8")).toBe(`vunemi-windows-update/1\n0.5.0\narm64\n${SHA}`);
    expect(signedMessage("linux", "0.5.1", "x64", SHA).toString("utf8")).toBe(`vunemi-linux-update/1\n0.5.1\nx64\n${SHA}`);
  });

  it("never lets one platform's signature pass for the other", () => {
    expect(verifyUpdate(ours.pub, "linux", "0.5.1", "x64", SHA, signed("0.5.1", "x64", SHA, ours.privateKey, "linux"))).toBe(true);
    expect(verifyUpdate(ours.pub, "windows", "0.5.1", "x64", SHA, signed("0.5.1", "x64", SHA, ours.privateKey, "linux"))).toBe(false);
    expect(verifyUpdate(ours.pub, "linux", "0.5.1", "x64", SHA, signed("0.5.1", "x64"))).toBe(false);
  });

  it("verifies what the key signed", () => {
    expect(verifyUpdate(ours.pub, "windows", "0.5.1", "x64", SHA, signed("0.5.1", "x64"))).toBe(true);
  });

  it("binds version, architecture and contents", () => {
    const sig = signed("0.5.1", "x64");
    expect(verifyUpdate(ours.pub, "windows", "0.5.2", "x64", SHA, sig)).toBe(false);
    expect(verifyUpdate(ours.pub, "windows", "0.5.1", "arm64", SHA, sig)).toBe(false);
    expect(verifyUpdate(ours.pub, "windows", "0.5.1", "x64", `b${SHA.slice(1)}`, sig)).toBe(false);
  });

  it("refuses another key's signature and anything malformed", () => {
    expect(verifyUpdate(ours.pub, "windows", "0.5.1", "x64", SHA, signed("0.5.1", "x64", SHA, theirs.privateKey))).toBe(false);
    expect(verifyUpdate(ours.pub, "windows", "0.5.1", "x64", SHA, "")).toBe(false);
    expect(verifyUpdate(ours.pub, "windows", "0.5.1", "x64", SHA, "not base64!")).toBe(false);
    expect(verifyUpdate(ours.pub, "windows", "0.5.1", "x64", "xyz", signed("0.5.1", "x64", "xyz"))).toBe(false);
    expect(verifyUpdate("not a key", "windows", "0.5.1", "x64", SHA, signed("0.5.1", "x64"))).toBe(false);
  });
});

const RELEASES = "https://github.com/capitansuat/vunemi/releases/download";
const winFeed = (version: string, arch: "x64" | "arm64", to: Record<string, unknown>) => ({
  currentRelease: version,
  releases: [{ version, updateTo: { version, url: `${RELEASES}/v${version}/Vunemi-Setup-${version}-${arch}.exe`, sha256: SHA, signature: signed(version, arch), ...to } }],
  notes: { en: ["Updates."] },
});

describe("the Windows feed", () => {
  const source = windowsSource("x64", ours.pub);

  it("offers a signed installer from the releases, with what the updater needs", () => {
    const offer = readFeed(winFeed("0.5.1", "x64", {}), "0.5.0", "en", source);
    expect(offer).toMatchObject({ version: "0.5.1", sha256: SHA, url: `${RELEASES}/v0.5.1/Vunemi-Setup-0.5.1-x64.exe` });
  });

  it("accepts the release under its own tag name", () => {
    expect(readFeed(winFeed("0.5.1", "x64", { url: `${RELEASES}/v0.5.1-windows.1/Vunemi-Setup-0.5.1-x64.exe` }), "0.5.0", "en", source)).not.toBeNull();
  });

  it("refuses an installer from anywhere else", () => {
    for (const url of [
      "https://example.com/Vunemi-Setup-0.5.1-x64.exe",
      "https://github.com/someone/vunemi/releases/download/v0.5.1/Vunemi-Setup-0.5.1-x64.exe",
      `${RELEASES}/v0.5.1/Vunemi-Setup-0.5.1-arm64.exe`,
      `${RELEASES}/v0.5.1/Vunemi-Setup-0.5.2-x64.exe`,
      `${RELEASES}/v0.5.1/../evil/Vunemi-Setup-0.5.1-x64.exe`,
      `http://github.com/capitansuat/vunemi/releases/download/v0.5.1/Vunemi-Setup-0.5.1-x64.exe`,
    ]) expect(readFeed(winFeed("0.5.1", "x64", { url }), "0.5.0", "en", source), url).toBeNull();
  });

  it("refuses an installer without a signature that holds", () => {
    expect(readFeed(winFeed("0.5.1", "x64", { signature: undefined }), "0.5.0", "en", source)).toBeNull();
    expect(readFeed(winFeed("0.5.1", "x64", { sha256: undefined }), "0.5.0", "en", source)).toBeNull();
    expect(readFeed(winFeed("0.5.1", "x64", { signature: signed("0.5.2", "x64") }), "0.5.0", "en", source)).toBeNull();
    expect(readFeed(winFeed("0.5.1", "x64", { signature: signed("0.5.1", "arm64") }), "0.5.0", "en", source)).toBeNull();
    expect(readFeed(winFeed("0.5.1", "x64", { signature: signed("0.5.1", "x64", SHA, theirs.privateKey) }), "0.5.0", "en", source)).toBeNull();
  });

  it("offers nothing while the app has no key to check with", () => {
    expect(readFeed(winFeed("0.5.1", "x64", {}), "0.5.0", "en", windowsSource("x64", null))).toBeNull();
  });
});

describe("the release scripts", () => {
  it("make a key and sign what the app verifies, and never replace a key", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, rmSync, writeFileSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const root = fileURLToPath(new URL("../../../../scripts/", import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "vunemi-update-key-"));
    try {
      const env = { ...process.env, VUNEMI_UPDATE_KEY_FILE: join(dir, "key.pem") };
      const pub = execFileSync(process.execPath, [join(root, "update-key.mjs")], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      expect(pub).toContain("BEGIN PUBLIC KEY");
      expect(pub).not.toContain("PRIVATE");
      if (process.platform !== "win32") expect(statSync(join(dir, "key.pem")).mode & 0o777).toBe(0o600);
      expect(() => execFileSync(process.execPath, [join(root, "update-key.mjs")], { env, stdio: "ignore" })).toThrow();

      const installer = join(dir, "Vunemi-Setup-0.5.1-x64.exe");
      writeFileSync(installer, "made-up installer bytes");
      const out = JSON.parse(execFileSync(process.execPath, [join(root, "sign-windows-update.mjs"), installer, "0.5.1", "x64"], { env, encoding: "utf8" })) as { sha256: string; signature: string };
      expect(out.sha256).toBe(createHash("sha256").update("made-up installer bytes").digest("hex"));
      expect(verifyUpdate(pub, "windows", "0.5.1", "x64", out.sha256, out.signature)).toBe(true);
      expect(verifyUpdate(pub, "windows", "0.5.1", "arm64", out.sha256, out.signature)).toBe(false);

      const appImage = join(dir, "Vunemi-0.5.1-linux-arm64.AppImage");
      writeFileSync(appImage, "made-up appimage bytes");
      const linux = JSON.parse(execFileSync(process.execPath, [join(root, "sign-update.mjs"), appImage, "0.5.1", "arm64", "linux"], { env, encoding: "utf8" })) as { sha256: string; signature: string };
      expect(verifyUpdate(pub, "linux", "0.5.1", "arm64", linux.sha256, linux.signature)).toBe(true);
      expect(verifyUpdate(pub, "windows", "0.5.1", "arm64", linux.sha256, linux.signature)).toBe(false);
      expect(() => execFileSync(process.execPath, [join(root, "sign-update.mjs"), appImage, "0.5.1", "arm64", "macos"], { env, stdio: "ignore" })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const appImage = (version: string, arch: "x64" | "arm64", tag = `v${version}-linux.1`) =>
  `${RELEASES}/${tag}/Vunemi-${version}-linux-${arch === "x64" ? "x86_64" : "arm64"}.AppImage`;
const linuxFeed = (version: string, arch: "x64" | "arm64", to: Record<string, unknown>) => ({
  currentRelease: version,
  releases: [{ version, updateTo: { version, url: appImage(version, arch), sha256: SHA, signature: signed(version, arch, SHA, ours.privateKey, "linux"), ...to } }],
  notes: { en: ["Linux updates."] },
});

describe("the Linux feed", () => {
  it("reads linux-<arch>.json and offers a Linux-signed AppImage from the releases", () => {
    expect(linuxSource("x64", ours.pub).feed).toBe("https://vunemi.com/update/linux-x64.json");
    expect(linuxSource("arm64", ours.pub).feed).toBe("https://vunemi.com/update/linux-arm64.json");
    const offer = readFeed(linuxFeed("0.5.1", "arm64", {}), "0.5.0", "en", linuxSource("arm64", ours.pub));
    expect(offer).toMatchObject({ version: "0.5.1", sha256: SHA, url: appImage("0.5.1", "arm64"), notes: ["Linux updates."] });
  });

  it("refuses a .deb, the other architecture, another repository, a path out or plain http", () => {
    const source = linuxSource("x64", ours.pub);
    const offered = (url: string) => readFeed(linuxFeed("0.5.1", "x64", { url }), "0.5.0", "en", source);
    expect(offered(appImage("0.5.1", "x64"))).not.toBeNull();
    expect(offered(`${RELEASES}/v0.5.1-linux.1/Vunemi-0.5.1-linux-amd64.deb`)).toBeNull();
    expect(offered(appImage("0.5.1", "arm64"))).toBeNull();
    expect(offered(appImage("0.5.1", "x64").replace("capitansuat/vunemi", "someone/vunemi"))).toBeNull();
    expect(offered(`${RELEASES}/../x/Vunemi-0.5.1-linux-x86_64.AppImage`)).toBeNull();
    expect(offered(appImage("0.5.1", "x64").replace("https:", "http:"))).toBeNull();
  });

  it("refuses an AppImage signed for Windows, and Windows refuses one signed for Linux", () => {
    const forWindows = linuxFeed("0.5.1", "x64", { signature: signed("0.5.1", "x64") });
    expect(readFeed(forWindows, "0.5.0", "en", linuxSource("x64", ours.pub))).toBeNull();
    const linuxSigned = winFeed("0.5.1", "x64", { signature: signed("0.5.1", "x64", SHA, ours.privateKey, "linux") });
    expect(readFeed(linuxSigned, "0.5.0", "en", windowsSource("x64", ours.pub))).toBeNull();
  });

  it("offers nothing without a key, and a local test feed only from its own address", () => {
    expect(readFeed(linuxFeed("0.5.1", "x64", {}), "0.5.0", "en", linuxSource("x64", null))).toBeNull();
    const base = "http://127.0.0.1:18765/";
    const local = localLinuxSource(base, "x64", ours.pub);
    expect(local.feed).toBe(`${base}linux-x64.json`);
    expect(readFeed(linuxFeed("0.5.1", "x64", { url: `${base}Vunemi-0.5.1-linux-x86_64.AppImage` }), "0.5.0", "en", local)).not.toBeNull();
    expect(readFeed(linuxFeed("0.5.1", "x64", {}), "0.5.0", "en", local)).toBeNull();
  });
});

describe("the site's Windows feed", () => {
  it("is one the app accepts for its own architecture only", async () => {
    // website/src/update-feed.mjs writes vunemi.com/update/win-<arch>.json.
    const site = new URL("../../../../website/src/update-feed.mjs", import.meta.url).href;
    const { windowsFeed } = (await import(/* @vite-ignore */ site)) as {
      windowsFeed(release: unknown, arch: "x64" | "arm64", copy: unknown, languages: string[]): unknown;
    };
    const { createHash: hash } = await import("node:crypto");
    const sha = hash("sha256").update("made-up arm64 installer").digest("hex");
    const signature = sign(null, signedMessage("windows", "0.5.1", "arm64", sha), ours.privateKey).toString("base64");
    const release = {
      tag: "v0.5.1-windows.1", version: "0.5.1", date: "2026-12-01",
      files: [{ arch: "arm64", asset: "Vunemi-Setup-0.5.1-arm64.exe", sizeMb: 118, sha256: sha, signature }],
      url(asset: string) { return `https://github.com/capitansuat/vunemi/releases/download/${this.tag}/${asset}`; },
    };
    const feed = windowsFeed(release, "arm64", { en: { updateNotes: ["Windows preview."] } }, ["en"]);
    const offer = readFeed(feed, "0.5.0", "en", windowsSource("arm64", ours.pub));
    expect(offer).toMatchObject({ version: "0.5.1", sha256: sha, url: release.url("Vunemi-Setup-0.5.1-arm64.exe"), notes: ["Windows preview."], sizeMb: 118 });
    expect(readFeed(feed, "0.5.0", "en", windowsSource("x64", ours.pub))).toBeNull();
  });
});
