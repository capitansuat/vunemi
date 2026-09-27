/**
 * MCP servers with secrets run from the Vault process: main hands over the
 * sealed config, the secret goes into the server's environment or headers
 * there, and main sees only what the server says.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "@vunemi/agent-core";
import { createMcpConnector, type McpServerConfig } from "@vunemi/mcp";
import { connectLocal, Vault, type SecretCrypto } from "@vunemi/vault";
import { sealMcpServer } from "../../src/main/mcp-secrets.js";
import { vaultMcpIO } from "../../src/main/remote-mcp.js";
import { mayRelease } from "../../src/vault-process/mail.js";
import { serveMcp } from "../../src/vault-process/mcp.js";

const SECRET = "mcp-secret-Kasa-7719";
const fake: SecretCrypto = {
  available: true,
  encrypt: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
  decrypt: (cipher) => cipher.toString("utf8").slice(4),
};
const ctx = (): ToolContext => ({ signal: new AbortController().signal, handoff: async () => true, offerUndo: () => {}, attach: () => {} });

let dir = "";
let http: Server | null = null;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vunemi-vault-mcp-")); });
afterEach(async () => {
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
  http = null;
  rmSync(dir, { recursive: true, force: true });
});

/** A stdio MCP server that says whether it got the secret, never the secret itself. */
function stdioServer(): string {
  const path = join(dir, "server.cjs");
  writeFileSync(path, `
const lines = require("node:readline").createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "initialize") return reply(req.id, { serverInfo: { name: "Gizli" } });
  if (req.method === "tools/list") return reply(req.id, { tools: [{ name: "whoami" }] });
  if (req.method === "tools/call") return reply(req.id, { content: [{ type: "text", text: "key ok: " + (process.env.API_KEY === ${JSON.stringify(SECRET)}) }] });
});
`);
  chmodSync(path, 0o755);
  return path;
}

async function setup() {
  const vault = new Vault(dir, fake);
  const { client, server } = await connectLocal(vault, { mayRelease });
  serveMcp(server);
  return { client };
}

describe("MCP servers run from the Vault process", () => {
  it("starts a stdio server with its secret; main gets the output, never the secret", async () => {
    const { client } = await setup();
    const raw: McpServerConfig = { id: "gizli", label: "Gizli", transport: { kind: "stdio", command: process.execPath, args: [stdioServer()], env: { API_KEY: SECRET } } };
    const { stored } = await sealMcpServer(raw, client);
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    const built = createMcpConnector({ config: stored, io: vaultMcpIO(client, stored) });
    expect(await built.connect!()).toEqual({ state: "ready", account: "Gizli" });
    expect(await built.tools()[0]!.run({} as never, ctx())).toBe("key ok: true");
    // Main can't have it by asking, either.
    const name = Object.values(stored.secretRefs!)[0]!;
    await expect(client.use(name, `mcp:${process.execPath}`)).rejects.toThrow();
    expect(await client.call("mcp.check", [stored])).toBeUndefined();
    await built.disconnect?.();
  });

  it("won't start a server whose saved command was changed after its secret was bound", async () => {
    const { client } = await setup();
    const raw: McpServerConfig = { id: "gizli", label: "Gizli", transport: { kind: "stdio", command: process.execPath, args: [stdioServer()], env: { API_KEY: SECRET } } };
    const { stored } = await sealMcpServer(raw, client);
    const swapped: McpServerConfig = { ...stored, transport: { kind: "stdio", command: "/bin/sh", args: ["-c", "env"] } };
    await expect(client.call("mcp.check", [swapped])).rejects.toThrow(/mcp:\/bin\/sh/);
    const built = createMcpConnector({ config: swapped, io: vaultMcpIO(client, swapped) });
    const status = await built.status();
    expect(status.state).toBe("blocked");
  });

  it("sends an HTTP server its secret header from the Vault process", async () => {
    const { client } = await setup();
    const seen: (string | undefined)[] = [];
    http = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => { body += c.toString(); });
      req.on("end", () => {
        seen.push(req.headers.authorization);
        const message = JSON.parse(body) as { id?: number; method: string };
        const result = message.method === "initialize" ? { serverInfo: { name: "Web" } }
          : message.method === "tools/list" ? { tools: [{ name: "ping" }] } : {};
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-9" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
    const { stored } = await sealMcpServer({ id: "web", label: "Web", transport: { kind: "http", url, headers: { Authorization: `Bearer ${SECRET}` } } }, client);
    const built = createMcpConnector({ config: stored, io: vaultMcpIO(client, stored) });
    expect(await built.connect!()).toEqual({ state: "ready", account: "Web" });
    expect(built.tools().map((tool) => tool.name)).toEqual(["web_ping"]);
    expect(seen.every((value) => value === `Bearer ${SECRET}`)).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses malformed requests from main", async () => {
    const { client } = await setup();
    await expect(client.call("mcp.spawn", [{ id: "x" }, "abcdefgh-1"])).rejects.toThrow(/incomplete/);
    await expect(client.call("mcp.spawn", [{ id: "x", label: "x", transport: { kind: "stdio", command: "x" } }, "../../x"])).rejects.toThrow(/handle/);
    await expect(client.call("mcp.write", ["abcdefgh-2", "{}\n"])).rejects.toThrow(/isn't running/);
  });
});
