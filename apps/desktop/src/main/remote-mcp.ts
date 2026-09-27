/**
 * How main reaches an MCP server that holds secrets: through the Vault
 * process, which fills the secrets in (vault-process/mcp.ts). Main sends the
 * saved, sealed config and sees only what the server says.
 */
import { randomUUID } from "node:crypto";
import type { McpIO, McpServerConfig } from "@vunemi/mcp";
import type { VaultClient } from "@vunemi/vault";

interface Reply {
  ok: boolean;
  status: number;
  contentType: string | null;
  sessionId: string | null;
  body: string;
}

export function vaultMcpIO(vault: VaultClient, config: McpServerConfig): McpIO {
  return {
    spawn(_transport, events) {
      const handle = randomUUID();
      let alive = true;
      const offs: (() => void)[] = [];
      const end = (report: () => void): void => {
        if (!alive) return;
        alive = false;
        for (const off of offs.splice(0)) off();
        report();
      };
      const mine = (data: unknown): data is { handle: string } => (data as { handle?: unknown })?.handle === handle;
      offs.push(
        vault.onEvent("mcp.data", (data) => { if (mine(data)) events.onData(String((data as { chunk?: unknown }).chunk ?? "")); }),
        vault.onEvent("mcp.exit", (data) => { if (mine(data)) end(() => events.onExit((data as { code?: number | null }).code ?? null)); }),
        vault.onEvent("mcp.error", (data) => { if (mine(data)) end(() => events.onError(new Error(String((data as { message?: unknown }).message)))); }),
        // The Vault process took the server down with it.
        vault.onDetach(() => end(() => events.onExit(null))),
      );
      vault.call("mcp.spawn", [config, handle]).catch((err: unknown) =>
        end(() => events.onError(err instanceof Error ? err : new Error(String(err)))));
      return {
        write: (line) => { void vault.call("mcp.write", [handle, line]).catch(() => undefined); },
        kill: () => {
          end(() => undefined);
          void vault.call("mcp.kill", [handle]).catch(() => undefined);
        },
        get alive() { return alive; },
      };
    },

    async fetch(_url, init) {
      const call = vault.call<Reply>("mcp.fetch", [config, { headers: init.headers, body: init.body, timeoutMs: init.timeoutMs }], init.timeoutMs + 5_000);
      // An abort here stops waiting; the request itself runs out its own timeout there.
      const aborted = new Promise<never>((_, reject) => {
        if (init.signal.aborted) reject(init.signal.reason);
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
      const reply = await Promise.race([call, aborted]);
      const headers: Record<string, string | null> = { "content-type": reply.contentType, "mcp-session-id": reply.sessionId };
      return {
        ok: reply.ok,
        status: reply.status,
        headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        text: async () => reply.body,
      };
    },
  };
}
