/**
 * A small MCP client: enough of the protocol to list a server's tools and
 * call them, over the two transports people actually use.
 *
 * This is how a user adds something Vunemi was never built for. It is also,
 * necessarily, the widest door in the app — an MCP server is a program the
 * user asks us to run, or a URL we hand their requests to — so two rules
 * hold everywhere in this package:
 *
 *  1. **Only the user adds a server.** There is no tool for it. Nothing the
 *     model says, and nothing a web page says, can introduce a server; that
 *     would be prompt injection with a shell attached.
 *  2. **A server's own description of itself is not evidence.** Names,
 *     descriptions and annotations all come from the far side. They are
 *     shown to the user and passed to the model as text, never used to
 *     decide what may happen without asking.
 */

import { spawn } from "node:child_process";
import { t } from "@vunemi/i18n";

export interface StdioTransport {
  kind: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpTransport {
  kind: "http";
  url: string;
  headers?: Record<string, string>;
}

export type McpTransport = StdioTransport | HttpTransport;

/** A tool as the server describes it. Every field here is the server's word. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface McpServerInfo {
  name?: string;
  version?: string;
}

/** What Vunemi claims to be, in the handshake. */
const CLIENT = { name: "Vunemi", version: "0.1.0" };
const PROTOCOL = "2025-06-18";

/** A server that does not answer is a server that is not working. */
const CALL_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 20_000;

export class McpError extends Error {}

/** A running stdio server, however it was started. */
export interface McpProcess {
  write(line: string): void;
  kill(): void;
  readonly alive: boolean;
}

export interface McpProcessEvents {
  /** Output as it arrives: lines may be split across chunks. */
  onData(chunk: string): void;
  onExit(code: number | null): void;
  onError(err: Error): void;
}

/** What an HTTP reply must offer; a fetch Response does. */
export interface McpHttpReply {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/**
 * How the client reaches a server. By default it spawns the command itself
 * and fetches the URL itself; the desktop app routes servers holding
 * secrets through the Vault process instead, so their secrets never reach it.
 */
export interface McpIO {
  spawn(transport: StdioTransport, events: McpProcessEvents): McpProcess;
  fetch(url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal; timeoutMs: number }): Promise<McpHttpReply>;
}

/**
 * A deliberately plain environment: the server gets what the user set for
 * it and the bare minimum besides, not everything the caller holds.
 */
export function serverEnv(transport: StdioTransport): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    ...transport.env,
  };
}

/** The most one reply from a server may be, over stdio or HTTP; a server can't fill memory. */
export const MAX_REPLY_BYTES = 8 * 1024 * 1024;

const tooLarge = (): McpError => new McpError(t("mcp.tooLarge", { mb: MAX_REPLY_BYTES / 1024 / 1024 }));

