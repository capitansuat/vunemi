import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModel,
  parseModelSpec,
  ProviderError,
  ThinkSplitter,
  type StreamChunk,
} from "../src/provider.js";

/** A Response whose body arrives in exactly these pieces, split anywhere. */
function streamed(pieces: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const p of pieces) c.enqueue(enc.encode(p));
        c.close();
      },
    }),
    { status: 200 },
  );
}

function sse(events: unknown[]): string[] {
  return [...events.map((e) => `data: ${JSON.stringify(e)}\n\n`), "data: [DONE]\n\n"];
}

const req = () => ({ messages: [{ role: "user" as const, content: "hi" }], tools: [], signal: new AbortController().signal });

afterEach(() => vi.unstubAllGlobals());

describe("parseModelSpec", () => {
  it("keeps colons that belong to the model name", () => {
    expect(parseModelSpec("ollama:qwen3:32b")).toEqual({ kind: "ollama", model: "qwen3:32b" });
    expect(parseModelSpec("lmstudio:qwen/qwen3.6-35b-a3b")).toEqual({
      kind: "lmstudio",
      model: "qwen/qwen3.6-35b-a3b",
    });
  });

  it("rejects unknown providers and malformed specs", () => {
    expect(() => parseModelSpec("nope:x")).toThrow(/Unknown provider/);
    expect(() => parseModelSpec("lmstudio")).toThrow(/provider:model/);
    expect(() => parseModelSpec("lmstudio:")).toThrow(/provider:model/);
  });
});

describe("ThinkSplitter", () => {
  it("routes <think> blocks to thoughts even when tags are split across chunks", () => {
    const chunks: StreamChunk[] = [];
    const s = new ThinkSplitter((c) => chunks.push(c));
    let answer = "";
    for (const p of ["Hel", "lo <th", "ink>plan", "ning</thi", "nk> world"]) answer += s.push(p);
    answer += s.flush();

    expect(answer).toBe("Hello  world");
    expect(chunks.filter((c) => c.kind === "thought").map((c) => c.text).join("")).toBe("planning");
  });

  it("does not swallow a lone '<' that never becomes a tag", () => {
    const s = new ThinkSplitter(() => {});
    expect(s.push("a <") + s.flush()).toBe("a <");
  });
});

describe("OpenAI-compatible model", () => {
  it("streams text, reasoning, and reassembles fragmented tool calls", async () => {
    const events = [
      { choices: [{ delta: { reasoning_content: "I should check the time." } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "system_", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "time", arguments: '{"tz":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"UTC"}' } }] } }] },
      { choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } },
    ];
    // Split the SSE text at awkward byte positions to exercise line buffering.
    const text = sse(events).join("");
    const pieces = [text.slice(0, 17), text.slice(17, 90), text.slice(90)];
    const fetchMock = vi.fn(async () => streamed(pieces));
    vi.stubGlobal("fetch", fetchMock);

    const chunks: StreamChunk[] = [];
    const model = createModel("lmstudio:test-model");
    const result = await model.chat(req(), (c) => chunks.push(c));

    expect(result.toolCalls).toEqual([{ id: "call_a", name: "system_time", argumentsText: '{"tz":"UTC"}' }]);
    expect(result.usage.promptTokens).toBe(42);
    expect(result.usage.completionTokens).toBe(7);
    expect(chunks).toEqual([{ kind: "thought", text: "I should check the time." }]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "test-model", stream: true });
  });

  it("maps a refused connection to a ProviderError the UI can explain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const err = await createModel("lmstudio:x").chat(req(), () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe("unreachable");
  });

  it("surfaces HTTP errors with the server's message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("model not loaded", { status: 404 })));
    const err = (await createModel("lmstudio:x").chat(req(), () => {}).catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe("http");
    expect(err.message).toContain("model not loaded");
  });
});

describe("Ollama native model", () => {
  it("uses /api/chat, sets num_ctx, and serialises whole tool calls", async () => {
    const lines = [
      { message: { thinking: "hmm" } },
      { message: { content: "Checking." } },
      { message: { tool_calls: [{ function: { name: "system_time", arguments: { tz: "UTC" } } }] } },
      { done: true, prompt_eval_count: 10, eval_count: 5 },
    ].map((l) => `${JSON.stringify(l)}\n`);
    const fetchMock = vi.fn(async () => streamed(lines));
    vi.stubGlobal("fetch", fetchMock);

    const chunks: StreamChunk[] = [];
    const result = await createModel("ollama:qwen3:32b", { contextLength: 16_384 }).chat(req(), (c) => chunks.push(c));

    expect(result.text).toBe("Checking.");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ name: "system_time", argumentsText: '{"tz":"UTC"}' });
    expect(result.usage).toMatchObject({ promptTokens: 10, completionTokens: 5 });
    expect(chunks[0]).toEqual({ kind: "thought", text: "hmm" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/api/chat");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "qwen3:32b", options: { num_ctx: 16_384 } });
  });
});

