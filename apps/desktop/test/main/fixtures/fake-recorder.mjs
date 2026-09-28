#!/usr/bin/env node
// Stands in for VunemiRecorder in tests: the same requests and replies, and
// a known pattern written to both files on start.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_RECORDER_MODE ?? "ok";
let dir = null;
let seconds = 0;

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
const fail = (id, error) => process.stdout.write(`${JSON.stringify({ id, ok: false, error })}\n`);

function stop() {
  if (!dir) return;
  // What a recording that ended writes last.
  appendFileSync(join(dir, "mic.pcm"), Buffer.from([9, 0]));
  dir = null;
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const { id, op, args = {} } = JSON.parse(line);
  if (op === "devices") return reply(id, { microphones: [{ id: "built-in", name: "MacBook Microphone", default: true }] });
  if (op === "start") {
    if (mode === "no-permission") return fail(id, "microphone");
    if (mode === "crash") setTimeout(() => process.exit(4), 50);
    dir = args.dir;
    // 16-bit little endian: 1, 2 and 3 for the microphone, -1 for the system.
    writeFileSync(join(dir, "mic.pcm"), Buffer.from([1, 0, 2, 0, 3, 0]), { mode: 0o600 });
    writeFileSync(join(dir, "system.pcm"), Buffer.from([0xff, 0xff]), { mode: 0o600 });
    seconds = 1.5;
    return reply(id, { started: true, microphone: args.microphone ?? null });
  }
  if (op === "levels") return reply(id, { me: 0.25, others: 0.5 });
  if (op === "stop") {
    stop();
    return reply(id, { stopped: true, seconds });
  }
  fail(id, `Unknown request: ${op}`);
});
lines.on("close", () => {
  stop();
  process.exit(0);
});
