import assert from "node:assert/strict";
import { test } from "node:test";
import { checkLinuxRelease, checkWindowsRelease, linuxFeed, updateFeed, windowsFeed } from "./update-feed.mjs";

const base = { version: "0.1.8", date: "2026-10-01", zip: "Vunemi-0.1.8-arm64.zip", zipSizeMb: 131, zipSha256: "a".repeat(64),
  get zipUrl() { return `https://github.com/capitansuat/vunemi/releases/download/v${this.version}/${this.zip}`; } };
const copy = { en: { downloadPage: { highlights: ["Updates."] } }, tr: { downloadPage: { highlights: ["Güncellemeler."] } } };

test("writes Squirrel's static format plus size and notes per language", () => {
  const feed = updateFeed(base, copy, ["en", "tr"]);
  assert.equal(feed.currentRelease, "0.1.8");
  assert.deepEqual(feed.releases, [{ version: "0.1.8", updateTo: { version: "0.1.8", name: "Vunemi 0.1.8", pub_date: "2026-10-01T00:00:00Z", notes: "", url: "https://github.com/capitansuat/vunemi/releases/download/v0.1.8/Vunemi-0.1.8-arm64.zip" } }]);
  assert.equal(feed.sizeMb, 131);
  assert.deepEqual(feed.notes, { en: ["Updates."], tr: ["Güncellemeler."] });
});

test("writes nothing for a release without a zip", () => {
  assert.equal(updateFeed({ ...base, zip: undefined }, copy, ["en"]), null);
});

// The Windows preview: one feed per architecture, with the installer's SHA-256 and signature.
const win = {
  tag: "v0.5.1-windows.1", version: "0.5.1", date: "2026-12-01",
  files: [
    { arch: "x64", asset: "Vunemi-Setup-0.5.1-x64.exe", sizeMb: 120, sha256: "b".repeat(64), signature: `${"S".repeat(86)}==` },
    { arch: "arm64", asset: "Vunemi-Setup-0.5.1-arm64.exe", sizeMb: 118, sha256: "c".repeat(64), signature: `${"T".repeat(86)}==` },
  ],
  url(asset) { return `https://github.com/capitansuat/vunemi/releases/download/${this.tag}/${asset}`; },
};
const winCopy = { en: { updateNotes: ["Windows preview."] }, tr: { updateNotes: ["Windows önizlemesi."] } };

test("writes each Windows architecture its own feed, signed installer and all", () => {
  const feed = windowsFeed(win, "arm64", winCopy, ["en", "tr"]);
  assert.equal(feed.currentRelease, "0.5.1");
  assert.deepEqual(feed.releases, [{ version: "0.5.1", updateTo: {
    version: "0.5.1", name: "Vunemi 0.5.1", pub_date: "2026-12-01T00:00:00Z", notes: "",
    url: "https://github.com/capitansuat/vunemi/releases/download/v0.5.1-windows.1/Vunemi-Setup-0.5.1-arm64.exe",
    sha256: "c".repeat(64), signature: `${"T".repeat(86)}==`,
  } }]);
  assert.equal(feed.sizeMb, 118);
  assert.deepEqual(feed.notes, { en: ["Windows preview."], tr: ["Windows önizlemesi."] });
  assert.equal(windowsFeed(win, "x64", winCopy, ["en"]).releases[0].updateTo.sha256, "b".repeat(64));
});

test("writes no Windows feed without a release, or for an architecture it doesn't have", () => {
  assert.equal(windowsFeed(null, "x64", winCopy, ["en"]), null);
  assert.equal(windowsFeed({ ...win, files: win.files.filter((f) => f.arch === "x64") }, "arm64", winCopy, ["en"]), null);
});

test("checks a Windows release before it is offered", () => {
  assert.doesNotThrow(() => checkWindowsRelease(win));
  const broken = (change) => () => checkWindowsRelease({ ...win, ...change });
  assert.throws(broken({ tag: "v0.5.1" }), /tag/);
  assert.throws(broken({ tag: "v0.5.2-windows.1" }), /tag/);
  assert.throws(broken({ version: "0.5.1-test1" }), /x\.y\.z/);
  assert.throws(broken({ files: [] }), /without files/);
  assert.throws(broken({ files: [win.files[0], win.files[0]] }), /Two Windows files/);
  assert.throws(broken({ files: [{ ...win.files[0], asset: "Vunemi-Setup-0.5.0-x64.exe" }] }), /does not match/);
  assert.throws(broken({ files: [{ ...win.files[0], sha256: "B".repeat(64) }] }), /SHA-256/);
  assert.throws(broken({ files: [{ ...win.files[0], signature: undefined }] }), /signature/);
  assert.throws(broken({ files: [{ ...win.files[0], arch: "ia32" }] }), /architecture/);
});