describe("contextWindow", () => {
  it("is what Vunemi asked Ollama for", async () => {
    const model = createModel("ollama:qwen3:32b", { contextLength: 16_384 });
    expect(await model.contextWindow?.()).toBe(16_384);
  });

  it("reads the loaded context length from LM Studio", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("http://127.0.0.1:1234/api/v0/models");
      return new Response(JSON.stringify({ data: [
        { id: "other", loaded_context_length: 4096 },
        { id: "qwen/qwen3.6-35b-a3b", loaded_context_length: 65_536, max_context_length: 262_144 },
      ] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const model = createModel("lmstudio:qwen/qwen3.6-35b-a3b");
    expect(await model.contextWindow?.()).toBe(65_536);
  });

  it("reads n_ctx from llama.cpp", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("http://127.0.0.1:8080/props");
      return new Response(JSON.stringify({ default_generation_settings: { n_ctx: 8192 } }));
    }));
    expect(await createModel("llamacpp:any").contextWindow?.()).toBe(8192);
  });

  it("says null when the server can't tell", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await createModel("lmstudio:x").contextWindow?.()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    expect(await createModel("llamacpp:x").contextWindow?.()).toBeNull();
    expect(await createModel("openai:gpt").contextWindow?.()).toBeNull();
  });
});

describe("Vunemi's own engine", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("speaks llama.cpp's dialect and sends its key when it asks for the window", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ default_generation_settings: { n_ctx: 65_536 } });
    }));
    const model = createModel("tenami:qwen3.5-4b-ud-q4_k_xl", { baseUrl: "http://127.0.0.1:5555/v1", apiKey: "k" });
    expect(await model.contextWindow!()).toBe(65_536);
    expect(seen).toEqual([{ url: "http://127.0.0.1:5555/props", auth: "Bearer k" }]);
  });

  it("is a known provider", () => {
    expect(parseModelSpec("tenami:qwen3.5-4b-ud-q4_k_xl")).toEqual({ kind: "tenami", model: "qwen3.5-4b-ud-q4_k_xl" });
  });
});

describe("images", () => {
  const withImage = () => ({
    messages: [{ role: "user" as const, content: "what is this?", images: [{ mime: "image/jpeg" as const, base64: "AAA" }] }],
    tools: [],
    signal: new AbortController().signal,
  });

  it("go to OpenAI-style servers as image parts beside the text", async () => {
    const fetchMock = vi.fn(async () => streamed(sse([{ choices: [{ delta: { content: "a cat" } }] }])));
    vi.stubGlobal("fetch", fetchMock);
    await createModel("lmstudio:m").chat(withImage(), () => {});
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA" } },
      ],
    });
  });

  it("leave a plain message as a string", async () => {
    const fetchMock = vi.fn(async () => streamed(sse([{ choices: [{ delta: { content: "hi" } }] }])));
    vi.stubGlobal("fetch", fetchMock);
    await createModel("lmstudio:m").chat(req(), () => {});
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  it("go to Ollama in its images field", async () => {
    const fetchMock = vi.fn(async () => streamed([`${JSON.stringify({ done: true })}\n`]));
    vi.stubGlobal("fetch", fetchMock);
    await createModel("ollama:llava").chat(withImage(), () => {});
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[0]).toEqual({ role: "user", content: "what is this?", images: ["AAA"] });
  });
});

describe("vision", () => {
  it("is read from llama.cpp's props, with the engine's key", async () => {
    const seen: (string | null)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ modalities: { vision: true } });
    }));
    expect(await createModel("tenami:m", { baseUrl: "http://127.0.0.1:5555/v1", apiKey: "k" }).vision!()).toBe(true);
    expect(seen).toEqual(["Bearer k"]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ modalities: { vision: false } })));
    expect(await createModel("llamacpp:m").vision!()).toBe(false);
  });

  it("is read from LM Studio's model list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ id: "m", type: "vlm" }, { id: "t", type: "llm" }] })));
    expect(await createModel("lmstudio:m").vision!()).toBe(true);
    expect(await createModel("lmstudio:t").vision!()).toBe(false);
  });

  it("is read from Ollama's capabilities", async () => {
    const fetchMock = vi.fn(async () => Response.json({ capabilities: ["completion", "vision", "tools"] }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await createModel("ollama:gemma3").vision!()).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/api/show");
    expect(JSON.parse(init.body as string)).toEqual({ model: "gemma3" });
  });

  it("is assumed for cloud models and denied when the server does not answer", async () => {
    expect(await createModel("openai:gpt").vision!()).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await createModel("lmstudio:m").vision!()).toBe(false);
  });
});
