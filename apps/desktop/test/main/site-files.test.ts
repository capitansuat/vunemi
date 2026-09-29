/**
 * What an offline site preview may read: files in the page's own folder,
 * and nothing that only looks as if it were.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewable, servedFile } from "../../src/main/site-files.js";

let base: string;
let site: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "vunemi-site-")));
  site = join(base, "site");
  mkdirSync(join(site, "css"), { recursive: true });
  writeFileSync(join(site, "index.html"), "<h1>hi</h1>");
  writeFileSync(join(site, "css", "my style.css"), "h1{}");
  writeFileSync(join(base, "secret.txt"), "private");
  symlinkSync(join(base, "secret.txt"), join(site, "link.txt"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("servedFile", () => {
  it("serves the page and what sits beside it", () => {
    expect(servedFile(site, "vunemi-preview://site/index.html")).toBe(join(site, "index.html"));
    expect(servedFile(site, "vunemi-preview://site/css/my%20style.css")).toBe(join(site, "css", "my style.css"));
  });

  it("refuses anything outside the folder, however it is asked for", () => {
    expect(servedFile(site, "vunemi-preview://site/../secret.txt")).toBeNull();
    expect(servedFile(site, "vunemi-preview://site/%2e%2e/secret.txt")).toBeNull();
    expect(servedFile(site, "vunemi-preview://site/..%2Fsecret.txt")).toBeNull();
    expect(servedFile(site, "vunemi-preview://site/link.txt")).toBeNull(); // a link pointing out
    expect(servedFile(site, `vunemi-preview://site/${encodeURIComponent(join(base, "secret.txt"))}`)).toBeNull();
    expect(servedFile(site, "vunemi-preview://other/index.html")).toBeNull();
    expect(servedFile(site, "https://site/index.html")).toBeNull();
    expect(servedFile(site, "vunemi-preview://site/css")).toBeNull(); // a folder
    expect(servedFile(site, "vunemi-preview://site/missing.html")).toBeNull();
  });
});

describe("previewable", () => {
  it("is only for web pages", () => {
    expect(previewable("/a/Index.HTML")).toBe(true);
    expect(previewable("/a/page.htm")).toBe(true);
    expect(previewable("/a/logo.svg")).toBe(false);
    expect(previewable("/a/run.command")).toBe(false);
  });
});
