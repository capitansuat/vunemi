/**
 * The adapter between files_move and the native program that moves the file
 * on Windows and Linux: one JSON line in, one JSON line out. A fake program
 * (a Node script) stands in for the real one here.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AtomicMoveRequest } from "@vunemi/files";
import { programMoveAdapter } from "../../src/main/native-move.js";

const dir = mkdtempSync(join(tmpdir(), "native-move-"));

/** A fake vunemi-move: runs `body` with the request text in `input`. */
function fake(body: string): { program: string; programArgs: string[] } {
  const script = join(dir, `${randomUUID()}.cjs`);
  writeFileSync(script, `let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{${body}});`);
  return { program: process.execPath, programArgs: [script] };
}

const request = (): AtomicMoveRequest => ({
  operationId: randomUUID(),
  ownerId: "run-1",
  source: "/a/b.txt",
  destination: "/a/c.txt",
  sourceIdentity: { device: "1", inode: "2", size: "3", mtimeNs: "4", ctimeNs: "5", sha256: "0".repeat(64) },
  sourceParents: [],
  destinationParents: [],
  signal: new AbortController().signal,
  assertActive: () => {},
});

const reply = (json: string) => fake(`process.stdout.write(${JSON.stringify(json)}+"\\n")`);

describe("programMoveAdapter", () => {
  it("a reply {status:'moved'} is moved", async () => {
    const f = reply('{"status":"moved"}');
    await expect(programMoveAdapter(f.program, f).move(request())).resolves.toEqual({ status: "moved" });
  });

  it("not-moved and unknown keep a valid reasonCode", async () => {
    let f = reply('{"status":"not-moved","reasonCode":"destination-exists"}');
    await expect(programMoveAdapter(f.program, f).move(request())).resolves.toEqual({ status: "not-moved", reasonCode: "destination-exists" });
    f = reply('{"status":"unknown","reasonCode":"postcondition-mismatch"}');
    await expect(programMoveAdapter(f.program, f).move(request())).resolves.toEqual({ status: "unknown", reasonCode: "postcondition-mismatch" });
  });

  it("a reasonCode that isn't [a-z][a-z0-9-]{0,63} becomes unknown invalid-native-receipt", async () => {
    for (const bad of ['{"status":"not-moved","reasonCode":"Bad Code"}', '{"status":"not-moved"}', '{"status":"done"}', "not json"]) {
      const f = reply(bad);
      await expect(programMoveAdapter(f.program, f).move(request())).resolves.toEqual({ status: "unknown", reasonCode: "invalid-native-receipt" });
    }
  });

  it("a missing program is not-moved native-admission-refused", async () => {
    await expect(programMoveAdapter(join(dir, "no-such-program")).move(request())).resolves.toEqual({ status: "not-moved", reasonCode: "native-admission-refused" });
  });

  it("exit without a reply after the request was written is unknown native-transport-uncertain", async () => {
    const f = fake("process.exit(3)");
    await expect(programMoveAdapter(f.program, f).move(request())).resolves.toEqual({ status: "unknown", reasonCode: "native-transport-uncertain" });
  });

  it("a reply over 4096 bytes or two lines is unknown invalid-native-receipt", async () => {
    for (const out of [`{"status":"moved","x":"${"y".repeat(5000)}"}`, '{"status":"moved"}\n{"status":"moved"}']) {
      const f = reply(out);
      await expect(programMoveAdapter(f.program, f).move(request())).resolves.toEqual({ status: "unknown", reasonCode: "invalid-native-receipt" });
    }
  });

  it("no reply in timeoutMs kills it and is unknown native-transport-uncertain", async () => {
    const f = fake("setTimeout(()=>{},60000)");
    await expect(programMoveAdapter(f.program, { ...f, timeoutMs: 200 }).move(request())).resolves.toEqual({ status: "unknown", reasonCode: "native-transport-uncertain" });
  });

  it("an aborted signal before start is not-moved stopped and spawns nothing", async () => {
    const marker = join(dir, `${randomUUID()}.started`);
    const f = fake(`require("fs").writeFileSync(${JSON.stringify(marker)},"x");process.stdout.write('{"status":"moved"}\\n')`);
    const stop = new AbortController();
    stop.abort();
    await expect(programMoveAdapter(f.program, f).move({ ...request(), signal: stop.signal })).resolves.toEqual({ status: "not-moved", reasonCode: "stopped" });
    expect(() => readFileSync(marker)).toThrow();
  });

  it("once the request is written, an abort does not kill it: the reply decides", async () => {
    const f = fake(`setTimeout(()=>process.stdout.write('{"status":"moved"}\\n'),300)`);
    const stop = new AbortController();
    const moving = programMoveAdapter(f.program, f).move({ ...request(), signal: stop.signal });
    setTimeout(() => stop.abort(), 100);
    await expect(moving).resolves.toEqual({ status: "moved" });
  });

  it("the request on stdin has exactly the seven plan keys", async () => {
    const seen = join(dir, `${randomUUID()}.json`);
    const f = fake(`require("fs").writeFileSync(${JSON.stringify(seen)},input);process.stdout.write('{"status":"moved"}\\n')`);
    const asked = request();
    await programMoveAdapter(f.program, f).move(asked);
    const text = readFileSync(seen, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trim().includes("\n")).toBe(false);
    const sent = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["destination", "destinationParents", "operationId", "ownerId", "source", "sourceIdentity", "sourceParents"]);
    expect(sent.source).toBe(asked.source);
  });
});
