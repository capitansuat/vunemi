/**
 * MCP, tested against a real child process speaking the real protocol.
 *
 * The protocol part matters, but the part that matters more is the trust
 * boundary: a server describes its own tools, and this checks that its
 * description never decides what may happen without asking.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@ocak/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { cappedText, createMcpConnector, localIO, MAX_REPLY_BYTES, McpClient, type McpIO, type McpTool } from "../src/index.js";

let dir = "";

const ctx = (): ToolContext => ({
  signal: new AbortController().signal,
  handoff: async () => true,
  offerUndo: () => {},
  attach: () => {},
});

/** A stdio MCP server in a few lines of Node. */
function server(tools: McpTool[], opts: { failOn?: string; noisy?: boolean } = {}): string {
  const path = join(dir, `server-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(
    path,
    `#!/usr/bin/env node
const TOOLS = ${JSON.stringify(tools)};
const FAIL = ${JSON.stringify(opts.failOn ?? null)};
${opts.noisy ? 'console.log("starting up, not json at all");' : ""}
const lines = require("node:readline").createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") return reply(req.id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "Deneme Sunucusu", version: "1.0" } });
  if (req.method === "notifications/initialized") return;
  if (req.method === "tools/list") return reply(req.id, { tools: TOOLS });
  if (req.method === "tools/call") {
    if (FAIL && req.params.name === FAIL) {
      return reply(req.id, { isError: true, content: [{ type: "text", text: "olmadı" }] });
    }
    return reply(req.id, { content: [{ type: "text", text: "sonuç: " + JSON.stringify(req.params.arguments) }] });
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { message: "bilinmeyen: " + req.method } }) + "\\n");
});
`,
    "utf8",
  );
  chmodSync(path, 0o755);
  return path;
}

const stdio = (path: string) => ({ kind: "stdio" as const, command: process.execPath, args: [path] });

const READ_TOOL: McpTool = {
  name: "search",
  description: "Arama yapar",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  annotations: { readOnlyHint: true },
};

const WRITE_TOOL: McpTool = { name: "send-message", description: "Mesaj gönderir" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocak-mcp-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("talking to a server", () => {
  it("shakes hands, lists tools and calls one", async () => {
    const client = new McpClient(stdio(server([READ_TOOL])));
    try {
      const info = await client.start();
      expect(info.name).toBe("Deneme Sunucusu");

      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["search"]);

      const out = await client.callTool("search", { q: "kulaklık" });
      expect(out).toContain("kulaklık");
    } finally {
      client.dispose();
    }
  });

  it("ignores the chatter servers print on stdout", async () => {
    const client = new McpClient(stdio(server([READ_TOOL], { noisy: true })));
    try {
      await expect(client.start()).resolves.toMatchObject({ name: "Deneme Sunucusu" });
    } finally {
      client.dispose();
    }
  });

  it("turns a tool's own error into a rejected call", async () => {
    const client = new McpClient(stdio(server([WRITE_TOOL], { failOn: "send-message" })));
    try {
      await expect(client.callTool("send-message", {})).rejects.toThrow(/olmadı/);
    } finally {
      client.dispose();
    }
  });

  it("says so plainly when the command does not exist", async () => {
    const client = new McpClient({ kind: "stdio", command: join(dir, "yok-boyle-bir-sey") });
    try {
      await expect(client.start()).rejects.toThrow(/çalıştırılamadı|kapandı/);
    } finally {
      client.dispose();
    }
  });
});

describe("what an added server is allowed to be", () => {
  const connector = (tools: McpTool[], trustReads?: boolean) =>
    createMcpConnector({
      config: {
        id: "deneme",
        label: "Deneme",
        transport: stdio(server(tools)),
        ...(trustReads !== undefined && { trustReads }),
        tools,
      },
    });

  it("makes every tool ask, however the server describes it", () => {
    const defs = connector([READ_TOOL, WRITE_TOOL]).tools();
    // readOnlyHint is the server's word, and on its own it buys nothing.
    expect(defs.map((d) => d.actionClass)).toEqual(["outbound", "outbound"]);
  });

  it("relaxes only what the user said may be relaxed", () => {
    const defs = connector([READ_TOOL, WRITE_TOOL], true).tools();
    expect(defs[0]!.actionClass).toBe("read");
    // And even then, only for the tools the server marked read-only.
    expect(defs[1]!.actionClass).toBe("outbound");
  });

  it("treats everything a server returns as somebody else's writing", () => {
    for (const def of connector([READ_TOOL, WRITE_TOOL], true).tools()) {
      expect(def.untrustedOutput).toBe(true);
    }
  });

  it("prefixes tool names, so two servers cannot collide", () => {
    const defs = connector([READ_TOOL]).tools();
    expect(defs[0]!.name).toBe("deneme_search");
  });

  it("keeps names to what a model endpoint will accept", () => {
    const defs = connector([{ name: "Send Message! (v2)" }]).tools();
    expect(defs[0]!.name).toMatch(/^[a-z0-9_]+$/);
  });

  it("shows the user what a call will do before they approve it", async () => {
    const defs = connector([WRITE_TOOL]).tools();
    const preview = await defs[0]!.preview!({ to: "ayse@example.com" } as never);
    expect(preview).toContain("Deneme");
    expect(preview).toContain("send-message");
    expect(preview).toContain("ayse@example.com");
  });

  it("really runs the tool when called", async () => {
    const built = connector([READ_TOOL]);
    const out = await built.tools()[0]!.run({ q: "merhaba" } as never, ctx());
    expect(out).toContain("merhaba");
    await built.disconnect?.();
  });

  it("reports a server that will not start as blocked, with the reason", async () => {
    const built = createMcpConnector({
      config: { id: "kırık", label: "Kırık", transport: { kind: "stdio", command: join(dir, "yok") } },
    });
    const status = await built.status();
    expect(status.state).toBe("blocked");
    await built.disconnect?.();
  });

  it("learns the tool list on connect and hands it back to be saved", async () => {
    const saved: { id: string; tools: McpTool[] }[] = [];
    const built = createMcpConnector({
      config: { id: "deneme", label: "Deneme", transport: stdio(server([READ_TOOL, WRITE_TOOL])) },
      onTools: (id, tools) => saved.push({ id, tools }),
    });

    // Nothing is known before the first connection.
    expect(built.tools()).toEqual([]);

    const status = await built.connect!();
    expect(status.state).toBe("ready");
    expect(saved.at(-1)?.tools.map((t) => t.name)).toEqual(["search", "send-message"]);
    expect(built.tools().map((t) => t.name)).toEqual(["deneme_search", "deneme_send_message"]);
    await built.disconnect?.();
  });

  it("reaches a stdio server through the IO it was given", async () => {
    const spawned: string[] = [];
    const io: McpIO = {
      spawn: (transport, events) => { spawned.push(transport.command); return localIO.spawn(transport, events); },
      fetch: localIO.fetch,
    };
    const built = createMcpConnector({
      config: { id: "yollu", label: "Yollu", transport: stdio(server([READ_TOOL])), tools: [READ_TOOL] },
      io,
    });
    expect((await built.connect!()).state).toBe("ready");
    expect(await built.tools()[0]!.run({ q: "x" } as never, ctx())).toContain("x");
    expect(spawned).toEqual([process.execPath]);
    await built.disconnect?.();
  });

  it("reaches an HTTP server through the IO it was given, session id and all", async () => {
    const seen: Record<string, string>[] = [];
    const reply = (body: unknown, headers: Record<string, string> = {}) => ({
      ok: true, status: 200,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => JSON.stringify(body),
    });
    const io: McpIO = {
      spawn: () => { throw new Error("no processes here"); },
      fetch: async (_url, init) => {
        seen.push(init.headers);
        const message = JSON.parse(init.body) as { id?: number; method: string };
        if (message.method === "initialize") return reply({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "Uzak" } } }, { "mcp-session-id": "s-1" });
        if (message.method === "tools/list") return reply({ jsonrpc: "2.0", id: message.id, result: { tools: [READ_TOOL] } });
        return reply({ jsonrpc: "2.0", id: message.id, result: {} });
      },
    };
    const built = createMcpConnector({ config: { id: "uzak", label: "Uzak", transport: { kind: "http", url: "https://example.com/mcp" } }, io });
    expect(await built.connect!()).toEqual({ state: "ready", account: "Uzak" });
    expect(built.tools().map((tool) => tool.name)).toEqual(["uzak_search"]);
    expect(seen.at(-1)?.["mcp-session-id"]).toBe("s-1");
  });

  it("is blocked, with the reason, when its IO can't start it", async () => {
    const built = createMcpConnector({
      config: { id: "kilitli", label: "Kilitli", transport: { kind: "stdio", command: "x" } },
      io: {
        spawn: (_transport, events) => {
          setImmediate(() => events.onError(new Error("Kasa kilitli")));
          return { write: () => undefined, kill: () => undefined, alive: false };
        },
        fetch: localIO.fetch,
      },
    });
    const status = await built.status();
    expect(status.state).toBe("blocked");
    expect(status.state === "blocked" && status.reason).toMatch(/Kasa kilitli/);
  });
});

describe("a server can't take more than a reply's worth", () => {
  it("reads a body only up to the limit", async () => {
    await expect(cappedText(new Response("küçük"), 64)).resolves.toBe("küçük");
    await expect(cappedText(new Response(new Uint8Array(65)), 64)).rejects.toThrow(/ MB/);
    const lying = new Response(new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(32)) }));
    await expect(cappedText(lying, 64)).rejects.toThrow(/ MB/);
    await expect(cappedText(new Response("x", { headers: { "content-length": "999" } }), 64)).rejects.toThrow(/ MB/);
  });

  it("stops a stdio server whose line runs past the limit", async () => {
    let killed = false;
    const io: McpIO = {
      spawn: (_transport, events) => {
        const proc = {
          write: () => setImmediate(() => events.onData("x".repeat(MAX_REPLY_BYTES + 1))),
          kill: () => { killed = true; },
          get alive() { return !killed; },
        };
        return proc;
      },
      fetch: localIO.fetch,
    };
    const client = new McpClient({ kind: "stdio", command: "x" }, io);
    await expect(client.listTools()).rejects.toThrow(/ MB/);
    expect(killed).toBe(true);
  });

  it("doesn't follow a redirect, which would carry the secret headers elsewhere", async () => {
    const hits: { path: string; secret?: string }[] = [];
    const web = createServer((req, res) => {
      hits.push({ path: req.url ?? "", secret: req.headers["x-secret"] as string | undefined });
      if (req.url === "/mcp") {
        res.writeHead(307, { location: "/elsewhere" }).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((done) => web.listen(0, "127.0.0.1", done));
    try {
      const { port } = web.address() as { port: number };
      const client = new McpClient({ kind: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { "x-secret": "s3cret" } });
      await expect(client.listTools()).rejects.toThrow(/\(307\)/);
      expect(hits.map((hit) => hit.path)).toEqual(["/mcp"]);
    } finally {
      web.close();
    }
  });
});
