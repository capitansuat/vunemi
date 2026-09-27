/**
 * MCP servers that hold secrets, run from the Vault process. Main asks for a
 * server by its saved (sealed) config; the secrets are filled in here, go
 * into the server's environment or request headers, and only the server's
 * output goes back. A saved command or address that no longer matches what
 * the secret was bound to gets nothing (see mcpTarget).
 */
import { localIO, type McpProcess, type McpServerConfig } from "@vunemi/mcp";
import type { VaultServer } from "@vunemi/vault";
import { openMcpServer } from "../main/mcp-secrets.js";

const HANDLE = /^[A-Za-z0-9-]{8,64}$/;

function sealed(value: unknown): McpServerConfig {
  if (!value || typeof value !== "object") throw new TypeError("MCP server must be an object");
  const raw = value as McpServerConfig;
  if (typeof raw.id !== "string" || typeof raw.label !== "string" || !raw.transport || typeof raw.transport !== "object") {
    throw new TypeError("MCP server is incomplete");
  }
  if (raw.transport.kind === "stdio") {
    if (typeof raw.transport.command !== "string") throw new TypeError("MCP command must be a string");
    if (raw.transport.args !== undefined && (!Array.isArray(raw.transport.args) || !raw.transport.args.every((a) => typeof a === "string"))) {
      throw new TypeError("MCP arguments must be strings");
    }
  } else if (raw.transport.kind !== "http" || typeof raw.transport.url !== "string") {
    throw new TypeError("MCP transport is invalid");
  }
  return raw;
}

function handleOf(value: unknown): string {
  if (typeof value !== "string" || !HANDLE.test(value)) throw new TypeError("MCP handle is invalid");
  return value;
}

export function serveMcp(server: VaultServer): { dispose(): void } {
  // Writes that arrive while the secrets are still being read wait in `queue`.
  const running = new Map<string, { proc?: McpProcess; queue: string[] }>();

  server.register("mcp.spawn", async (raw: unknown, rawHandle: unknown) => {
    const handle = handleOf(rawHandle);
    if (running.has(handle)) throw new Error("MCP handle already in use");
    const entry: { proc?: McpProcess; queue: string[] } = { queue: [] };
    running.set(handle, entry);
    try {
      const full = await openMcpServer(sealed(raw), server.vault);
      if (full.transport.kind !== "stdio") throw new TypeError("This MCP server does not run a command.");
      if (!running.has(handle)) return; // killed while its secrets were read
      entry.proc = localIO.spawn(full.transport, {
        onData: (chunk) => server.emit("mcp.data", { handle, chunk }),
        onExit: (code) => { running.delete(handle); server.emit("mcp.exit", { handle, code }); },
        onError: (err) => { running.delete(handle); server.emit("mcp.error", { handle, message: err.message }); },
      });
      for (const line of entry.queue.splice(0)) entry.proc.write(line);
    } catch (err) {
      running.delete(handle);
      throw err;
    }
  });

  server.register("mcp.write", (rawHandle: unknown, line: unknown) => {
    const entry = running.get(handleOf(rawHandle));
    if (!entry) throw new Error("That MCP server isn't running.");
    if (typeof line !== "string") throw new TypeError("MCP input must be text");
    if (entry.proc) entry.proc.write(line);
    else entry.queue.push(line);
  });

  server.register("mcp.kill", (rawHandle: unknown) => {
    const handle = handleOf(rawHandle);
    running.get(handle)?.proc?.kill();
    running.delete(handle);
  });

  server.register("mcp.fetch", async (raw: unknown, init: unknown) => {
    const full = await openMcpServer(sealed(raw), server.vault);
    if (full.transport.kind !== "http") throw new TypeError("This MCP server is not an address.");
    const request = (init ?? {}) as { headers?: Record<string, string>; body?: unknown; timeoutMs?: unknown };
    if (typeof request.body !== "string") throw new TypeError("MCP request body must be text");
    const timeoutMs = typeof request.timeoutMs === "number" && request.timeoutMs > 0 ? Math.min(request.timeoutMs, 120_000) : 30_000;
    const response = await localIO.fetch(full.transport.url, {
      // The secret headers go last: main can't replace them with its own.
      headers: { ...(request.headers ?? {}), ...(full.transport.headers ?? {}) },
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
      timeoutMs,
    });
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type"),
      sessionId: response.headers.get("mcp-session-id"),
      body: await response.text(),
    };
  });

  /** Whether the server's secrets can be read for it: nothing comes back but yes or an error. */
  server.register("mcp.check", async (raw: unknown) => {
    await openMcpServer(sealed(raw), server.vault);
  });

  return {
    dispose: () => {
      for (const entry of running.values()) entry.proc?.kill();
      running.clear();
    },
  };
}
