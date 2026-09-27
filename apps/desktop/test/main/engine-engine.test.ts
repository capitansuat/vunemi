import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine, serverArgs, type EngineSnapshot, type EngineOptions } from "../../src/main/engine/engine.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-llama-server.mjs", import.meta.url));
const spec = { id: "m", path: "/models/m.gguf", context: 32_768 };
let engines: Engine[] = [];

beforeAll(() => chmodSync(FAKE, 0o755));
afterEach(async () => {
  await Promise.all(engines.map((e) => e.stop()));
  engines = [];
});

function make(over: Partial<EngineOptions> = {}): { engine: Engine; states: EngineSnapshot[] } {
  const states: EngineSnapshot[] = [];
  const engine = new Engine({ binary: FAKE, isBusy: () => false, onChange: (s) => states.push(s), ...over });
  engines.push(engine);
  return { engine, states };
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("serverArgs", () => {
  it("binds to this Mac only and asks for a key", () => {
    expect(serverArgs(spec, 5555, "k")).toEqual([
      "-m", "/models/m.gguf", "--host", "127.0.0.1", "--port", "5555", "--api-key", "k",
      "--jinja", "-c", "32768", "-fa", "on", "-ngl", "999", "--no-webui",
    ]);
  });
});

describe("the built-in engine", () => {
  it("starts the server and answers only with its key", async () => {
    const { engine, states } = make();
    const endpoint = await engine.ensure(spec);
    expect(engine.snapshot).toEqual({ state: "ready", model: "m" });
    expect(states.map((s) => s.state)).toEqual(["starting", "ready"]);
    const origin = endpoint.baseUrl.replace(/\/v1$/, "");
    expect((await fetch(`${origin}/args`)).status).toBe(401);
    const args = (await (await fetch(`${origin}/args`, { headers: { authorization: `Bearer ${endpoint.apiKey}` } })).json()) as string[];
    expect(args.slice(0, 4)).toEqual(["-m", "/models/m.gguf", "--host", "127.0.0.1"]);
    expect(engine.endpoint("m")).toEqual(endpoint);
    expect(engine.endpoint("other")).toBeNull();
  });

  it("waits for a slow start, and starts only once for two callers", async () => {
    const { engine } = make({ env: { ...process.env, FAKE_ENGINE_MODE: "slow" } });
    const [a, b] = await Promise.all([engine.ensure(spec), engine.ensure(spec)]);
    expect(a).toEqual(b);
  });

  it("loads the model again when its context length changes", async () => {
    const { engine } = make();
    const first = await engine.ensure(spec);
    expect(await engine.ensure(spec)).toEqual(first);
    const second = await engine.ensure({ ...spec, context: 65_536 });
    expect(second.baseUrl).not.toBe(first.baseUrl);
    const args = (await (await fetch(`${second.baseUrl.replace(/\/v1$/, "")}/args`, { headers: { authorization: `Bearer ${second.apiKey}` } })).json()) as string[];
    expect(args[args.indexOf("-c") + 1]).toBe("65536");
  });

  it("loads the vision part when there is one, and again when it changes", async () => {
    expect(serverArgs({ ...spec, projector: "/models/m.mmproj.gguf" }, 1, "k").slice(-2)).toEqual(["--mmproj", "/models/m.mmproj.gguf"]);
    expect(serverArgs(spec, 1, "k")).not.toContain("--mmproj");
    const { engine } = make();
    const first = await engine.ensure(spec);
    const second = await engine.ensure({ ...spec, projector: "/models/m.mmproj.gguf" });
    expect(second.baseUrl).not.toBe(first.baseUrl);
  });

  it("lets go of memory when idle", async () => {
    const { engine } = make({ idleMs: 150 });
    const endpoint = await engine.ensure(spec);
    await until(() => engine.snapshot.state === "idle");
    await expect(fetch(`${endpoint.baseUrl.replace(/\/v1$/, "")}/health`)).rejects.toThrow();
  });

  it("stays while there is work", async () => {
    const { engine } = make({ idleMs: 100, isBusy: () => true });
    await engine.ensure(spec);
    await new Promise((r) => setTimeout(r, 400));
    expect(engine.snapshot.state).toBe("ready");
  });

  it("restarts once after a crash, then gives up", async () => {
    const { engine } = make();
    const first = await engine.ensure(spec);
    const die = (e: typeof first) =>
      fetch(`${e.baseUrl.replace(/\/v1$/, "")}/die`, { headers: { authorization: `Bearer ${e.apiKey}` } });
    await die(first);
    await until(() => engine.snapshot.state === "ready" && engine.endpoint("m")?.apiKey !== first.apiKey);
    await die(engine.endpoint("m")!);
    await until(() => engine.snapshot.state === "failed");
  });

  it("says why it could not start", async () => {
    const { engine } = make({ env: { ...process.env, FAKE_ENGINE_MODE: "crash" } });
    await expect(engine.ensure(spec)).rejects.toThrow(/does not fit/);
    expect(engine.snapshot.state).toBe("failed");
    expect(engine.snapshot.error).toMatch(/does not fit/);
  });

  it("is absent when this build has no engine", async () => {
    const { engine } = make({ binary: null });
    expect(engine.snapshot.state).toBe("absent");
    await expect(engine.ensure(spec)).rejects.toThrow();
  });
});

describe("a server left behind", () => {
  it("is stopped when Vunemi starts again after a crash", async () => {
    const { mkdtempSync, writeFileSync, readFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { spawn } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "vunemi-pid-"));
    const pidFile = join(dir, "engine.pid");
    // A previous Vunemi's server, still running after Vunemi itself died.
    const orphan = spawn(FAKE, ["--port", "0", "--api-key", "k"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(pidFile, String(orphan.pid));
    const gone = new Promise((r) => orphan.once("exit", r));
    make({ pidFile });
    await gone;
    expect(existsSync(pidFile)).toBe(false);

    // And a running engine records itself, and forgets itself when stopped.
    const { engine } = make({ pidFile });
    await engine.ensure(spec);
    expect(Number(readFileSync(pidFile, "utf8"))).toBeGreaterThan(0);
    await engine.stop();
    expect(existsSync(pidFile)).toBe(false);
  });

  it("leaves an unrelated process alone", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "vunemi-pid-"));
    const pidFile = join(dir, "engine.pid");
    writeFileSync(pidFile, String(process.pid)); // the test runner, not an engine
    make({ pidFile });
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });
});
