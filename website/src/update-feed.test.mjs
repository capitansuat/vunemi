import assert from "node:assert/strict";
import { test } from "node:test";
import { updateFeed, windowsFeed } from "./update-feed.mjs";

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
