/**
 * A download names itself, and the name comes from the page. That makes it
 * the page's last chance to write somewhere it shouldn't.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { safeName, uniqueIn } from "../../src/main/embedded-browser.js";

describe("download names", () => {
  it("keeps a plain name", () => {
    expect(safeName("rapor.pdf")).toBe("rapor.pdf");
  });

  it("will not let a page climb out of the Downloads folder", () => {
    expect(safeName("../../.zshrc")).not.toContain("..");
    expect(safeName("../../.zshrc")).not.toContain("/");
    expect(safeName("/etc/passwd")).toBe("passwd");
    expect(safeName("a/b/c.txt")).toBe("c.txt");
  });

  it("will not write a hidden file", () => {
    expect(safeName(".bash_profile")).toBe("bash_profile");
    expect(safeName("...")).toBe("indirilen");
  });

  it("always produces something usable", () => {
    expect(safeName("")).toBe("indirilen");
    expect(safeName("x".repeat(400)).length).toBeLessThanOrEqual(120);
  });

  it("does not overwrite a file already in Downloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "vunemi-dl-"));
    try {
      writeFileSync(join(dir, "rapor.pdf"), "ilk");
      expect(uniqueIn(dir, "rapor.pdf")).toBe("rapor 2.pdf");
      writeFileSync(join(dir, "rapor 2.pdf"), "ikinci");
      expect(uniqueIn(dir, "rapor.pdf")).toBe("rapor 3.pdf");
      expect(uniqueIn(dir, "yeni.pdf")).toBe("yeni.pdf");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
