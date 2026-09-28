/**
 * The recorder client against a stand-in that speaks the same protocol. The
 * real recorder is checked live, through the packaged app, because macOS asks
 * the app that starts it for the microphone and system audio.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Recorder, recorderBinary } from "../../src/main/meetings/recorder.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-recorder.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

let dir: string;
let recorder: Recorder | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-recorder-"));
  delete process.env.FAKE_RECORDER_MODE;
});

afterEach(() => {
  recorder?.dispose();
  recorder = null;
  rmSync(dir, { recursive: true, force: true });
});

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(check()).toBe(true);
};

describe("recorderBinary", () => {
  it("finds nothing where nothing was built", () => {
    expect(recorderBinary({ packaged: true, resourcesPath: dir, repo: dir })).toBeNull();
    expect(recorderBinary({ packaged: false, resourcesPath: dir, repo: dir })).toBeNull();
  });
});

describe("Recorder", () => {
  it("lists microphones, records to both files, reports levels and stops", async () => {
    recorder = new Recorder(FAKE);
    expect(recorder.available()).toBe(true);
    expect(await recorder.devices()).toEqual([{ id: "built-in", name: "MacBook Microphone", default: true }]);
    await recorder.start(dir, "built-in");
    expect([...readFileSync(join(dir, "mic.pcm"))]).toEqual([1, 0, 2, 0, 3, 0]);
    expect(statSync(join(dir, "system.pcm")).mode & 0o777).toBe(0o600);
    expect(await recorder.levels()).toEqual({ me: 0.25, others: 0.5 });
    expect(await recorder.stop()).toEqual({ seconds: 1.5 });
  });

  it("rejects a start the recorder refuses, with its reason", async () => {
    process.env.FAKE_RECORDER_MODE = "no-permission";
    recorder = new Recorder(FAKE);
    await expect(recorder.start(dir)).rejects.toThrow("microphone");
  });

  it("says it is unavailable when there is no recorder", async () => {
    recorder = new Recorder(null);
    expect(recorder.available()).toBe(false);
    await expect(recorder.devices()).rejects.toThrow("unavailable");
  });

  it("stops a recording when it is disposed, keeping what was written", async () => {
    recorder = new Recorder(FAKE);
    await recorder.start(dir);
    recorder.dispose();
    await waitFor(() => readFileSync(join(dir, "mic.pcm")).length === 8);
  });

  it("hears of a recorder that ended on its own", async () => {
    process.env.FAKE_RECORDER_MODE = "crash";
    const exits: (number | null)[] = [];
    recorder = new Recorder(FAKE, (code) => exits.push(code));
    await recorder.start(dir);
    await waitFor(() => exits.length === 1);
    expect(exits).toEqual([4]);
    // The next call starts a new one.
    delete process.env.FAKE_RECORDER_MODE;
    expect(await recorder.levels()).toEqual({ me: 0.25, others: 0.5 });
  });
});