/** A response body, read no further than `max` bytes. */
export async function cappedText(response: Response, max = MAX_REPLY_BYTES): Promise<string> {
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const localIO: McpIO = {
  spawn(transport, events) {
    const child = spawn(transport.command, transport.args ?? [], { stdio: ["pipe", "pipe", "pipe"], env: serverEnv(transport) });
    child.stdout.on("data", (chunk: Buffer) => events.onData(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => console.error("[mcp]", chunk.toString().trim().slice(0, 500)));
    child.on("exit", (code) => events.onExit(code));
    child.on("error", (err) => events.onError(err));
    return {
      write: (line) => { child.stdin.write(line); },
      kill: () => { child.kill(); },
      get alive() { return child.exitCode === null && !child.killed; },
    };
  },
  fetch: async (url, init) => {
    // Not followed: a redirect would carry the secret headers to an address they weren't given for.
    const response = await fetch(url, { method: "POST", headers: init.headers, body: init.body, signal: init.signal, redirect: "manual" });
    return { ok: response.ok, status: response.status, headers: response.headers, text: () => cappedText(response) };
  },
};

export class McpClient {
  private child: McpProcess | null = null;
  private buffer = "";
  /** Stops the running server when it sends more than a reply may be. */
  private overflow: ((error: McpError) => void) | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private session: string | null = null;
  private started: Promise<McpServerInfo> | null = null;

  constructor(private readonly transport: McpTransport, private readonly io: McpIO = localIO, private readonly startTimeoutMs = START_TIMEOUT_MS) {}

  /** Handshake, once. Repeated calls wait on the first. */
  async start(): Promise<McpServerInfo> {
    this.started ??= this.handshake().catch((err: unknown) => {
      // A failed start must not be remembered as a start.
      this.started = null;
      throw err;
    });
    return this.started;
  }

  async listTools(): Promise<McpTool[]> {
    await this.start();
    const result = (await this.request("tools/list", {})) as { tools?: McpTool[] };
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  /** Calls a tool and flattens the reply to text. */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const result = await this.callToolResult(name, args, signal);
    const text = (result.content ?? [])
      .map((part) => {
        if (typeof part?.text === "string") return part.text;
        if (part?.type) return `[${String(part.type)} content — not text, cannot be shown]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return text || (result.structuredContent ? JSON.stringify(result.structuredContent) : "(empty response)");
  }

  /** Structured data for built-in adapters; third-party prose is not a schema. */
  async callToolResult(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{
    content?: { type?: string; text?: string; [k: string]: unknown }[];
    structuredContent?: unknown;
    isError?: boolean;
  }> {
    await this.start();
    const result = (await this.request("tools/call", { name, arguments: args }, signal)) as {
      content?: { type?: string; text?: string; [k: string]: unknown }[];
      isError?: boolean;
      structuredContent?: unknown;
    };

    if (result?.isError) throw new McpError(result.content?.map((part) => part.text ?? "").join("\n") ||
      (result.structuredContent ? JSON.stringify(result.structuredContent) : "MCP tool failed"));
    return result;
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
    this.started = null;
    this.session = null;
    for (const [id, pending] of this.waiting) {
      this.waiting.delete(id);
      pending.reject(new McpError(t("mcp.closed")));
    }
  }

  // -- protocol --------------------------------------------------------------

  private async handshake(): Promise<McpServerInfo> {
    const result = (await this.request(
      "initialize",
      { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT },
      undefined,
      this.startTimeoutMs,
    )) as { serverInfo?: McpServerInfo };
    await this.notify("notifications/initialized");
    return result?.serverInfo ?? {};
  }

  private async request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return this.transport.kind === "stdio"
      ? this.overStdio(id, message, signal, timeoutMs)
      : this.overHttp(message, signal, timeoutMs);
  }

  private async notify(method: string): Promise<void> {
    const message = { jsonrpc: "2.0", method, params: {} };
    if (this.transport.kind === "stdio") this.start_().write(`${JSON.stringify(message)}\n`);
    else await this.post(message).catch(() => undefined);
  }

  // -- stdio -----------------------------------------------------------------

  private overStdio(id: number, message: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<unknown> {
    const child = this.start_();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new McpError(t("mcp.timeout", { seconds: timeoutMs / 1000 })));
      }, timeoutMs);

      const onAbort = () => {
        this.waiting.delete(id);
        clearTimeout(timer);
        reject(new McpError("Durduruldu."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      child.write(`${JSON.stringify(message)}\n`);
    });
  }

  private start_(): McpProcess {
    if (this.transport.kind !== "stdio") throw new McpError("This connection does not run a command.");
    if (this.child?.alive) return this.child;

    this.buffer = "";
    let child: McpProcess | null = null;
    const gone = (error: McpError): void => {
      if (child && this.child === child) {
        this.child = null;
        this.started = null;
      }
      for (const [id, pending] of this.waiting) {
        this.waiting.delete(id);
        pending.reject(error);
      }
    };
    child = this.io.spawn(this.transport, {
      onData: (chunk) => this.read(chunk),
      onExit: (code) => gone(new McpError(t("mcp.exited", { code: code ?? "signal" }))),
      onError: (err) => gone(new McpError(t("mcp.spawnFailed", { reason: err.message }))),
    });
    this.child = child;
    this.overflow = (error) => {
      child?.kill();
      gone(error);
    };
    return child;
  }

  private read(text: string): void {
    this.buffer += text;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (line.trim()) this.deliver(line);
    }
    // A line still unfinished past the limit: the server is stopped rather than kept in memory.
    if (this.buffer.length > MAX_REPLY_BYTES) {
      this.buffer = "";
      this.overflow?.(tooLarge());
    }
  }

  private deliver(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return; // servers log all sorts of things on stdout
    }
    if (typeof message.id !== "number") return; // a notification from the server
    const pending = this.waiting.get(message.id);
    if (!pending) return;
    this.waiting.delete(message.id);
    if (message.error) pending.reject(new McpError(message.error.message ?? "Sunucu hata verdi."));
    else pending.resolve(message.result);
  }

  // -- http ------------------------------------------------------------------

  private async overHttp(message: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<unknown> {
    const response = await this.post(message, signal, timeoutMs);
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.session = sessionId;

    if (response.status >= 300 && response.status < 400) throw new McpError(t("mcp.redirected", { status: response.status }));
    const body = await response.text();
    if (!response.ok) throw new McpError(t("mcp.httpError", { status: response.status, body: body.slice(0, 200) }));

    // Streamable HTTP may answer with SSE; the reply we want is the first
    // data frame carrying a result for this id.
    const payload = response.headers.get("content-type")?.includes("text/event-stream") ? firstEvent(body) : body;
    let parsed: { result?: unknown; error?: { message?: string } };
    try {
      parsed = JSON.parse(payload) as typeof parsed;
    } catch {
      throw new McpError(t("mcp.badResponse", { body: payload.slice(0, 200) }));
    }
    if (parsed.error) throw new McpError(parsed.error.message ?? "Sunucu hata verdi.");
    return parsed.result;
  }

  private async post(message: unknown, signal?: AbortSignal, timeoutMs = CALL_TIMEOUT_MS): Promise<McpHttpReply> {
    if (this.transport.kind !== "http") throw new McpError("This connection does not go to an address.");
    const abort = AbortSignal.timeout(timeoutMs);
    return this.io.fetch(this.transport.url, {
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.session && { "mcp-session-id": this.session }),
        ...this.transport.headers,
      },
      body: JSON.stringify(message),
      signal: signal ? AbortSignal.any([signal, abort]) : abort,
      timeoutMs,
    });
  }
}

/** Pulls the first `data:` payload out of an SSE body. */
function firstEvent(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("data:")) return line.slice(5).trim();
  }
  return body;
}
