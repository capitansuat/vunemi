import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { ImapSmtpAccount, neverAccepted } from "../src/imap-account.js";
import { MailNotSent, type Draft } from "../src/types.js";
import { FakeSmtp, makeCertificate, type FakeSmtpOptions } from "./fake-smtp.js";

// Real nodemailer against a local SMTP server: the outcome of a send is
// decided by what the server said, so it is tried against each answer.

const draft: Draft = { to: ["friend@example.com"], subject: "Hello", body: "Synthetic test message." };
let certificate: { key: string; cert: string };
let server: FakeSmtp | null = null;

beforeAll(() => { certificate = makeCertificate(); });
afterEach(async () => { await server?.stop(); server = null; });

async function start(options: FakeSmtpOptions): Promise<FakeSmtp> {
  server = new FakeSmtp({ tls: true, ...options }, certificate);
  await server.start();
  return server;
}

function account(port: number, { trust = true, password = "secret" as string | { accessToken: string } } = {}) {
  return new ImapSmtpAccount({
    email: "me@example.com", user: "me", imapHost: "localhost", imapPort: 993,
    smtpHost: "127.0.0.1", smtpPort: port, smtpSecure: false,
  }, async () => password, trust ? certificate.cert : undefined);
}

async function outcome(promise: Promise<void>): Promise<"sent" | "not-sent" | "unknown"> {
  try {
    await promise;
    return "sent";
  } catch (err) {
    return err instanceof MailNotSent ? "not-sent" : "unknown";
  }
}

describe("sending through SMTP", () => {
  it("signs in with an OAuth access token (XOAUTH2), after encryption", async () => {
    const smtp = await start({ accessToken: "ya29.synthetic" });
    await account(smtp.port, { password: { accessToken: "ya29.synthetic" } }).send(draft);
    expect(smtp.received).toHaveLength(1);
    expect(smtp.authAttempts.every((attempt) => attempt.secure)).toBe(true);
  });

  it("calls a refused access token not sent", async () => {
    const smtp = await start({ accessToken: "ya29.synthetic" });
    expect(await outcome(account(smtp.port, { password: { accessToken: "ya29.expired" } }).send(draft))).toBe("not-sent");
    expect(smtp.received).toEqual([]);
  });

  it("calls a token that couldn't be fetched not sent", async () => {
    const smtp = await start({});
    const failing = new ImapSmtpAccount({
      email: "me@example.com", user: "me", imapHost: "localhost", imapPort: 993,
      smtpHost: "127.0.0.1", smtpPort: smtp.port, smtpSecure: false,
    }, async () => { throw new Error("refresh refused"); }, certificate.cert);
    expect(await outcome(failing.send(draft))).toBe("not-sent");
    expect(smtp.authAttempts).toEqual([]);
  });

  it("delivers over STARTTLS and signs in only after the upgrade", async () => {
    const smtp = await start({});
    await account(smtp.port).send(draft);
    expect(smtp.received).toHaveLength(1);
    expect(smtp.received[0]!.to).toEqual(["friend@example.com"]);
    expect(smtp.received[0]!.data).toContain("Synthetic test message.");
    // Once to check the way is open, once to send; both after encryption.
    expect(smtp.authAttempts).toEqual([{ secure: true }, { secure: true }]);
  });

  it("never sends the password when the server offers no encryption", async () => {
    const smtp = await start({ tls: false });
    expect(await outcome(account(smtp.port).send(draft))).toBe("not-sent");
    expect(smtp.authAttempts).toEqual([]);
    expect(smtp.received).toEqual([]);
  });

  it("never signs in to a server whose certificate isn't trusted", async () => {
    const smtp = await start({});
    expect(await outcome(account(smtp.port, { trust: false }).send(draft))).toBe("not-sent");
    expect(smtp.authAttempts).toEqual([]);
    expect(smtp.received).toEqual([]);
  });

  it("calls a refused password not sent", async () => {
    const smtp = await start({});
    expect(await outcome(account(smtp.port, { password: "wrong" }).send(draft))).toBe("not-sent");
    expect(smtp.received).toEqual([]);
  });

  it("calls a refused connection not sent", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(await outcome(account(port).send(draft))).toBe("not-sent");
  });

  it("calls a message the server refused after reading it not sent", async () => {
    const smtp = await start({ refuseMessage: true });
    expect(await outcome(account(smtp.port).send(draft))).toBe("not-sent");
  });

  it("calls every recipient refused not sent", async () => {
    const smtp = await start({ reject: ["friend@example.com"] });
    expect(await outcome(account(smtp.port).send(draft))).toBe("not-sent");
    expect(smtp.received).toEqual([]);
  });

  it("leaves a partly refused message uncertain, never sent and never retried", async () => {
    const smtp = await start({ reject: ["nobody@example.com"] });
    const error = await account(smtp.port).send({ ...draft, to: ["friend@example.com", "nobody@example.com"] }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MailNotSent);
    expect(smtp.received).toHaveLength(1);
    expect(smtp.received[0]!.to).toEqual(["friend@example.com"]);
  });

  it("leaves a connection dropped after the message uncertain", async () => {
    const smtp = await start({ dropAfterData: true });
    expect(await outcome(account(smtp.port).send(draft))).toBe("unknown");
  });
});

describe("which SMTP failures mean nothing left", () => {
  it("counts refusals before the message and refusals of the message", () => {
    expect(neverAccepted({ code: "EAUTH", command: "AUTH PLAIN" })).toBe(true);
    expect(neverAccepted({ code: "ETLS", command: "CONN" })).toBe(true);
    expect(neverAccepted({ code: "EENVELOPE", command: "RCPT TO" })).toBe(true);
    expect(neverAccepted({ code: "ESOCKET", command: "CONN", syscall: "connect" })).toBe(true);
    expect(neverAccepted({ code: "ETIMEDOUT", command: "CONN", message: "Greeting never received" })).toBe(true);
    expect(neverAccepted({ code: "EMESSAGE", command: "DATA", responseCode: 554 })).toBe(true);
  });

  it("doesn't count a dropped connection after the greeting or an unknown error", () => {
    // Nodemailer says "CONN" for a drop in the middle of the message too.
    expect(neverAccepted({ code: "ECONNECTION", command: "CONN", message: "Connection closed unexpectedly" })).toBe(false);
    expect(neverAccepted({ code: "ETIMEDOUT", command: "CONN", message: "Timeout" })).toBe(false);
    expect(neverAccepted({ code: "ESOCKET", command: "CONN", syscall: "read" })).toBe(false);
    expect(neverAccepted({ code: "EMESSAGE", command: "DATA" })).toBe(false);
    expect(neverAccepted(new Error("boom"))).toBe(false);
    expect(neverAccepted(null)).toBe(false);
  });
});
