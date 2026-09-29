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

  it("keeps trusted sites clean, and forgets them on a reset", () => {
    const { dir, settings } = store();
    expect(settings.trustedSites.size).toBe(0);
    settings.setTrustedSites(["intranet.example.ac.uk", "INTRANET.example.ac.uk.", "10.0.0.5"]);
    expect(new SettingsStore(dir).trustedSiteList).toEqual(["intranet.example.ac.uk", "10.0.0.5"]);
    expect(settings.trustedSites.has("10.0.0.5")).toBe(true);
    // Whatever else got into the file never becomes trusted.
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ trustedSites: ["localhost", "127.0.0.1", 42, "*.corp.example", "wiki.corp.example"] }));
    expect(new SettingsStore(dir).trustedSiteList).toEqual(["wiki.corp.example"]);
    settings.reset();
    expect(new SettingsStore(dir).trustedSiteList).toEqual([]);
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

  it("keeps a Mail app account and drops one with a bad name or address", () => {
    const { dir, settings } = store();
    settings.setMailAccounts([
      { id: "a-1", provider: "applemail", account: "iCloud", email: "test@example.com", addedAt: 1 },
      { id: "a-2", provider: "applemail", account: "", email: "test2@example.com", addedAt: 2 },
      { id: "a-3", provider: "applemail", account: "Work\nx", email: "test3@example.com", addedAt: 3 },
      { id: "a-4", provider: "applemail", account: "Home", email: "not an address", addedAt: 4 },
    ]);
    const again = new SettingsStore(dir);
    expect(again.mailAccounts).toEqual([{ id: "a-1", provider: "applemail", account: "iCloud", email: "test@example.com", addedAt: 1 }]);
    expect(mailAddressOf(again.mailAccounts[0]!)).toBe("test@example.com");
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

describe("appearance", () => {
  it("follows the Mac until chosen, keeps the choice through a reset, and ignores stray values", () => {
    const { dir, settings } = store();
    expect(settings.appearance).toBe("system");
    settings.setAppearance("dark");
    expect(new SettingsStore(dir).appearance).toBe("dark");
    settings.reset();
    expect(new SettingsStore(dir).appearance).toBe("dark");
    expect(() => settings.setAppearance("blue" as never)).toThrow();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ appearance: "blue" }));
    expect(new SettingsStore(dir).appearance).toBe("system");
  });
});
