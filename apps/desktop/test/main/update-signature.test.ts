/** A Windows installer is run only with the user's own signature over its version, architecture and contents. */
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signedMessage, verifyUpdate } from "../../src/main/updates/signature.js";
import { readFeed, windowsSource } from "../../src/main/updates/feed.js";

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pub: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey };
};
const ours = pair();
const theirs = pair();
const SHA = "a".repeat(64);
const signed = (version: string, arch: "x64" | "arm64", sha256 = SHA, key = ours.privateKey) =>
  sign(null, signedMessage(version, arch, sha256), key).toString("base64");

describe("the update signature", () => {
  it("verifies what the key signed", () => {
    expect(verifyUpdate(ours.pub, "0.5.1", "x64", SHA, signed("0.5.1", "x64"))).toBe(true);
  });

  it("binds version, architecture and contents", () => {
    const sig = signed("0.5.1", "x64");
    expect(verifyUpdate(ours.pub, "0.5.2", "x64", SHA, sig)).toBe(false);
    expect(verifyUpdate(ours.pub, "0.5.1", "arm64", SHA, sig)).toBe(false);
    expect(verifyUpdate(ours.pub, "0.5.1", "x64", `b${SHA.slice(1)}`, sig)).toBe(false);
  });

  it("refuses another key's signature and anything malformed", () => {
    expect(verifyUpdate(ours.pub, "0.5.1", "x64", SHA, signed("0.5.1", "x64", SHA, theirs.privateKey))).toBe(false);
    expect(verifyUpdate(ours.pub, "0.5.1", "x64", SHA, "")).toBe(false);
    expect(verifyUpdate(ours.pub, "0.5.1", "x64", SHA, "not base64!")).toBe(false);
    expect(verifyUpdate(ours.pub, "0.5.1", "x64", "xyz", signed("0.5.1", "x64", "xyz"))).toBe(false);
    expect(verifyUpdate("not a key", "0.5.1", "x64", SHA, signed("0.5.1", "x64"))).toBe(false);
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
    const root = new URL("../../../../scripts/", import.meta.url).pathname;
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
      expect(verifyUpdate(pub, "0.5.1", "x64", out.sha256, out.signature)).toBe(true);
      expect(verifyUpdate(pub, "0.5.1", "arm64", out.sha256, out.signature)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
