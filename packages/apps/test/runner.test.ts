import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AppScriptError, createRunner, friendlyError } from "../src/runner.js";
const onWindows = process.platform === "win32";

const FAKE = fileURLToPath(new URL("./fixtures/fake-osascript.mjs", import.meta.url));
beforeAll(() => chmodSync(FAKE, 0o755));

describe("the script runner", () => {
  // Windows: AppleScript is macOS only.
  it.skipIf(onWindows)("passes the template as the script and the input as one JSON argument", async () => {
    const run = createRunner({ osascript: FAKE });
    const template = 'function run(argv) { return "x" }';
    // Looks like script, stays data.
    const input = { app: "Notes", title: 'x"); do shell script("say hello' };
    const out = (await run(template, input)) as { args: string[] };
    expect(out.args).toEqual(["-l", "JavaScript", "-e", template, JSON.stringify(input)]);
  });

  // Windows: AppleScript is macOS only.
  it.skipIf(onWindows)("uses AppleScript when asked", async () => {
    const run = createRunner({ osascript: FAKE, language: "AppleScript" });
    const out = (await run("on run argv\nend run", { app: "Word" })) as { args: string[] };
    expect(out.args.slice(0, 2)).toEqual(["-l", "AppleScript"]);
  });

  // Windows: AppleScript is macOS only.
  it.skipIf(onWindows)("turns a refused Automation permission into a sentence and reports it", async () => {
    const onDenied = vi.fn();
    const run = createRunner({ osascript: FAKE, onDenied });
    const err = await run("t", { app: "Notes", scenario: "denied" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppScriptError);
    expect((err as AppScriptError).code).toBe(-1743);
    expect((err as Error).message).toContain("Notes");
    expect(onDenied).toHaveBeenCalledWith("Notes");
  });

  // Windows: AppleScript is macOS only.
  it.skipIf(onWindows)("reports success so a refusal can be forgotten", async () => {
    const onAllowed = vi.fn();
    await createRunner({ osascript: FAKE, onAllowed })("t", { app: "Notes" });
    expect(onAllowed).toHaveBeenCalledWith("Notes");
  });

  // Windows: AppleScript is macOS only.
  it.skipIf(onWindows)("stops a script that does not answer", async () => {
    const run = createRunner({ osascript: FAKE });
    const started = Date.now();
    const err = await run("t", { app: "Notes", scenario: "hang" }, { timeoutMs: 300 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppScriptError);
    expect((err as AppScriptError).code).toBe(-1712);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  // Windows: AppleScript is macOS only.
  it.skipIf(onWindows)("refuses output that is not JSON", async () => {
    await expect(createRunner({ osascript: FAKE })("t", { app: "Notes", scenario: "garbage" })).rejects.toBeInstanceOf(AppScriptError);
  });

  it("maps the codes people meet to plain words", () => {
    expect(friendlyError("execution error: Error: Can't get object. (-1728)", "Notes").code).toBe(-1728);
    expect(friendlyError("execution error: Application isn't running. (-600)", "Notes").code).toBe(-600);
    expect(friendlyError("something odd", "Notes").code).toBeNull();
  });
});
