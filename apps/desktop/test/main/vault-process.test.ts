/**
 * Kasa B: mail runs in the Vault process. Main holds a RemoteMailAccount and
 * a VaultClient; the password is used on the far side of the channel and
 * never crosses back. Real nodemailer against a local SMTP server.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Outbox, type Draft } from "@vunemi/mail";
import { connectLocal, Vault, type SecretCrypto } from "@vunemi/vault";
import { FakeSmtp, makeCertificate } from "../../../../packages/mail/test/fake-smtp.js";
import { RemoteMailAccount } from "../../src/main/remote-mail.js";
import type { StoredMailAccount } from "../../src/main/settings.js";
import { VaultHost, type ChildProcessLike } from "../../src/main/vault-host.js";
import { mailSecretName, mayRelease, serveMail } from "../../src/vault-process/mail.js";

const fake: SecretCrypto = {
  available: true,
  encrypt: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
  decrypt: (cipher) => cipher.toString("utf8").slice(4),
};
const draft: Draft = { to: ["friend@example.com"], subject: "Hello", body: "Synthetic test message." };
const PASSWORD = "p4ss-Kasa-B-9731";

let certificate: { key: string; cert: string };
let smtp: FakeSmtp | null = null;
const dirs: string[] = [];
beforeAll(() => { certificate = makeCertificate(); });
afterEach(async () => {
  await smtp?.stop();
  smtp = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(password = PASSWORD) {
  smtp = new FakeSmtp({ tls: true, password: PASSWORD }, certificate);
  await smtp.start();
  const dir = mkdtempSync(join(tmpdir(), "vunemi-vault-process-"));
  dirs.push(dir);
  const vault = new Vault(dir, fake);
  const entry: StoredMailAccount = {
    id: "0b7a6c1e-1111-4222-8333-444455556666",
    config: { email: "me@example.com", user: "me", imapHost: "localhost", imapPort: 993, smtpHost: "127.0.0.1", smtpPort: smtp.port, smtpSecure: false },
    addedAt: 1,
  };
  // Saved before binding existed: the Vault process binds it on first use.
  vault.set(mailSecretName(entry.id), password);
  const { client, server } = await connectLocal(vault, { mayRelease });
  serveMail(server, { testCa: certificate.cert });
  return { vault, client, entry, account: new RemoteMailAccount(client, entry) };
}

describe("mail in the Vault process", () => {
  it("sends through SMTP from the Vault process; main never holds the password", async () => {
    const { client, vault, entry, account } = await setup();
    expect(await account.ready()).toBe(false); // no IMAP server here; the call went through and answered
    await account.send(draft);
    expect(smtp!.received).toHaveLength(1);
    expect(smtp!.received[0]!.data).toContain("Synthetic test message.");
    // Bound to its servers on first use, inside the Vault process.
    expect(vault.targets(mailSecretName(entry.id))).toEqual(["imap:localhost", "smtp:127.0.0.1"]);
    await client.refresh();
    expect(client.targets(mailSecretName(entry.id))).toEqual(["imap:localhost", "smtp:127.0.0.1"]);
    // Main can't have it, by name or by target.
    await expect(client.use(mailSecretName(entry.id), "smtp:127.0.0.1")).rejects.toThrow(/Kasa sürecinin içinde|vault process/);
    expect(JSON.stringify(client)).not.toContain(PASSWORD);
    expect(JSON.stringify(account)).not.toContain(PASSWORD);
  });

  it("carries 'not sent' across, so the outbox clears it instead of calling it unknown", async () => {
    const { account } = await setup("wrong");
    const err = (await account.send(draft).catch((e: unknown) => e)) as Error & { notSent?: boolean };
    expect(err.notSent).toBe(true);
    expect(smtp!.received).toEqual([]);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const events: string[] = [];
      const outbox = new Outbox(100);
      outbox.on((event) => events.push(event.kind === "failed" ? `failed:${/tekrar|again|yeniden/i.test(event.error) ? "retryable" : "unknown"}` : event.kind));
      await outbox.hold({ id: "a", label: account.label, account }, draft);
      await vi.advanceTimersByTimeAsync(100);
      vi.useRealTimers();
      await outbox.settle();
      expect(events[0]).toBe("held");
      expect(events[1]).toBe("sending");
      expect(events[2]).toMatch(/^failed/);
      expect(outbox.uncertain).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses what isn't a mail method, and a malformed account", async () => {
    const { client, entry } = await setup();
    await expect(client.call("mail.call", [entry, "constructor", []])).rejects.toThrow(/not a mail method/);
    await expect(client.call("mail.call", [{ ...entry, id: "../x" }, "send", [draft]])).rejects.toThrow(/invalid/);
    await expect(client.call("mail.call", [{ ...entry, config: { ...entry.config, smtpHost: "evil host" } }, "send", [draft]])).rejects.toThrow();
  });

  it("passes the organise calls through to the mailbox", async () => {
    const { account } = await setup();
    // No IMAP server here: each call reaches the mailbox and fails there, not at the method list.
    for (const call of [() => account.move("1", { kind: "trash" }), () => account.moveBack("1", "INBOX"), () => account.setRead("1", true)]) {
      const err = (await call().catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).not.toMatch(/not a mail method|can't move|can't setRead/);
    }
  });

  it("answers 'not ready' for an account whose secret it can't read", async () => {
    const { client, entry } = await setup();
    const other = new RemoteMailAccount(client, { ...entry, id: "0b7a6c1e-9999-4222-8333-444455556666" });
    expect(await other.ready()).toBe(false);
    await expect(other.send(draft)).rejects.toThrow();
  });

  it("tries a new account's password from the Vault process and reports why it failed", async () => {
    const { client, entry } = await setup();
    await expect(client.call("mail.verify", [entry.config, ""])).rejects.toThrow();
    await expect(client.call("mail.verify", [{ ...entry.config, imapPort: 1 }, PASSWORD], 30_000)).rejects.toThrow();
  });
});

describe("Gmail signed in with Google, from the Vault process", () => {
  it("sends with an access token it refreshed itself; the refresh token never leaves", async () => {
    smtp = new FakeSmtp({ tls: true, accessToken: "ya29.fresh" }, certificate);
    await smtp.start();
    const dir = mkdtempSync(join(tmpdir(), "vunemi-vault-google-"));
    dirs.push(dir);
    const vault = new Vault(dir, fake);
    const client = { clientId: "1234-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-synthetic" };
    const entry: StoredMailAccount = { id: "0b7a6c1e-2222-4222-8333-444455556666", provider: "google", email: "me@gmail.com", clientId: client.clientId, addedAt: 1 };
    vault.set(mailSecretName(entry.id), "1//refresh-token-kasa", undefined, ["https:oauth2.googleapis.com"]);
    const { client: vaultClient, server } = await connectLocal(vault, { mayRelease });
    const port = smtp.port;
    serveMail(server, {
      testCa: certificate.cert,
      clients: { google: client },
      gmailServers: (email) => ({ email, user: email, imapHost: "localhost", imapPort: 993, smtpHost: "127.0.0.1", smtpPort: port, smtpSecure: false }),
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== "https://oauth2.googleapis.com/token") return realFetch(url, init);
      expect((init!.body as URLSearchParams).get("refresh_token")).toBe("1//refresh-token-kasa");
      return new Response(JSON.stringify({ access_token: "ya29.fresh", expires_in: 3600 }), { status: 200 });
    }));
    try {
      const account = new RemoteMailAccount(vaultClient, entry);
      expect(account.label).toBe("me@gmail.com");
      await account.send(draft);
      expect(smtp.received).toHaveLength(1);
      await expect(vaultClient.use(mailSecretName(entry.id), "https:oauth2.googleapis.com")).rejects.toThrow();
      expect(JSON.stringify(vaultClient)).not.toContain("refresh-token-kasa");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("asks for a new sign-in when the build's Google registration changed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vunemi-vault-google-"));
    dirs.push(dir);
    const vault = new Vault(dir, fake);
    vault.set(mailSecretName("0b7a6c1e-3333-4222-8333-444455556666"), "1//r");
    const { client: vaultClient, server } = await connectLocal(vault, { mayRelease });
    serveMail(server, { clients: { google: { clientId: "999-other.apps.googleusercontent.com", clientSecret: "x" } } });
    const entry: StoredMailAccount = { id: "0b7a6c1e-3333-4222-8333-444455556666", provider: "google", email: "me@gmail.com", clientId: "1234-abc.apps.googleusercontent.com", addedAt: 1 };
    await expect(new RemoteMailAccount(vaultClient, entry).send(draft)).rejects.toThrow(/Google/);
  });
});

describe("what may leave the Vault process", () => {
  it("keeps mail and MCP secrets and their targets inside, releases the rest", () => {
    expect(mayRelease("mail.abc", undefined)).toBe(false);
    expect(mayRelease("mail.abc", "vunemi:outbox")).toBe(false);
    expect(mayRelease("mcp.x", "smtp:smtp.example.com")).toBe(false);
    expect(mayRelease("mcp.x", "imap:imap.example.com")).toBe(false);
    expect(mayRelease("mcp.x", "https:login.microsoftonline.com")).toBe(false);
    expect(mayRelease("my.token", "https:oauth2.googleapis.com")).toBe(false);
    expect(mayRelease("mcp.x", "mcp:/usr/bin/tool")).toBe(false);
    expect(mayRelease("my.token", "mcp:/usr/bin/tool")).toBe(false);
    expect(mayRelease("mcp.x", undefined)).toBe(false);
    expect(mayRelease("outbox.queue", "vunemi:outbox")).toBe(true);
    expect(mayRelease("my.token", undefined)).toBe(true);
  });
});

/** A utility process stand-in that answers init, then echoes calls from a VaultServer. */
function fakeChild(behaviour: "ready" | "silent" | "exit"): ChildProcessLike & { exit(code: number): void; posted: unknown[] } {
  const listeners: { message: ((m: unknown) => void)[]; exit: ((c: number) => void)[] } = { message: [], exit: [] };
  const child = {
    posted: [] as unknown[],
    postMessage(message: unknown) {
      child.posted.push(message);
      const call = message as { kind?: string; id?: number };
      if (call.kind === "init" && behaviour === "ready") {
        setImmediate(() => listeners.message.forEach((l) => l({ kind: "ready", state: { available: true, secrets: [], readable: [], binds: {}, unreadable: [] } })));
      } else if (call.kind === "init" && behaviour === "exit") {
        setImmediate(() => child.exit(1));
      } else if (call.kind === "call") {
        setImmediate(() => listeners.message.forEach((l) => l({ kind: "reply", id: call.id, ok: true, value: null, state: { available: true, secrets: [], readable: ["x.y"], binds: {}, unreadable: [] } })));
      }
    },
    on(event: "message" | "exit", listener: (value: never) => void) {
      (listeners[event] as ((value: never) => void)[]).push(listener);
      return child;
    },
    kill() { child.exit(0); return true; },
    exit(code: number) { listeners.exit.forEach((l) => l(code)); },
  };
  return child as never;
}

