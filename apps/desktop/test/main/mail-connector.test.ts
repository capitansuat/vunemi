import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mailConnector, type CatalogueOptions } from "../../src/main/connectors.js";
import type { StoredMailAccount } from "../../src/main/settings.js";

let dir: string;
let fake: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-mailapp-"));
  fake = join(dir, "osascript");
  // Plays Mail: two enabled accounts and one switched off; searches find one message.
  writeFileSync(fake, `#!/usr/bin/env node
const script = process.argv[process.argv.indexOf("-e") + 1];
const marker = /^\\/\\/ (\\w+)/.exec(script)[1];
const answers = {
  MAIL_ACCOUNTS: { accounts: [
    { name: "iCloud", emails: ["test@example.com"], enabled: true },
    { name: "Work", emails: ["work@example.com"], enabled: true },
    { name: "Old", emails: ["old@example.com"], enabled: false },
  ] },
  MAIL_READY: { ready: true },
  MAIL_SEARCH: { messages: [{ id: 7, path: ["\\u2400inbox"], from: { address: "a@example.com" }, subject: "Hi", date: "2026-09-28T08:00:00.000Z", unread: true, hasAttachments: false, snippet: "hello" }] },
};
process.stdout.write(JSON.stringify(answers[marker] || {}));
`);
  chmodSync(fake, 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function connector(existing: StoredMailAccount[] = []) {
  const saves: StoredMailAccount[][] = [];
  const c = mailConnector({ osascript: fake, mailAccounts: existing, saveMailAccounts: (list: StoredMailAccount[]) => saves.push(list) } as unknown as CatalogueOptions);
  return { c, saves };
}

describe("Mail app accounts in the mail connection", () => {
  it("offers the Mail app first", () => {
    expect(connector().c.providers?.[0]?.id).toBe("applemail");
  });

  it("connects an account Mail has, without the Vault, and it is ready", async () => {
    const { c, saves } = connector();
    const added = await c.addAccount!("applemail", { account: "iCloud" });
    expect(added).toMatchObject({ label: "test@example.com", provider: "applemail", state: "ready" });
    expect(saves.at(-1)).toMatchObject([{ provider: "applemail", account: "iCloud", email: "test@example.com" }]);
    expect(await c.status()).toMatchObject({ state: "ready" });
    expect((await c.accounts!()).map((a) => a.state)).toEqual(["ready"]);
  });

  it("refuses an account Mail doesn't have enabled", async () => {
    const { c } = connector();
    await expect(c.addAccount!("applemail", { account: "Old" })).rejects.toThrow();
    await expect(c.addAccount!("applemail", { account: "Nope" })).rejects.toThrow();
  });

  it("refuses an address that is already connected another way", async () => {
    const { c } = connector([{ id: "imap-1", config: { email: "test@example.com", user: "u", imapHost: "imap.example.com", imapPort: 993, smtpHost: "smtp.example.com", smtpPort: 587, smtpSecure: false }, addedAt: 1 }]);
    await expect(c.addAccount!("applemail", { account: "iCloud" })).rejects.toThrow();
  });

  it("searches it with the ordinary mail tools", async () => {
    const { c } = connector([{ id: "a-1", provider: "applemail", account: "iCloud", email: "test@example.com", addedAt: 1 }]);
    const search = c.tools().find((tool) => tool.name === "mail_search")!;
    const out = await search.run({ text: "Hi" }, {} as never);
    expect(out).toContain("1 message");
    expect(out).toContain("Hi");
  });

  it("forgets it on removal without touching the Vault", async () => {
    const { c, saves } = connector([{ id: "a-1", provider: "applemail", account: "iCloud", email: "test@example.com", addedAt: 1 }]);
    await c.removeAccount!("a-1");
    expect(saves.at(-1)).toEqual([]);
    expect(await c.accounts!()).toEqual([]);
  });
});
