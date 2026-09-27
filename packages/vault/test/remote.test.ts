/**
 * The Vault across a process boundary: the client mirrors names and
 * bindings, never values, and a value the server keeps inside stays there.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectLocal, fromRemoteError, portPair, toRemoteError, VaultClient, VaultServer } from "../src/remote.js";
import { Vault, type SecretCrypto } from "../src/vault.js";

const fake: SecretCrypto = {
  available: true,
  encrypt: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
  decrypt: (cipher) => {
    const text = cipher.toString("utf8");
    if (!text.startsWith("enc:")) throw new Error("another key");
    return text.slice(4);
  },
};

describe("Vault over a channel", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ocak-vault-remote-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("mirrors names, notes and bindings after each call, never a value", async () => {
    const { client } = await connectLocal(new Vault(dir, fake));
    expect(client.available).toBe(true);
    await client.set("api.token", "tok-secret-value", "service", ["https:api.example.com"]);
    expect(client.has("api.token")).toBe(true);
    expect(client.list().map((item) => item.name)).toEqual(["api.token"]);
    expect(client.targets("api.token")).toEqual(["https:api.example.com"]);
    expect(JSON.stringify(client)).not.toContain("tok-secret-value");
    expect(await client.use("api.token", "https:api.example.com")).toBe("tok-secret-value");
    await client.delete("api.token");
    expect(client.has("api.token")).toBe(false);
  });

  it("keeps what the server won't release inside, and says so", async () => {
    const vault = new Vault(dir, fake);
    vault.set("mail.a", "mail-password", undefined, ["smtp:smtp.example.com"]);
    const { client, server } = await connectLocal(vault, { mayRelease: (name) => !name.startsWith("mail.") });
    await expect(client.use("mail.a", "smtp:smtp.example.com")).rejects.toThrow(/mail\.a/);
    // Inside the process it's still usable, by what is registered there.
    server.register("mail.peek", () => server.vault.use("mail.a", "smtp:smtp.example.com").length);
    expect(await client.call("mail.peek")).toBe("mail-password".length);
  });

  it("redacts in the Vault process", async () => {
    const vault = new Vault(dir, fake);
    vault.set("mail.a", "hunter2-long-secret");
    const { client } = await connectLocal(vault, { mayRelease: () => false });
    expect(await client.redact("the password is hunter2-long-secret.")).toBe("the password is «kasadaki mail.a».");
    expect(await client.redact("")).toBe("");
  });

  it("carries a refusal's name and a not-sent mark across", async () => {
    const vault = new Vault(dir, fake);
    const { client, server } = await connectLocal(vault);
    server.register("fail", () => {
      const err = new Error("refused before sending");
      err.name = "MailNotSent";
      (err as Error & { notSent: boolean }).notSent = true;
      throw err;
    });
    const err = (await client.call("fail").catch((e: unknown) => e)) as Error & { notSent?: boolean };
    expect(err.name).toBe("MailNotSent");
    expect(err.notSent).toBe(true);
    expect(fromRemoteError(toRemoteError("plain"))).toBeInstanceOf(Error);
    await expect(client.call("nope")).rejects.toThrow(/Unknown vault operation/);
    await expect(client.call("set", [1, 2])).rejects.toThrow(/must be a string/);
  });

  it("fails waiting calls when the process goes away, and reads as locked", async () => {
    const [serverEnd, clientEnd] = portPair();
    // A server that never answers.
    serverEnd.onMessage(() => undefined);
    const client = new VaultClient(clientEnd, 50);
    await expect(client.call("state")).rejects.toThrow();
    const waiting = client.call("state", [], 5_000);
    client.detach("gone");
    await expect(waiting).rejects.toThrow("gone");
    await expect(client.use("x")).rejects.toThrow();
    expect(client.available).toBe(false);
  });

  it("picks up a new process with attach()", async () => {
    const vault = new Vault(dir, fake);
    const client = new VaultClient();
    await expect(client.refresh()).rejects.toThrow();
    const [serverEnd, clientEnd] = portPair();
    new VaultServer(vault).attach(serverEnd);
    client.attach(clientEnd);
    let changes = 0;
    client.onChange(() => { changes++; });
    await client.set("a.b", "value-long-enough");
    expect(client.has("a.b")).toBe(true);
    expect(changes).toBeGreaterThan(0);
    const sealed = await client.sealedEntries();
    expect(sealed).toEqual([]);
  });

  it("passes events from the Vault process, and says when it went away", async () => {
    const { client, server } = await connectLocal(new Vault(dir, fake));
    const got: unknown[] = [];
    const stop = client.onEvent("mcp.data", (data) => got.push(data));
    client.onEvent("other", () => got.push("wrong channel"));
    server.emit("mcp.data", { handle: "h1", chunk: "hello\n" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(got).toEqual([{ handle: "h1", chunk: "hello\n" }]);
    stop();
    server.emit("mcp.data", { handle: "h1", chunk: "again" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(got).toHaveLength(1);
    const reasons: string[] = [];
    client.onDetach((reason) => reasons.push(reason));
    client.detach("gone");
    client.detach("twice");
    expect(reasons).toEqual(["gone"]);
  });
});