describe("VaultHost", () => {
  const init = () => ({ userData: "/tmp/x", helperPath: "/tmp/helper", locale: "en" });

  it("starts the process, hands it what it needs, and mirrors its state", async () => {
    const child = fakeChild("ready");
    const host = new VaultHost({ spawn: () => child, init });
    await host.start();
    await host.ready;
    expect(child.posted[0]).toEqual({ kind: "init", ...init() });
    expect(host.client.available).toBe(true);
    expect(host.client.has("x.y")).toBe(true);
    host.stop();
    expect(host.client.available).toBe(false);
  });

  it("restarts a process that died, a few times a minute at most, then gives up and settles ready", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      let spawned = 0;
      const host = new VaultHost({ spawn: () => { spawned++; return fakeChild("exit"); }, init, maxRestartsPerMinute: 2 });
      const settled = vi.fn();
      void host.ready.then(settled);
      await host.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(spawned).toBe(3);
      expect(settled).toHaveBeenCalled();
      expect(host.client.available).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails calls in flight when the process dies, instead of hanging", async () => {
    const child = fakeChild("ready");
    const host = new VaultHost({ spawn: () => child, init, maxRestartsPerMinute: 0 });
    await host.start();
    // Swallow replies from now on, then die.
    child.postMessage = () => undefined;
    const waiting = host.client.use("x.y");
    child.exit(9);
    await expect(waiting).rejects.toThrow(/exited \(9\)/);
  });
});