const SIG = `${"L".repeat(86)}==`;
const linux = (files) => ({
  tag: "v0.5.1-linux.1", version: "0.5.1", date: "2026-12-01", files,
  url(asset) { return `https://github.com/capitansuat/vunemi/releases/download/${this.tag}/${asset}`; },
});
const linuxFiles = () => [
  { kind: "appImage", arch: "x64", asset: "Vunemi-0.5.1-linux-x86_64.AppImage", sizeMb: 140, sha256: "a".repeat(64), signature: SIG },
  { kind: "deb", arch: "x64", asset: "Vunemi-0.5.1-linux-amd64.deb", sizeMb: 110, sha256: "b".repeat(64) },
  { kind: "appImage", arch: "arm64", asset: "Vunemi-0.5.1-linux-arm64.AppImage", sizeMb: 138, sha256: "c".repeat(64), signature: SIG },
  { kind: "deb", arch: "arm64", asset: "Vunemi-0.5.1-linux-arm64.deb", sizeMb: 108, sha256: "d".repeat(64) },
];
const linuxCopy = { en: { updateNotes: ["Linux preview."] }, tr: { updateNotes: ["Linux önizlemesi."] } };

test("writes each Linux architecture a feed for its signed AppImage, never the .deb", () => {
  const rel = linux(linuxFiles());
  const feed = linuxFeed(rel, "arm64", linuxCopy, ["en", "tr"]);
  assert.equal(feed.currentRelease, "0.5.1");
  assert.deepEqual(feed.releases[0].updateTo, {
    version: "0.5.1", name: "Vunemi 0.5.1", pub_date: "2026-12-01T00:00:00Z", notes: "",
    url: rel.url("Vunemi-0.5.1-linux-arm64.AppImage"), sha256: "c".repeat(64), signature: SIG,
  });
  assert.equal(feed.sizeMb, 138);
  assert.deepEqual(feed.notes, { en: ["Linux preview."], tr: ["Linux önizlemesi."] });
  assert.equal(linuxFeed(rel, "x64", linuxCopy, ["en"]).releases[0].updateTo.url, rel.url("Vunemi-0.5.1-linux-x86_64.AppImage"));
});

test("writes no Linux feed without a release, for a missing architecture, or for an unsigned AppImage", () => {
  assert.equal(linuxFeed(null, "x64", linuxCopy, ["en"]), null);
  assert.equal(linuxFeed(linux(linuxFiles().slice(0, 2)), "arm64", linuxCopy, ["en"]), null);
  const unsigned = linuxFiles().map(({ signature, ...f }) => f);
  assert.equal(linuxFeed(linux(unsigned), "x64", linuxCopy, ["en"]), null);
});

test("checks a Linux release before it is offered", () => {
  assert.doesNotThrow(() => checkLinuxRelease(linux(linuxFiles())));
  // The 0.2.6 preview: x64 only, before AppImages were signed.
  assert.doesNotThrow(() => checkLinuxRelease({ ...linux(linuxFiles().slice(0, 2).map(({ signature, ...f }) => f)), tag: "v0.5.1-linux.1" }));
  const broken = (change) => () => checkLinuxRelease(linux(linuxFiles().map((f, i) => (i === 0 ? change(f) : f))));
  assert.throws(broken((f) => ({ ...f, asset: "Vunemi-0.5.1-linux-amd64.AppImage" })), /does not match/);
  assert.throws(broken((f) => ({ ...f, arch: "riscv64" })), /architecture/);
  assert.throws(broken((f) => ({ ...f, kind: "rpm" })), /kind/);
  assert.throws(broken((f) => ({ ...f, sha256: "A".repeat(64) })), /SHA-256/);
  assert.throws(broken((f) => ({ ...f, sizeMb: 0 })), /size/);
  assert.throws(broken((f) => ({ ...f, signature: "short" })), /signature/);
  assert.throws(() => checkLinuxRelease(linux(linuxFiles().map((f, i) => (i === 1 ? { ...f, signature: SIG } : f)))), /only AppImages/);
  assert.throws(() => checkLinuxRelease(linux([...linuxFiles(), linuxFiles()[0]])), /Two/);
  assert.throws(() => checkLinuxRelease(linux(linuxFiles().slice(1))), /AppImage and a \.deb/);
  assert.throws(() => checkLinuxRelease({ ...linux(linuxFiles()), tag: "v0.5.0-linux.1" }), /tag/);
  assert.throws(() => checkLinuxRelease(linux([])), /without files/);
});
