/**
 * The sandbox an add-on's program runs in. These run the real sandbox-exec,
 * with macOS's own small programs standing in for an engine: what matters is
 * that the walls hold, whatever the program inside tries.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSandboxed, sandboxProfile } from "../../src/main/addons/sandbox.js";

const mac = process.platform === "darwin";
let base = "";
let home = "";
let job = "";
let engine = "";
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "vunemi-sandbox-")));
  home = join(base, "home");
  // Like the real thing: the job folder and the program live inside the home folder that is otherwise closed.
  job = join(home, "Library", "Vunemi", "jobs", "j1");
  engine = join(home, "Library", "Vunemi", "addons", "x");
  mkdirSync(job, { recursive: true });
  mkdirSync(engine, { recursive: true });
  mkdirSync(join(home, "Documents"), { recursive: true });
  writeFileSync(join(home, "Documents", "private.txt"), "private");
  writeFileSync(join(job, "in.txt"), "input");
  writeFileSync(join(engine, "data.txt"), "engine data");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const run = (program: string, args: string[], opts: { stdin?: string; timeoutMs?: number } = {}) =>
  runSandboxed(program, args, { job, engineDir: engine, home, ...opts });

describe.runIf(mac)("the add-on sandbox", () => {
  it("lets the program read its job folder and its own folder, and write only into the job", async () => {
    expect((await run("/bin/cat", [join(job, "in.txt")])).stdout).toBe("input");
    expect((await run("/bin/cat", [join(engine, "data.txt")])).stdout).toBe("engine data");
    expect((await run("/usr/bin/touch", [join(job, "out.txt")])).code).toBe(0);
    expect(existsSync(join(job, "out.txt"))).toBe(true);
  });

  it("keeps the rest of the home folder closed, to reading and to writing", async () => {
    const read = await run("/bin/cat", [join(home, "Documents", "private.txt")]);
    expect(read.code).not.toBe(0);
    expect(read.stdout).toBe("");
    expect((await run("/usr/bin/touch", [join(home, "Documents", "new.txt")])).code).not.toBe(0);
    expect(existsSync(join(home, "Documents", "new.txt"))).toBe(false);
    // Its own folder is for reading: a program cannot change what runs next time.
    expect((await run("/usr/bin/touch", [join(engine, "planted")])).code).not.toBe(0);
    expect((await run("/bin/ls", [join(home, "Documents")])).code).not.toBe(0);
  });

  it("gives the program no network, not even to this Mac", async () => {
    const server = createServer((socket) => socket.end("hello"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const out = await run("/usr/bin/nc", ["-w", "2", "127.0.0.1", String(port)]);
      expect(out.code).not.toBe(0);
      expect(out.stdout).toBe("");
    } finally {
      server.close();
    }
  });

  it("starts in the job folder with nothing of the user's in its environment", async () => {
    const out = await run("/usr/bin/env", []);
    expect(out.stdout).toContain(`HOME=${job}`);
    expect(out.stdout).not.toMatch(/USER=|SSH_|TOKEN|KEY=/);
    expect((await run("/bin/pwd", [])).stdout.trim()).toBe(job);
  });

  it("passes input, and stops a program that runs too long", async () => {
    expect((await run("/bin/cat", [], { stdin: "typed" })).stdout).toBe("typed");
    await expect(run("/bin/sleep", ["5"], { timeoutMs: 200 })).rejects.toThrow(/too long/);
  });
});

describe("the sandbox profile", () => {
  it("quotes folder names so a name cannot add a rule", () => {
    const profile = sandboxProfile({ home: '/Users/a"b', job: "/j", engineDir: "/e" });
    expect(profile).toContain('(subpath "/Users/a\\"b")');
    expect(profile).toContain("(deny network*)");
  });
});
