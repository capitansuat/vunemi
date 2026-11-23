/**
 * The path forms Windows would read differently from how they are written.
 * Pure string rules, so they are tested on every system.
 */
import { describe, expect, it } from "vitest";
import { windowsPathProblem } from "../src/windows-paths.js";

describe("Windows path forms", () => {
  it("refuses network, device, drive-relative and stream paths", () => {
    for (const p of ["\\\\server\\share\\a.txt", "\\\\?\\C:\\x\\a.txt", "\\\\.\\PhysicalDrive0", "C:a.txt", "C:\\a\\b.txt:secret"])
      expect(windowsPathProblem(p), p).toBe("unsupported");
  });

  it("refuses device names and names Windows would change", () => {
    for (const p of ["C:\\a\\CON", "C:\\a\\nul.txt", "C:\\a\\com1.log", "C:\\a\\LPT9", "C:\\a\\con.d\\x.txt", "C:\\a\\name.", "C:\\a\\name ", "C:\\a\\dir.\\x.txt", "C:\\a\\COM¹", "C:\\a\\aux .txt"])
      expect(windowsPathProblem(p), p).toBe("unsupported");
  });

  it("accepts ordinary paths", () => {
    for (const p of ["C:\\Users\\deneme\\Documents\\a.txt", "D:\\Proje\\console.txt", "C:\\a\\connect.md", "C:\\a\\.gizli\\x", "C:\\a\\b..c.txt", "C:\\a\\..\\b.txt", "notlar.txt", "Belgeler\\rapor.txt"])
      expect(windowsPathProblem(p), p).toBeNull();
  });
});
