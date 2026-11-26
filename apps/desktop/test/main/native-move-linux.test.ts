/**
 * vunemi-move on Linux, the real program: what it moves, what it refuses, and
 * that a folder swapped for a link at the last moment can't redirect it.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withJournalAdmission } from "@vunemi/mac";
import { gated, identityOf, program, requestFor, run, runRaw } from "./move-request.js";

const linux = process.platform === "linux";
const bin = () => program("scripts/build-move-linux.sh");
const place = () => mkdtempSync(join(tmpdir(), "vunemi-move-"));
const file = (path: string, text = "x") => (writeFileSync(path, text), path);

describe.skipIf(!linux)("vunemi-move on Linux", () => {
  it("is built", () => {
    expect(existsSync(bin())).toBe(true);
  });

  it("moves files of 0, 1, 64 and 1 048 577 bytes, keeping content and inode", () => {
    const dir = place();
    for (const size of [0, 1, 64, 1_048_577]) {
      const from = join(dir, `f${size}.bin`);
      writeFileSync(from, Buffer.alloc(size, 7));
      const inode = statSync(from).ino;
      const to = join(dir, `g${size}.bin`);
      expect(run(bin(), requestFor(from, to))).toEqual({ status: "moved" });
      expect(existsSync(from)).toBe(false);
      expect(statSync(to).ino).toBe(inode);
      expect(readFileSync(to)).toEqual(Buffer.alloc(size, 7));
    }
  });

  describe("refusals leave both sides as they were", () => {
    it("destination file, dangling link or folder → destination-exists", () => {
      const dir = place();
      const from = file(join(dir, "a.txt"), "mine");
      const taken = file(join(dir, "b.txt"), "theirs");
      const request = requestFor(from, taken);
      expect(run(bin(), request)).toEqual({ status: "not-moved", reasonCode: "destination-exists" });
      expect(readFileSync(taken, "utf8")).toBe("theirs");
      symlinkSync(join(dir, "nowhere"), join(dir, "link.txt"));
      expect(run(bin(), requestFor(from, join(dir, "link.txt")))).toEqual({ status: "not-moved", reasonCode: "destination-exists" });
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
      expect(existsSync(join(dir, "b.txt"))).toBe(false);
    });

    it("source is a link → source-unavailable", () => {
      const dir = place();
      const real = file(join(dir, "real.txt"));
      symlinkSync(real, join(dir, "link.txt"));
      const request = requestFor(real, join(dir, "b.txt"), { source: join(dir, "link.txt") });
      expect(run(bin(), request)).toEqual({ status: "not-moved", reasonCode: "source-unavailable" });
    });

    it("a parent that isn't the approved one → parent-changed", () => {
      const dir = place();
      const from = file(join(dir, "a.txt"));
      const request = requestFor(from, join(dir, "b.txt"));
      request.destinationParents.at(-1)!.inode = "1";
      expect(run(bin(), request)).toEqual({ status: "not-moved", reasonCode: "parent-changed" });
    });

    it("another volume → cross-volume-unsupported", () => {
      const shm = mkdtempSync("/dev/shm/vunemi-move-");
      const from = file(join(shm, "a.txt"));
      expect(run(bin(), requestFor(from, join(place(), "b.txt")))).toEqual({ status: "not-moved", reasonCode: "cross-volume-unsupported" });
      expect(existsSync(from)).toBe(true);
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
  });

  it("bad requests → invalid-request", () => {
    const dir = place();
    const from = file(join(dir, "a.txt"));
    const good = requestFor(from, join(dir, "b.txt"));
    const { sourceIdentity: _, ...missing } = good;
    for (const input of [
      "not json",
      JSON.stringify({ ...good, extra: 1 }),
      JSON.stringify(missing),
      JSON.stringify({ ...good, destination: `/${"d".repeat(4100)}` }),
      JSON.stringify({ ...good, ownerId: "x".repeat(70_000) }),
      JSON.stringify({ ...good, operationId: "not-a-uuid" }),
    ]) {
      expect(runRaw(bin(), `${input}\n`).reply).toEqual({ status: "not-moved", reasonCode: "invalid-request" });
    }
    // A relative path is refused as a path, as the Mac helper's movePath does.
    expect(run(bin(), { ...good, destination: "b.txt" })).toEqual({ status: "not-moved", reasonCode: "invalid-path" });
    expect(existsSync(from)).toBe(true);
  });

  it("odd names move as names, never as options", () => {
    const dir = place();
    for (const name of ["-rf.txt", 'a "b" c.txt', "çğış 🙂.txt"]) {
      const from = file(join(dir, name), name);
      const to = join(dir, `moved ${name}`);
      expect(run(bin(), requestFor(from, to))).toEqual({ status: "moved" });
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
    expect(readFileSync(from, "utf8")).toBe("mine");
  });

  it("a folder swapped for a link at the last moment can't redirect the move", async () => {
    const dir = place();
    mkdirSync(join(dir, "in"));
    mkdirSync(join(dir, "elsewhere"));
    const from = file(join(dir, "a.txt"), "mine");
    const gate = join(dir, "go");
    const move = gated(bin(), requestFor(from, join(dir, "in", "a.txt")), gate);
    await move.at;
    renameSync(join(dir, "in"), join(dir, "real-in"));
    symlinkSync(join(dir, "elsewhere"), join(dir, "in"));
    file(gate);
    const reply = await move.done;
    expect(existsSync(join(dir, "elsewhere", "a.txt"))).toBe(false);
    expect(existsSync(join(dir, "real-in", "a.txt")) || existsSync(from)).toBe(true);
    expect(reply.status).not.toBe("moved");
  });

  it("a parent swapped for a link over and over never sends a move elsewhere", async () => {
    const dir = place();
    mkdirSync(join(dir, "in"));
    mkdirSync(join(dir, "elsewhere"));
    // Another process swaps "in" for a link to "elsewhere" and back, as fast as it can.
    const swapper = spawn(process.execPath, ["-e", `const f=require("fs"),p=require("path");const d=${JSON.stringify(dir)};const end=Date.now()+4000;while(Date.now()<end){try{f.renameSync(p.join(d,"in"),p.join(d,"real"));f.symlinkSync(p.join(d,"elsewhere"),p.join(d,"in"));f.unlinkSync(p.join(d,"in"));f.renameSync(p.join(d,"real"),p.join(d,"in"));}catch{}}`]);
    let moved = 0;
    for (let i = 0; i < 300; i++) {
      const from = file(join(dir, `f${i}.txt`), String(i));
      let request;
      try { request = requestFor(from, join(dir, "in", `f${i}.txt`)); } catch { continue; }
      if (run(bin(), request).status === "moved") moved++;
    }
    swapper.kill();
    await new Promise((resolve) => swapper.once("close", resolve));
    expect(readdirSync(join(dir, "elsewhere"))).toEqual([]);
    expect(moved).toBeGreaterThan(0);
  }, 60_000);

  describe("the journal lock", () => {
    const journal = () => join(place(), "file-move-operations.json");

    it("is taken, and a second admission meanwhile is busy", async () => {
      const path = journal();
      let second: unknown;
      await withJournalAdmission(bin(), path, async () => {
        second = await withJournalAdmission(bin(), path, () => "entered").catch((error: { reasonCode?: string }) => error.reasonCode);
      });
      expect(second).toBe("journal-busy");
      await expect(withJournalAdmission(bin(), path, () => "again")).resolves.toBe("again");
    });

    it("refuses a folder or a lock file others can read", () => {
      const dir = place();
      const fd = openSync(dir, "r");
      let r = spawnSync(bin(), ["--journal-lock-fd", "3"], { stdio: ["ignore", "pipe", "pipe", fd], encoding: "utf8" });
      closeSync(fd);
      expect(r.status).toBe(64);
      expect(JSON.parse(r.stdout)).toEqual({ protocol: 1, locked: false, reason: "invalid-fd" });
      const lock = join(dir, "x.lock");
      const open = openSync(lock, "w", 0o644);
      r = spawnSync(bin(), ["--journal-lock-fd", "3"], { stdio: ["ignore", "pipe", "pipe", open], encoding: "utf8" });
      closeSync(open);
      expect(r.status).toBe(64);
    });
  });

  it("identity helper agrees with the request shape", () => {
    expect(Object.keys(identityOf(file(join(place(), "z"))))).toEqual(["device", "inode", "size", "mtimeNs", "ctimeNs", "sha256"]);
  });
});
