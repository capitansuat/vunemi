/**
 * The Vault process: an Electron utility process that holds the Vault key
 * and the mail secrets, so the main process never does.
 *
 * It asks the signed Swift helper for the key itself — the key never passes
 * through main — opens vault.json, and then answers requests from main
 * (see @vunemi/vault remote.ts and ./mail.ts). Logs carry names and errors,
 * never a value.
 */
import { keyBroker } from "./unlock.js";
import { isLocale, setLocale } from "@vunemi/i18n";
import { KeyCrypto, Vault, VaultServer, type Port } from "@vunemi/vault";
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
    const crypto = new KeyCrypto();
    const broker = keyBroker(crypto, init.helperPath!);
    try { await broker.unlock(); }
    catch { console.error("[vunemi vault] Keychain access unavailable; explicit unlock required."); }
    const vault = new Vault(init.userData!, crypto);
    for (const { name, reason } of vault.unreadable()) console.error(`[vunemi vault] "${name}" unreadable: ${reason}`);
    const server = new VaultServer(vault, { mayRelease });
    server.register("unlock", async () => {
      await broker.unlock(true);
      vault.reopen();
    });
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
    console.error(`[vunemi vault] failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
});
