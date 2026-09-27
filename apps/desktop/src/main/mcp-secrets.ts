import { createHash } from "node:crypto";
import type { McpServerConfig } from "@vunemi/mcp";
import type { VaultClient } from "@vunemi/vault";
import type { SettingsStore } from "./settings.js";
import { t } from "@vunemi/i18n";

function values(config: McpServerConfig): Record<string, string> {
  return config.transport.kind === "stdio" ? config.transport.env ?? {} : config.transport.headers ?? {};
}

/** A server saved before the Vault held MCP secrets: its values still sit in the settings file. */
export function unsealed(config: McpServerConfig): boolean {
  return !config.secretRefs && Object.keys(values(config)).length > 0;
}

function secretName(id: string, key: string): string {
  return `mcp.${createHash("sha256").update(`${id}:${key}`).digest("hex").slice(0, 32)}`;
}

function withoutValues(config: McpServerConfig): McpServerConfig {
  if (config.transport.kind === "stdio") {
    const { env: _env, ...transport } = config.transport;
    return { ...config, transport };
  }
  const { headers: _headers, ...transport } = config.transport;
  return { ...config, transport };
}

/**
 * Where a server's secrets may go: the program it runs with its arguments, or
 * the site it talks to. The arguments count because one runner (npx, node,
 * python) runs any package or script. Editing the saved command, arguments or
 * address later leaves them locked.
 */
export function mcpTarget(config: McpServerConfig): string {
  if (config.transport.kind !== "stdio") return `mcp:${new URL(config.transport.url).origin}`;
  const args = config.transport.args ?? [];
  if (args.length === 0) return `mcp:${config.transport.command}`;
  return `mcp:${config.transport.command}#${createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16)}`;
}

/** Secret headers travel only encrypted, or not off this Mac at all. */
function refuseCleartext(config: McpServerConfig): void {
  if (config.transport.kind !== "http") return;
  const url = new URL(config.transport.url);
  if (url.protocol === "https:" || ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return;
  throw new Error(t("main.mcpSecrets.needHttps"));
}

export async function sealMcpServer(config: McpServerConfig, vault: VaultClient): Promise<{ stored: McpServerConfig; created: string[] }> {
  const entries = Object.entries(values(config));
  if (entries.length === 0) return { stored: config, created: [] };
  if (Object.keys(config.secretRefs ?? {}).length > 0) throw new Error(t("main.mcpSecrets.readd"));
  if (!vault.available) throw new Error(t("main.mcpSecrets.noVault"));
  if (entries.length > 32) throw new Error(t("main.mcpSecrets.tooMany"));
  refuseCleartext(config);
  const refs: Record<string, string> = { ...config.secretRefs };
  const created: string[] = [];
  try {
    for (const [key, value] of entries) {
      const validKey = config.transport.kind === "stdio" ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) : /^[A-Za-z0-9-]+$/.test(key);
      if (!validKey || typeof value !== "string" || !value || value.length > 4096 || /[\r\n\0]/.test(value)) {
        throw new Error(t("main.mcpSecrets.invalid"));
      }
      const name = secretName(config.id, key);
      await vault.set(name, value, `${config.label}: ${key}`, [mcpTarget(config)]);
      created.push(name);
      refs[key] = name;
    }
    return { stored: { ...withoutValues(config), secretRefs: refs }, created };
  } catch (err) {
    await forget(created, vault);
    throw err;
  }
}

/** Reading a secret, as the Vault itself (in its own process) or a client of it does. */
export interface SecretAccess {
  adopt(name: string, bind: string[]): void | Promise<void>;
  use(name: string, target: string): string | Promise<string>;
}

/**
 * The server's config with its secrets filled in. Run in the Vault process
 * (vault-process/mcp.ts): the values go straight into the server's
 * environment or headers there, and never to main.
 */
export async function openMcpServer(config: McpServerConfig, vault: SecretAccess): Promise<McpServerConfig> {
  const refs = config.secretRefs ?? {};
  if (Object.keys(refs).length === 0) return config;
  refuseCleartext(config);
  const target = mcpTarget(config);
  for (const [key, name] of Object.entries(refs)) {
    if (name !== secretName(config.id, key)) throw new Error(t("main.mcpSecrets.badRef"));
  }
  const resolved: Record<string, string> = {};
  for (const [key, name] of Object.entries(refs)) {
    // Saved before binding existed: bound to this server now, then checked like any other.
    await vault.adopt(name, [target]);
    resolved[key] = await vault.use(name, target);
  }
  return {
    ...config,
    transport: config.transport.kind === "stdio"
      ? { ...config.transport, env: resolved }
      : { ...config.transport, headers: resolved },
  };
}

export async function removeMcpSecrets(config: McpServerConfig, vault: VaultClient): Promise<void> {
  const refs = Object.entries(config.secretRefs ?? {});
  for (const [key, name] of refs) {
    if (name !== secretName(config.id, key)) throw new Error(t("main.mcpSecrets.badRef"));
  }
  for (const [, name] of refs) await vault.delete(name);
}

export async function migrateMcpSecrets(settings: SettingsStore, vault: VaultClient): Promise<number> {
  if (!vault.available) return 0;
  const created: string[] = [];
  try {
    const migrated: McpServerConfig[] = [];
    for (const server of settings.mcpServers) {
      const sealed = await sealMcpServer(server, vault);
      created.push(...sealed.created);
      migrated.push(sealed.stored);
    }
    if (created.length > 0) settings.setMcpServers(migrated);
    return created.length;
  } catch (err) {
    await forget(created, vault);
    throw err;
  }
}

/** Takes back secrets written for something that then failed; best effort, the first error stands. */
async function forget(names: string[], vault: VaultClient): Promise<void> {
  for (const name of names) await vault.delete(name).catch(() => undefined);
}
