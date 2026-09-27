/**
 * The Vault process: an Electron utility process that holds the Vault key
 * and the mail secrets, so the main process never does.
 *
 * It asks the signed Swift helper for the key itself — the key never passes
 * through main — opens vault.json, and then answers requests from main
 * (see @ocak/vault remote.ts and ./mail.ts). Logs carry names and errors,
 * never a value.
 */
import { Helper } from "@ocak/mac";
import { isLocale, setLocale } from "@ocak/i18n";
import { KeyCrypto, Vault, VaultServer, type Port } from "@ocak/vault";
import { mayRelease, serveMail } from "./mail.js";
import { serveMcp } from "./mcp.js";

interface Init {
  kind: "init";
  userData: string;
  helperPath: string;
  locale: string;
}

interface ParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parent) throw new Error("The Vault process must be started by Vunemi.");

async function unlock(helperPath: string): Promise<KeyCrypto> {
  const crypto = new KeyCrypto();
  // Its own helper process, so a keychain prompt waiting on the user holds up nothing else.
  const helper = new Helper(helperPath);
  try {
    const { key } = (await helper.call("vault_key", { create: true }, { timeoutMs: 30_000 })) as { key: unknown };
    if (typeof key !== "string") throw new Error("no key came back");
    crypto.unlock(Buffer.from(key, "base64"));
  } catch (err) {
    console.error(`[ocak vault] no key, the vault stays locked: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    helper.dispose();
  }
  return crypto;
}

let started = false;
const port: Port = {
  post: (message) => parent.postMessage(message),
  onMessage: (handler) => parent.on("message", (event) => handler(event.data)),
};

parent.on("message", (event) => {
  const init = event.data as Partial<Init>;
  if (started || !init || init.kind !== "init") return;
  if (typeof init.userData !== "string" || typeof init.helperPath !== "string") return;
  started = true;
  if (typeof init.locale === "string" && isLocale(init.locale)) setLocale(init.locale);
  void (async () => {
    const vault = new Vault(init.userData!, await unlock(init.helperPath!));
    for (const { name, reason } of vault.unreadable()) console.error(`[ocak vault] "${name}" unreadable: ${reason}`);
    const server = new VaultServer(vault, { mayRelease });
    server.register("locale", (locale: unknown) => {
      if (typeof locale === "string" && isLocale(locale)) setLocale(locale);
    });
    serveMail(server);
    const mcp = serveMcp(server);
    // The servers it started go with it.
    process.on("exit", () => mcp.dispose());
    server.attach(port);
    parent.postMessage({ kind: "ready", state: vault.state() });
  })().catch((err: unknown) => {
    console.error(`[ocak vault] failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
});
