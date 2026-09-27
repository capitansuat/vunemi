/**
 * The speech engine that comes with the app, and the model it downloads:
 * pinned, into Vunemi's own folder, and only when the user asks.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { download } from "../../src/main/engine/download.js";
import { Voice, VOICE_MODEL, WHISPER_TAG, whisperBinary } from "../../src/main/voice.js";

let dir = "";
let server = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-voice-"));
  server = join(dir, "whisper-server");
  writeFileSync(server, "#!/bin/sh\n");
  delete process.env.OCAK_WHISPER_MODEL;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the built-in speech engine", () => {
  it("is found inside the app, or in a development run's build cache", () => {
    const resources = join(dir, "Resources");
    mkdirSync(resources);
    writeFileSync(join(resources, "whisper-server"), "");
    expect(whisperBinary({ packaged: true, resourcesPath: resources, home: dir })).toBe(join(resources, "whisper-server"));
    expect(whisperBinary({ packaged: false, resourcesPath: resources, home: dir })).toBeNull();
    const cache = join(dir, ".ocak-build", "whisper-cache", WHISPER_TAG);
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "whisper-server"), "");
    expect(whisperBinary({ packaged: false, resourcesPath: resources, home: dir })).toBe(join(cache, "whisper-server"));
  });
});

describe("the speech model", () => {
  it("is offered, pinned and checked, when there is a server but no model", () => {
    const voice = new Voice(dir, { builtIn: server, shared: false });
    const status = voice.status();
    expect(status.canHear).toBe(false);
    expect(status.download).toEqual({ bytes: VOICE_MODEL.size });
    expect(VOICE_MODEL.file).toMatch(/^ggml-[\w.-]+\.bin$/);
    expect(VOICE_MODEL.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(VOICE_MODEL.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("downloads into Vunemi's own models folder, says how it is going, then hears", async () => {
    const seen: (number | undefined)[] = [];
    const fake: typeof download = async (src, folder, opts) => {
      expect(src).toBe(VOICE_MODEL);
      expect(folder).toBe(join(dir, "models"));
      opts.onProgress?.({ received: 100, total: src.size, bytesPerSecond: 1 });
      mkdirSync(folder, { recursive: true });
      const path = join(folder, src.file);
      writeFileSync(path, "");
      return path;
    };
    const voice = new Voice(dir, { builtIn: server, shared: false, download: fake, onChange: (s) => seen.push(s.downloading?.received) });
    const status = await voice.download();
    expect(status.canHear).toBe(true);
    expect(status.engine).toContain("large-v3-turbo-q5_0");
    expect(seen).toContain(100);
    // The last word is that it has finished.
    expect(seen.at(-1)).toBeUndefined();
  });

  it("is one download however often the button is pressed", async () => {
    let calls = 0;
    let finish: (path: string) => void = () => {};
    const fake: typeof download = () => {
      calls++;
      return new Promise((resolve) => { finish = resolve; });
    };
    const voice = new Voice(dir, { builtIn: server, shared: false, download: fake });
    const first = voice.download();
    const second = voice.download();
    mkdirSync(join(dir, "models"));
    writeFileSync(join(dir, "models", VOICE_MODEL.file), "");
    finish(join(dir, "models", VOICE_MODEL.file));
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });

  it("stops when asked, and is offered again", async () => {
    const fake: typeof download = (_src, _folder, opts) =>
      new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(new Error("cancelled"))));
    const voice = new Voice(dir, { builtIn: server, shared: false, download: fake });
    const running = voice.download();
    expect(voice.status().downloading).toBeDefined();
    voice.cancelDownload();
    await expect(running).rejects.toThrow("cancelled");
    expect(voice.status().downloading).toBeUndefined();
    expect(voice.status().download).toBeDefined();
  });
});
