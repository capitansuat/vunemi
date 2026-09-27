import { afterEach, describe, expect, it, vi } from "vitest";
import { createModel } from "@vunemi/agent-core";
import { checkAgentModel, DEFAULT_MODEL_SETTINGS, modelConfig, probeProviders, validateModelSettings } from "../../src/main/providers.js";

afterEach(() => vi.unstubAllGlobals());

describe("local model sources", () => {
  it("uses saved loopback endpoints for discovery and agent calls", async () => {
    const settings = validateModelSettings({
      endpoints: { lmstudio: "http://localhost:4321", ollama: "http://127.0.0.1:11435/", llamacpp: "http://127.0.0.1:8081/v1/" },
      ollamaContextLength: 16_384,
    });
    expect(settings.endpoints.lmstudio).toBe("http://localhost:4321/v1");
    expect(settings.endpoints.ollama).toBe("http://127.0.0.1:11435");
    expect(modelConfig("ollama:qwen3:32b", settings)).toEqual({ baseUrl: "http://127.0.0.1:11435", contextLength: 16_384 });
    expect(modelConfig("lmstudio:test", settings).baseUrl).toBe("http://localhost:4321/v1");

    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return Response.json(url.endsWith("/api/tags") ? { models: [{ name: "qwen3:32b" }] } : { data: [{ id: "test" }] });
    }));
    const found = await probeProviders(settings);
    expect(urls).toEqual([
      "http://localhost:4321/v1/models",
      "http://127.0.0.1:11435/api/tags",
      "http://127.0.0.1:8081/v1/models",
    ]);
    expect(found.every((item) => item.reachable && item.models.length === 1)).toBe(true);
  });

  it("rejects remote or credential-bearing endpoints and cloud model specs", () => {
    for (const bad of ["https://example.com/v1", "http://192.168.1.4:1234/v1", "http://user:pass@127.0.0.1:1234/v1", "http://127.0.0.1:1234/v1?key=x"]) {
      expect(() => validateModelSettings({ ...DEFAULT_MODEL_SETTINGS, endpoints: { ...DEFAULT_MODEL_SETTINGS.endpoints, lmstudio: bad } })).toThrow();
    }
    expect(() => modelConfig("openai:gpt-test", DEFAULT_MODEL_SETTINGS)).toThrow(/Yalnızca/);
  });

  it("sends inference to the configured local port", async () => {
    const settings = validateModelSettings({ ...DEFAULT_MODEL_SETTINGS, endpoints: {
      ...DEFAULT_MODEL_SETTINGS.endpoints, lmstudio: "http://127.0.0.1:4321/v1",
    } });
    const fetchMock = vi.fn(async (_url: string) => new Response("data: {\"choices\":[{\"delta\":{\"content\":\"Merhaba\"}}]}\n\ndata: [DONE]\n\n"));
    vi.stubGlobal("fetch", fetchMock);
    const reply = await createModel("lmstudio:test", modelConfig("lmstudio:test", settings)).chat({
      messages: [{ role: "user", content: "Selam" }], tools: [], signal: new AbortController().signal,
    }, () => {});
    expect(reply.text).toBe("Merhaba");
    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:4321/v1/chat/completions");
  });

  it("checks a real tool call without executing a tool", async () => {
    const calls = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "vunemi_probe", arguments: '{"token":"hazir"}' } }] } }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } },
    ];
    const body = [...calls.map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"].join("");
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(body));
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkAgentModel("lmstudio:test", DEFAULT_MODEL_SETTINGS);
    expect(result).toMatchObject({ toolCalled: true, promptTokens: 12, completionTokens: 5 });
    const request = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { tools: { function: { name: string } }[] };
    expect(request.tools[0]?.function.name).toBe("vunemi_probe");
    expect(() => modelConfig("openai:remote", DEFAULT_MODEL_SETTINGS)).toThrow();
  });
});

describe.skipIf(!process.env.VUNEMI_LIVE_MODEL)("live local model check", () => {
  it("observes a harmless tool call from the selected model", { timeout: 120_000 }, async () => {
    const result = await checkAgentModel(process.env.VUNEMI_LIVE_MODEL!, DEFAULT_MODEL_SETTINGS);
    expect(result.toolCalled).toBe(true);
  });
});

describe("Vunemi's own engine as a source", () => {
  it("points a vunemi model at the running engine, with its key", () => {
    const endpoint = { baseUrl: "http://127.0.0.1:5555/v1", apiKey: "k" };
    expect(modelConfig("vunemi:m", DEFAULT_MODEL_SETTINGS, () => endpoint)).toMatchObject({ baseUrl: endpoint.baseUrl, apiKey: "k" });
    // Not running: an address that refuses, so the task fails as unreachable.
    expect(modelConfig("vunemi:m", DEFAULT_MODEL_SETTINGS, () => null).baseUrl).toBe("http://127.0.0.1:1/v1");
  });

  it("lists downloaded models without asking a server", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const found = await probeProviders(DEFAULT_MODEL_SETTINGS, ["vunemi:m"]);
    expect(found.find((p) => p.kind === "vunemi")).toEqual({ kind: "vunemi", baseUrl: "", reachable: true, models: ["vunemi:m"] });
    expect((await probeProviders(DEFAULT_MODEL_SETTINGS, [])).some((p) => p.kind === "vunemi")).toBe(false);
  });
});
