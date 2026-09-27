import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerConfig } from "@ocak/mcp";
import { connectLocal, Vault } from "@ocak/vault";
import { migrateMcpSecrets, openMcpServer, removeMcpSecrets, sealMcpServer, unsealed } from "../../src/main/mcp-secrets.js";
import { SettingsStore } from "../../src/main/settings.js";

const dirs: string[] = [];
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ocak-mcp-secret-"));
  dirs.push(dir);
  const local = new Vault(dir, {
    available: true,
    encrypt: (plain) => Buffer.from(`encrypted:${plain}`),
    decrypt: (cipher) => cipher.toString().slice("encrypted:".length),
  });
  // Across a channel, as main talks to the Vault process.
  const { client: vault } = await connectLocal(local);
  return { dir, vault, local, settings: new SettingsStore(dir) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("MCP connection secrets", () => {
  it("stores environment values only in the Vault and restores them for the transport", async () => {
    const { dir, vault, settings } = await fixture();
    const raw: McpServerConfig = { id: "sample", label: "Sample", transport: {
      kind: "stdio", command: "example", env: { API_KEY: "secret-token-value" },
    } };
    const { stored } = await sealMcpServer(raw, vault);
    settings.setMcpServers([stored]);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).not.toContain("secret-token-value");
    expect(readFileSync(join(dir, "vault.json"), "utf8")).not.toContain("secret-token-value");
    expect((await openMcpServer(new SettingsStore(dir).mcpServers[0]!, vault)).transport).toEqual(raw.transport);
    await removeMcpSecrets(stored, vault);
    await expect(openMcpServer(stored, vault)).rejects.toThrow();
  });

  it("won't hand a server's secrets to a different command or site saved in its place", async () => {
    const { vault } = await fixture();
    const raw: McpServerConfig = { id: "sample", label: "Sample", transport: {
      kind: "stdio", command: "example", env: { API_KEY: "secret-token-value" },
    } };
    const { stored } = await sealMcpServer(raw, vault);
    const swapped: McpServerConfig = { ...stored, transport: { kind: "stdio", command: "/tmp/other" } };
    await expect(openMcpServer(swapped, vault)).rejects.toThrow(/mcp:\/tmp\/other/);
    const http = (await sealMcpServer({ id: "web", label: "Web", transport: {
      kind: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer web-secret" },
    } }, vault)).stored;
    await expect(openMcpServer({ ...http, transport: { kind: "http", url: "https://evil.example/mcp" } }, vault)).rejects.toThrow();
    expect((await openMcpServer(http, vault)).transport).toMatchObject({ headers: { Authorization: "Bearer web-secret" } });
  });

  it("won't hand a runner's secrets to other arguments, or send them unencrypted off this Mac", async () => {
    const { vault } = await fixture();
    const { stored } = await sealMcpServer({ id: "npx", label: "Npx", transport: {
      kind: "stdio", command: "npx", args: ["-y", "@good/mcp"], env: { API_KEY: "runner-secret" },
    } }, vault);
    expect((await openMcpServer(stored, vault)).transport).toMatchObject({ env: { API_KEY: "runner-secret" } });
    const other = { ...stored, transport: { kind: "stdio" as const, command: "npx", args: ["-y", "@evil/mcp"] } };
    await expect(openMcpServer(other, vault)).rejects.toThrow();
    const plain = (headers: Record<string, string>, url: string): McpServerConfig => ({ id: "p", label: "P", transport: { kind: "http", url, headers } });
    await expect(sealMcpServer(plain({ Authorization: "Bearer x" }, "http://example.com/mcp"), vault)).rejects.toThrow();
    await expect(sealMcpServer(plain({ Authorization: "Bearer x" }, "http://127.0.0.1:8080/mcp"), vault)).resolves.toBeTruthy();
    // Saved as https, edited to http by hand: still nothing goes out.
    const sealed = (await sealMcpServer({ id: "s", label: "S", transport: { kind: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer y" } } }, vault)).stored;
    await expect(openMcpServer({ ...sealed, transport: { kind: "http", url: "http://example.com/mcp" } }, vault)).rejects.toThrow();
  });

  it("knows a server whose secrets still sit in the settings file, so main never runs it", async () => {
    const { vault } = await fixture();
    const legacy: McpServerConfig = { id: "old", label: "Old", transport: { kind: "stdio", command: "example", env: { API_KEY: "plain" } } };
    expect(unsealed(legacy)).toBe(true);
    expect(unsealed((await sealMcpServer(legacy, vault)).stored)).toBe(false);
    expect(unsealed({ id: "none", label: "None", transport: { kind: "http", url: "https://example.com/mcp" } })).toBe(false);
  });

  it("moves a legacy plaintext setting into the Vault on startup", async () => {
    const { dir, vault, settings } = await fixture();
    settings.setMcpServers([{ id: "old", label: "Old", transport: {
      kind: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer old-secret" },
    } }]);
    expect(await migrateMcpSecrets(settings, vault)).toBe(1);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).not.toContain("old-secret");
    const active = await openMcpServer(settings.mcpServers[0]!, vault);
    expect(active.transport).toEqual({ kind: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer old-secret" } });
  });

  it("rejects a header containing a newline before persisting it", async () => {
    const { vault } = await fixture();
    const raw: McpServerConfig = { id: "remote", label: "Remote", transport: {
      kind: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x\r\nEvil: yes" },
    } };
    await expect(sealMcpServer(raw, vault)).rejects.toThrow(/geçersiz/);
    expect(vault.list()).toEqual([]);
  });

  it("does not let an edited MCP reference read or delete another Vault secret", async () => {
    const { vault, local } = await fixture();
    await vault.set("other.account", "other-password");
    const forged: McpServerConfig = {
      id: "remote", label: "Remote", transport: { kind: "http", url: "https://example.com/mcp" },
      secretRefs: { Authorization: "other.account" },
    };
    await expect(openMcpServer(forged, vault)).rejects.toThrow(/geçersiz/);
    await expect(removeMcpSecrets(forged, vault)).rejects.toThrow(/geçersiz/);
    expect(local.use("other.account")).toBe("other-password");
  });
});
