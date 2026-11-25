import assert from "node:assert/strict";
import { test } from "node:test";
import { windowsSection } from "./pages.mjs";
import { windowsCopy } from "./windows-copy.mjs";

const win = {
  tag: "v0.5.1-windows.1", version: "0.5.1", date: "2026-12-01",
  files: [
    { arch: "x64", asset: "Vunemi-Setup-0.5.1-x64.exe", sizeMb: 120, sha256: "b".repeat(64), signature: `${"S".repeat(86)}==` },
    { arch: "arm64", asset: "Vunemi-Setup-0.5.1-arm64.exe", sizeMb: 118, sha256: "c".repeat(64), signature: `${"T".repeat(86)}==` },
  ],
  url(asset) { return `https://github.com/capitansuat/vunemi/releases/download/${this.tag}/${asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/${this.tag}`; },
};

test("shows the Windows preview in every language, with both installers and the SmartScreen steps", () => {
  for (const lang of Object.keys(windowsCopy)) {
    const html = windowsSection(lang, win);
    const w = windowsCopy[lang];
    assert.ok(html.includes('id="windows"'), lang);
    assert.ok(!html.includes("undefined"), `${lang}: undefined in the page`);
    for (const f of win.files) {
      assert.ok(html.includes(win.url(f.asset)), `${lang}: ${f.arch} link`);
      assert.ok(html.includes(`${f.asset} · ${f.sizeMb} MB`), `${lang}: ${f.arch} size`);
      assert.ok(html.includes(`SHA-256 ${f.sha256}`), `${lang}: ${f.arch} checksum`);
    }
    assert.equal(html.match(/<li>/g)?.length >= w.smartSteps.length, true, lang);
  }
});

test("shows only the installers a release has, and nothing without a release", () => {
  const armOnly = windowsSection("en", { ...win, files: [win.files[1]], url: win.url, get notes() { return win.notes; } });
  assert.ok(armOnly.includes(windowsCopy.en.arm64Button));
  assert.ok(!armOnly.includes(windowsCopy.en.x64Button));
  assert.equal(windowsSection("en", null), "");
});
