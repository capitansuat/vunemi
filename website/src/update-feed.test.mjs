import assert from "node:assert/strict";
import { test } from "node:test";
import { updateFeed } from "./update-feed.mjs";

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
