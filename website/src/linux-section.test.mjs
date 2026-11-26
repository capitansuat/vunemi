import assert from "node:assert/strict";
import { test } from "node:test";
import { linuxSection } from "./pages.mjs";
import { linuxCopy } from "./linux-copy.mjs";

const SIG = `${"L".repeat(86)}==`;
const lin = {
  tag: "v0.5.1-linux.1", version: "0.5.1", date: "2026-12-01",
  files: [
    { kind: "appImage", arch: "x64", asset: "Vunemi-0.5.1-linux-x86_64.AppImage", sizeMb: 140, sha256: "a".repeat(64), signature: SIG },
    { kind: "deb", arch: "x64", asset: "Vunemi-0.5.1-linux-amd64.deb", sizeMb: 110, sha256: "b".repeat(64) },
    { kind: "appImage", arch: "arm64", asset: "Vunemi-0.5.1-linux-arm64.AppImage", sizeMb: 138, sha256: "c".repeat(64), signature: SIG },
    { kind: "deb", arch: "arm64", asset: "Vunemi-0.5.1-linux-arm64.deb", sizeMb: 108, sha256: "d".repeat(64) },
  ],
  url(asset) { return `https://github.com/capitansuat/vunemi/releases/download/${this.tag}/${asset}`; },
  get notes() { return `https://github.com/capitansuat/vunemi/releases/tag/${this.tag}`; },
};

test("shows the Linux preview in every language, with all four files and why only the AppImage updates itself", () => {
  for (const lang of Object.keys(linuxCopy)) {
    const html = linuxSection(lang, lin);
    const l = linuxCopy[lang];
    assert.ok(html.includes('id="linux"'), lang);
    assert.ok(!html.includes("undefined") && !html.includes("{deb}") && !html.includes("{arch}"), `${lang}: a placeholder or undefined in the page`);
    for (const f of lin.files) {
      assert.ok(html.includes(lin.url(f.asset)), `${lang}: ${f.asset} link`);
      assert.ok(html.includes(`${f.asset} · ${f.sizeMb} MB`), `${lang}: ${f.asset} size`);
      assert.ok(html.includes(`SHA-256 ${f.sha256}`), `${lang}: ${f.asset} checksum`);
    }
    for (const arch of ["x64", "arm64"]) assert.ok(html.includes(l.archNames[arch]), `${lang}: ${arch} named`);
    assert.ok(html.includes(l.update.replaceAll("'", "&#39;").replaceAll('"', "&quot;")) || html.includes(l.update), `${lang}: how it updates`);
  }
});

test("shows only the architectures a release has", () => {
  const x64Only = linuxSection("en", { ...lin, files: lin.files.slice(0, 2), url: lin.url, get notes() { return lin.notes; } });
  assert.ok(x64Only.includes("Vunemi-0.5.1-linux-amd64.deb"));
  assert.ok(!x64Only.includes("linux-arm64"), "no arm64 file");
});
