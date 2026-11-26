/** The Windows move journal's lock: the app's own exclusive open. */
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { windowsJournalAdmission } from "../../src/main/journal-windows.js";

const windows = process.platform === "win32";
const journal = () => join(mkdtempSync(join(tmpdir(), "journal-")), "file-move-operations.json");

describe.skipIf(!windows)("windowsJournalAdmission", () => {
  it("runs its body; a second admission meanwhile is busy; a third after it succeeds", async () => {
    const path = journal();
    let second: unknown;
    const first = await windowsJournalAdmission(path, async () => {
      second = await windowsJournalAdmission(path, () => "entered").catch((error: { reasonCode?: string }) => error.reasonCode);
      return "first";
    });
    expect(first).toBe("first");
    expect(second).toBe("journal-busy");
    await expect(windowsJournalAdmission(path, () => "third")).resolves.toBe("third");
  });

  it("a stop asked for before it starts is stopped", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(windowsJournalAdmission(journal(), () => "x", stop.signal)).rejects.toMatchObject({ reasonCode: "stopped" });
  });

  it("assertCurrent throws once the lock file is not the one held", async () => {
    const path = journal();
    await expect(
      windowsJournalAdmission(path, (assertCurrent) => {
        assertCurrent();
        // The held file can't be renamed (no sharing); a file put where it was would also count.
        try { renameSync(`${path}.lock`, `${path}.old`); } catch { writeFileSync(`${path}.probe`, "x"); throw Object.assign(new Error("held"), { reasonCode: "held" }); }
        assertCurrent();
      }),
    ).rejects.toMatchObject({ reasonCode: expect.stringMatching(/^(held|journal-unavailable)$/) });
  });
});
