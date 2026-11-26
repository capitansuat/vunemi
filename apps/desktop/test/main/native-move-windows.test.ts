/**
 * vunemi-move on Windows, the real program: what it moves, what it refuses,
 * and that no folder of either chain can be swapped while it moves.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gated, program, requestFor, run, runRaw } from "./move-request.js";

const windows = process.platform === "win32";
const bin = () => program("scripts/windows/build-move.ps1");
const place = () => mkdtempSync(join(tmpdir(), "vunemi-move-"));
const file = (path: string, text = "x") => (writeFileSync(path, text), path);

describe.skipIf(!windows)("vunemi-move on Windows", () => {
  it("is built", () => {
    expect(existsSync(bin())).toBe(true);
  });

  it("moves files of 0, 1, 64 and 1 048 577 bytes, keeping content and file index", () => {
    const dir = place();
    for (const size of [0, 1, 64, 1_048_577]) {
      const from = join(dir, `f${size}.bin`);
      writeFileSync(from, Buffer.alloc(size, 7));
      const inode = statSync(from, { bigint: true }).ino;
      const to = join(dir, `g${size}.bin`);
      expect(run(bin(), requestFor(from, to))).toEqual({ status: "moved" });
      expect(existsSync(from)).toBe(false);
      expect(statSync(to, { bigint: true }).ino).toBe(inode);
      expect(readFileSync(to)).toEqual(Buffer.alloc(size, 7));
    }
  });

  it("agrees with Node's stat on 20 fresh files", () => {
    const dir = place();
    let moved = 0;
    for (let i = 0; i < 20; i++) if (run(bin(), requestFor(file(join(dir, `n${i}.txt`), String(i)), join(dir, `m${i}.txt`))).status === "moved") moved++;
    expect(moved).toBe(20);
  });

  describe("refusals leave both sides as they were", () => {
    it("destination file, dangling junction or folder → destination-exists", () => {
      const dir = place();
      const from = file(join(dir, "a.txt"), "mine");
      const taken = file(join(dir, "b.txt"), "theirs");
      expect(run(bin(), requestFor(from, taken))).toEqual({ status: "not-moved", reasonCode: "destination-exists" });
      expect(readFileSync(taken, "utf8")).toBe("theirs");
      symlinkSync(join(dir, "nowhere"), join(dir, "junction"), "junction");
      expect(run(bin(), requestFor(from, join(dir, "junction")))).toEqual({ status: "not-moved", reasonCode: "destination-exists" });
      mkdirSync(join(dir, "folder"));
      expect(run(bin(), requestFor(from, join(dir, "folder")))).toEqual({ status: "not-moved", reasonCode: "destination-exists" });
      expect(readFileSync(from, "utf8")).toBe("mine");
    });

    it("source content changed, same size → source-changed", () => {
      const dir = place();
      const from = file(join(dir, "a.txt"), "aaaa");
      const request = requestFor(from, join(dir, "b.txt"));
      writeFileSync(from, "bbbb");
      expect(run(bin(), request)).toEqual({ status: "not-moved", reasonCode: "source-changed" });
    });

    it("a parent that isn't the approved one → parent-changed", () => {
      const dir = place();
      const request = requestFor(file(join(dir, "a.txt")), join(dir, "b.txt"));
      request.destinationParents.at(-1)!.inode = "1";
      expect(run(bin(), request)).toEqual({ status: "not-moved", reasonCode: "parent-changed" });
    });

    it("a junction in the destination's chain → parent-changed", () => {
      const dir = place();
      mkdirSync(join(dir, "real"));
      symlinkSync(join(dir, "real"), join(dir, "via"), "junction");
      const request = requestFor(file(join(dir, "a.txt")), join(dir, "via", "a.txt"));
      expect(run(bin(), request)).toEqual({ status: "not-moved", reasonCode: "parent-changed" });
      expect(readdirSync(join(dir, "real"))).toEqual([]);
    });

    it("source = destination → same-path", () => {
      const from = file(join(place(), "a.txt"));
      expect(run(bin(), requestFor(from, from))).toEqual({ status: "not-moved", reasonCode: "same-path" });
    });

    it("over 256 MB → source-not-bounded-regular-file", () => {
      const from = join(place(), "big.bin");
      const fd = openSync(from, "w");
      ftruncateSync(fd, 256 * 1024 * 1024 + 1);
      closeSync(fd);
      expect(run(bin(), requestFor(from, join(place(), "b.bin")))).toEqual({ status: "not-moved", reasonCode: "source-not-bounded-regular-file" });
    });

    it("device names, trailing dots, colons, / separators and drive-less paths → invalid-path", () => {
      const dir = place();
      const from = file(join(dir, "a.txt"));
      for (const to of [join(dir, "CON.txt"), join(dir, "name."), join(dir, "a:b"), `${dir}\\x/y.txt`, "\\\\server\\share\\a.txt"]) {
        expect(run(bin(), { ...requestFor(from, join(dir, "ok.txt")), destination: to })).toEqual({ status: "not-moved", reasonCode: "invalid-path" });
      }
      expect(existsSync(from)).toBe(true);
    });
  });

  it("bad requests → invalid-request", () => {
    const dir = place();
    const good = requestFor(file(join(dir, "a.txt")), join(dir, "b.txt"));
    const { sourceIdentity: _, ...missing } = good;
    for (const input of ["not json", JSON.stringify({ ...good, extra: 1 }), JSON.stringify(missing), JSON.stringify({ ...good, ownerId: "x".repeat(70_000) }), JSON.stringify({ ...good, operationId: "nope" })]) {
      expect(runRaw(bin(), `${input}\n`).reply).toEqual({ status: "not-moved", reasonCode: "invalid-request" });
    }
  });

  it("odd names move as names", () => {
    const dir = place();
    for (const name of ["-rf.txt", "a b c.txt", "çğış 🙂.txt"]) {
      const to = join(dir, `moved ${name}`);
      expect(run(bin(), requestFor(file(join(dir, name), name), to))).toEqual({ status: "moved" });
      expect(readFileSync(to, "utf8")).toBe(name);
    }
  });

  it("a destination made at the last moment is never replaced", async () => {
    const dir = place();
    const from = file(join(dir, "a.txt"), "mine");
    const to = join(dir, "b.txt");
    const gate = join(dir, "go");
    const move = gated(bin(), requestFor(from, to), gate);
    await move.at;
    file(to, "theirs");
    file(gate);
    expect(await move.done).toEqual({ status: "not-moved", reasonCode: "destination-exists" });
    expect(readFileSync(to, "utf8")).toBe("theirs");
  });

  it("while it moves, no folder of the chain can be renamed, and the file lands where approved", async () => {
    const dir = place();
    mkdirSync(join(dir, "in"));
    const from = file(join(dir, "a.txt"), "mine");
    const gate = join(dir, "go");
    const move = gated(bin(), requestFor(from, join(dir, "in", "a.txt")), gate);
    await move.at;
    expect(() => renameSync(join(dir, "in"), join(dir, "other"))).toThrow();
    file(gate);
    expect(await move.done).toEqual({ status: "moved" });
    expect(readFileSync(join(dir, "in", "a.txt"), "utf8")).toBe("mine");
  });

  it("a parent swapped for a junction over and over never sends a move elsewhere", async () => {
    const dir = place();
    mkdirSync(join(dir, "in"));
    mkdirSync(join(dir, "elsewhere"));
    const swapper = spawn(process.execPath, ["-e", `const f=require("fs"),p=require("path");const d=${JSON.stringify(dir)};const end=Date.now()+6000;while(Date.now()<end){try{f.renameSync(p.join(d,"in"),p.join(d,"real"));f.symlinkSync(p.join(d,"elsewhere"),p.join(d,"in"),"junction");f.rmdirSync(p.join(d,"in"));f.renameSync(p.join(d,"real"),p.join(d,"in"));}catch{}}`]);
    let moved = 0;
    for (let i = 0; i < 150; i++) {
      const from = file(join(dir, `f${i}.txt`), String(i));
      let request;
      try { request = requestFor(from, join(dir, "in", `f${i}.txt`)); } catch { continue; }
      if (run(bin(), request).status === "moved") moved++;
    }
    swapper.kill();
    await new Promise((resolve) => swapper.once("close", resolve));
    expect(readdirSync(join(dir, "elsewhere"))).toEqual([]);
    expect(moved).toBeGreaterThan(0);
  }, 120_000);
});
