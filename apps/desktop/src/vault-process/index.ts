/**
 * The Vault process: an Electron utility process that holds the Vault key
 * and the mail secrets, so the main process never does.
 *
 * On macOS it asks the signed Swift helper for the key itself — the key never
 * passes through main. On Linux main hands it the key that safeStorage and
 * the system keyring keep (main/vault-key-linux.ts). Then it opens vault.json, and then answers requests from main
 * (see @vunemi/vault remote.ts and ./mail.ts). Logs carry names and errors,
 * never a value.
 */
import { keyBroker } from "./unlock.js";
import { isLocale, setLocale } from "@vunemi/i18n";
import { KeyCrypto, LINUX_MAGIC, Vault, VaultServer, type Port } from "@vunemi/vault";
import { mayRelease, serveMail } from "./mail.js";
import { serveMcp } from "./mcp.js";

interface Init {
  kind: "init";
  userData: string;
  helperPath: string;
  locale: string;
  /** Linux: the key comes from main, which alone can use safeStorage. */
  keySource?: "keychain-helper" | "safe-storage";
  /** Linux: the key, base64, when the keyring gave one. */
  key?: string;
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
    if (init.keySource === "safe-storage") return startWithKey(init as Init);
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

/**
 * Linux: the key arrives from main, now or on the Vault button. Without a
 * keyring it never arrives, and the Vault stays locked: it refuses to store
 * anything rather than store it readable.
 */
async function startWithKey(init: Init): Promise<void> {
  const crypto = new KeyCrypto(LINUX_MAGIC);
  const take = (key: unknown): void => {
    if (typeof key !== "string") throw new Error("No vault key: the system keyring did not give one.");
    crypto.unlock(Buffer.from(key, "base64"));
  };
  if (init.key) take(init.key);
  else console.error("[vunemi vault] No keyring key; the Vault stays locked.");
  const vault = new Vault(init.userData, crypto);
  for (const { name, reason } of vault.unreadable()) console.error(`[vunemi vault] "${name}" unreadable: ${reason}`);
  const server = new VaultServer(vault, { mayRelease });
  server.register("unlock", async (key: unknown) => {
    if (!crypto.available) take(key);
    vault.reopen();
  });
  server.register("locale", (locale: unknown) => {
    if (typeof locale === "string" && isLocale(locale)) setLocale(locale);
  });
  serveMail(server);
  const mcp = serveMcp(server);
  process.on("exit", () => mcp.dispose());
  server.attach(port);
  parent!.postMessage({ kind: "ready", state: vault.state() });
}
