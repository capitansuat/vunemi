import type { AutonomyPolicy } from "@vunemi/agent-core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mailAddressOf, SettingsStore } from "../../src/main/settings.js";

const dirs: string[] = [];
function store() {
  const dir = mkdtempSync(join(tmpdir(), "vunemi-settings-"));
  dirs.push(dir);
  return { dir, settings: new SettingsStore(dir) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("security settings", () => {
  it("keeps the app lock off until the user turns it on, and keeps it through a reset", () => {
    const { dir, settings } = store();
    expect(settings.appLock).toBe(false);
    settings.setAppLock(true);
    expect(new SettingsStore(dir).appLock).toBe(true);
    settings.reset();
    expect(new SettingsStore(dir).appLock).toBe(true);
    // Only a real true turns it on; a stray value in the file doesn't.
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ appLock: "yes" }));
    expect(new SettingsStore(dir).appLock).toBe(false);
  });

  it("keeps the lock on when the settings file is there but can't be read", () => {
    const { dir } = store();
    writeFileSync(join(dir, "settings.json"), '{"appLock": tru');
    expect(new SettingsStore(dir).appLock).toBe(true);
    writeFileSync(join(dir, "settings.json"), "null");
    expect(new SettingsStore(dir).appLock).toBe(true);
  });

  it("persists a policy and safe account metadata without the password", () => {
    const { dir, settings } = store();
    settings.setPolicy({ read: "auto", "write-local": "deny", destructive: "deny", outbound: "ask", financial: "deny" });
    settings.setMailAccounts([{
      id: "account-1", addedAt: 123,
      config: { email: "user@example.com", user: "user", imapHost: "imap.example.com", imapPort: 993, smtpHost: "smtp.example.com", smtpPort: 587, smtpSecure: false },
    }]);
    const again = new SettingsStore(dir);
    expect(again.policy.outbound).toBe("ask");
    expect(mailAddressOf(again.mailAccounts[0]!)).toBe("user@example.com");
    expect(JSON.stringify(again.all)).not.toContain("password");
  });

  it("keeps a Google sign-in account and drops one with a malformed client id", () => {
    const { dir, settings } = store();
    settings.setMailAccounts([
      { id: "g-1", provider: "google", email: "me@gmail.com", clientId: "1234-abc.apps.googleusercontent.com", addedAt: 1 },
      { id: "g-2", provider: "google", email: "you@gmail.com", clientId: "not a client", addedAt: 2 },
    ]);
    const again = new SettingsStore(dir);
    expect(again.mailAccounts).toEqual([{ id: "g-1", provider: "google", email: "me@gmail.com", clientId: "1234-abc.apps.googleusercontent.com", addedAt: 1 }]);
    expect(mailAddressOf(again.mailAccounts[0]!)).toBe("me@gmail.com");
  });

  it("refuses an invalid persisted policy", () => {
    const { dir } = store();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ connections: {}, mcpServers: [], policy: { read: "auto", outbound: "auto" } }));
    const again = new SettingsStore(dir);
    expect(again.policy.financial).toBe("deny");
    expect(again.policy.outbound).toBe("ask");
  });

  it("keeps a saved policy but never lets money out of 'deny'", () => {
    // Earlier builds offered presets with financial: "ask". Someone who
    // chose one keeps the rest of their choice; only that row is closed.
    const { dir } = store();
    const saved: AutonomyPolicy = { read: "auto", "write-local": "auto", destructive: "ask", outbound: "ask", financial: "ask" };
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ connections: {}, mcpServers: [], policy: saved }));
    const again = new SettingsStore(dir);
    expect(again.policy).toEqual({ ...saved, financial: "deny" });

    again.setPolicy({ ...saved, financial: "auto" });
    expect(again.policy.financial).toBe("deny");
    expect(new SettingsStore(dir).policy.financial).toBe("deny");
  });

  it("stores Outlook client metadata without an OAuth refresh token", () => {
    const { dir, settings } = store();
    settings.setMailAccounts([{
      id: "outlook-1", provider: "outlook", email: "user@outlook.com",
      clientId: "12345678-1234-1234-1234-123456789abc", addedAt: 123,
    }]);
    const restored = new SettingsStore(dir).mailAccounts[0];
    expect(restored).toMatchObject({ provider: "outlook", email: "user@outlook.com" });
    expect(JSON.stringify(restored)).not.toContain("refresh_token");
  });

  it("persists local model endpoints and context length", () => {
    const { dir, settings } = store();
    settings.setModelSettings({ endpoints: {
      lmstudio: "http://localhost:4321", ollama: "http://127.0.0.1:11435", llamacpp: "http://127.0.0.1:8081/v1",
    }, ollamaContextLength: 16_384 });
    expect(new SettingsStore(dir).modelSettings).toEqual({ endpoints: {
      lmstudio: "http://localhost:4321/v1", ollama: "http://127.0.0.1:11435", llamacpp: "http://127.0.0.1:8081/v1",
    }, ollamaContextLength: 16_384 });
  });
});
