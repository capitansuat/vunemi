/**
 * The Vault: where secrets live, and the one part of Vunemi that a prompt
 * injection cannot argue with.
 *
 * The rule is structural, not probabilistic: the model is told a secret's
 * *name* and never its value. Values are decrypted in the main process, used
 * there, and redacted out of anything on its way to the model — tool output,
 * previews, the activity log. Forcing the agent to "reveal the token" is
 * pointless when the agent never had it.
 *
 * Encryption is delegated: the desktop app passes Electron's safeStorage,
 * which is backed by the system keychain; tests pass a fake. If no real
 * crypto is available the Vault refuses to store anything rather than
 * writing secrets in the clear.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "@ocak/i18n";

export interface SecretCrypto {
  readonly available: boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

/** What the rest of the app — and the model — may know about a secret. */
export interface SecretInfo {
  name: string;
  /** What it's for, in the user's words. */
  note?: string;
  createdAt: number;
  lastUsedAt?: number;
}

/** Shorter values collide with ordinary text; redacting them would be noise. */
const MIN_REDACT = 6;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/**
 * A bound secret's plaintext starts with this, then JSON {value, bind}. The
 * binding is inside what GCM authenticates, so editing vault.json can't move
 * a secret to another server; only a secret written before binding existed
 * lacks it.
 */
const BOUND = "\u0000tenami-bound\u0000";
const TARGET = /^[a-z][a-z0-9+.-]*:[^\s\0]{1,300}$/i;
const FILE = "vault.json";

/**
 * Everything about the Vault that isn't a value: what another process may
 * mirror to answer list() and has() without asking, and without holding a
 * secret.
 */
export interface VaultState {
  available: boolean;
  secrets: SecretInfo[];
  /** Names whose value this copy can read. */
  readable: string[];
  binds: Record<string, string[]>;
  unreadable: { name: string; reason: string }[];
}

interface StoredEntry {
  name: string;
  note?: string;
  createdAt: number;
  lastUsedAt?: number;
  cipher: string;
}

interface Stored {
  version: 1;
  entries: StoredEntry[];
}

export class Vault {
  /** name → plaintext. Main process only; never crosses IPC. */
  private readonly values = new Map<string, string>();
  /** name → where the secret may be used, e.g. "smtp:smtp.gmail.com". Absent: not bound (yet). */
  private readonly binds = new Map<string, string[]>();
  private readonly meta = new Map<string, SecretInfo>();
  /**
   * Entries this copy of the app cannot decrypt, kept byte for byte. After
   * a rebuild the keychain can refuse the app until the user allows it; the
   * ciphertext is still their secret, and writing some other secret must
   * not be the thing that erases it. Only set() and delete() of that name,
   * or clear(), let one go.
   */
  private readonly sealed = new Map<string, StoredEntry>();
  /** Why each sealed entry could not be read: the error, never the value. */
  private readonly reasons = new Map<string, string>();

  constructor(
    private readonly dir: string,
    private readonly crypto: SecretCrypto,
  ) {
    this.load();
  }

  get available(): boolean {
    return this.crypto.available;
  }

  /** Names and notes only. Safe to show the user, and to tell the model. */
  list(): SecretInfo[] {
    return [...this.meta.values()].sort((a, b) => a.name.localeCompare(b.name, "tr"));
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  /**
   * Stores a secret. `bind` names the only places it may be used from then on
   * (see use()); without it an existing binding is kept, and a new secret can
   * be used wherever its name is asked for.
   */
  set(name: string, value: string, note?: string, bind?: string[]): void {
    if (!NAME.test(name)) throw new Error(t("vaultStore.badName"));
    if (value === "") throw new Error(t("vaultStore.empty"));
    if (bind && (bind.length === 0 || bind.length > 8 || !bind.every((target) => TARGET.test(target)))) throw new Error(t("vaultStore.badTarget"));
    if (!this.crypto.available) {
      throw new Error(t("vaultStore.unavailable"));
    }
    const existing = this.meta.get(name);
    const previous = this.values.get(name);
    const wasSealed = this.sealed.get(name);
    const previousBind = this.binds.get(name);
    this.values.set(name, value);
    // Without a new binding an existing one stays: replacing a value never frees it.
    if (bind) this.binds.set(name, [...new Set(bind)]);
    this.sealed.delete(name);
    this.reasons.delete(name);
    this.meta.set(name, { name, createdAt: existing?.createdAt ?? Date.now(), ...(note ? { note } : {}) });
    try {
      this.save();
    } catch (err) {
      if (previous === undefined) this.values.delete(name);
      else this.values.set(name, previous);
      if (previousBind) this.binds.set(name, previousBind);
      else this.binds.delete(name);
      if (wasSealed) this.sealed.set(name, wasSealed);
      if (existing) this.meta.set(name, existing);
      else this.meta.delete(name);
      throw err;
    }
  }

  delete(name: string): void {
    const previous = this.values.get(name);
    const info = this.meta.get(name);
    const wasSealed = this.sealed.get(name);
    const previousBind = this.binds.get(name);
    this.values.delete(name);
    this.binds.delete(name);
    this.meta.delete(name);
    this.sealed.delete(name);
    this.reasons.delete(name);
    try {
      this.save();
    } catch (err) {
      if (previous !== undefined) this.values.set(name, previous);
      if (previousBind) this.binds.set(name, previousBind);
      if (info) this.meta.set(name, info);
      if (wasSealed) this.sealed.set(name, wasSealed);
      throw err;
    }
  }

  clear(): void {
    const previousValues = new Map(this.values);
    const previousMeta = new Map(this.meta);
    const previousSealed = new Map(this.sealed);
    const previousBinds = new Map(this.binds);
    this.values.clear();
    this.binds.clear();
    this.meta.clear();
    this.sealed.clear();
    this.reasons.clear();
    try {
      this.save();
    } catch (err) {
      for (const [name, value] of previousValues) this.values.set(name, value);
      for (const [name, info] of previousMeta) this.meta.set(name, info);
      for (const [name, entry] of previousSealed) this.sealed.set(name, entry);
      for (const [name, bind] of previousBinds) this.binds.set(name, bind);
      throw err;
    }
  }

  /**
   * The locked entries as stored: name, the user's note, the ciphertext. For
   * moving a secret written by an older scheme into the current one — the
   * caller decrypts it the old way and set()s it again. Never a value.
   */
  sealedEntries(): { name: string; note?: string; cipher: Buffer }[] {
    return [...this.sealed.values()].map((e) => ({
      name: e.name,
      ...(e.note ? { note: e.note } : {}),
      cipher: Buffer.from(e.cipher, "base64"),
    }));
  }

  /** The entries it holds but cannot read, and why. Names and errors only. */
  unreadable(): { name: string; reason: string }[] {
    return [...this.sealed.keys()].map((name) => ({ name, reason: this.reasons.get(name) ?? "" }));
  }

  /**
   * Tries the unreadable entries again. The keychain may refuse early and
   * allow later — before the app is ready, or once the user has allowed
   * this copy of Vunemi — and a secret should not stay locked until the next
   * launch because of when it was first asked for.
   */
  reopen(): { opened: string[]; still: { name: string; reason: string }[] } {
    const opened = [...this.sealed.values()].filter((e) => this.open(e)).map((e) => e.name);
    return { opened, still: this.unreadable() };
  }

  /**
   * The value itself. Only the main process may call this, and only to hand
   * it straight to the thing that needs it — never back to the model.
   */
  use(name: string, target?: string): string {
    const value = this.values.get(name);
    if (value === undefined) throw new Error(t("vaultStore.noSuch", { name }));
    const bound = this.binds.get(name);
    if (bound) {
      // A bound secret goes only where it was stored for.
      if (target === undefined || !bound.includes(target)) throw new Error(t("vaultStore.wrongTarget", { name, target: target ?? "—" }));
    }
    const info = this.meta.get(name)!;
    this.meta.set(name, { ...info, lastUsedAt: Date.now() });
    this.save();
    return value;
  }

  /**
   * Binds a secret stored before binding existed to every place its owner
   * uses it (an account's IMAP and SMTP servers, say). A bound secret keeps
   * its binding: this never widens one.
   */
  adopt(name: string, bind: string[]): void {
    if (!this.values.has(name) || this.binds.has(name)) return;
    if (bind.length === 0 || bind.length > 8 || !bind.every((target) => TARGET.test(target))) throw new Error(t("vaultStore.badTarget"));
    this.binds.set(name, [...new Set(bind)]);
    try {
      this.save();
    } catch (err) {
      this.binds.delete(name);
      throw err;
    }
  }

  /** Names, notes, bindings and errors: never a value. */
  state(): VaultState {
    return {
      available: this.available,
      secrets: this.list(),
      readable: [...this.values.keys()],
      binds: Object.fromEntries([...this.binds].map(([name, bind]) => [name, [...bind]])),
      unreadable: this.unreadable(),
    };
  }

  /** Where a secret may be used; empty when it isn't bound yet. Never the value. */
  targets(name: string): string[] {
    return [...(this.binds.get(name) ?? [])];
  }

  /**
   * Replaces any stored secret found in `text` with its name. Applied to
   * everything the model is about to read, so a page that echoes a token —
   * or a tool that returns one — still can't leak it into the context.
   */
  redact(text: string): string {
    if (!text) return text;
    let out = text;
    // Longest first, so a secret containing another is masked as one piece.
    const entries = [...this.values.entries()].filter(([, v]) => v.length >= MIN_REDACT).sort((a, b) => b[1].length - a[1].length);
    for (const [name, value] of entries) {
      if (!out.includes(value)) continue;
      out = out.split(value).join(`«kasadaki ${name}»`);
    }
    return out;
  }

  // -- internals -------------------------------------------------------------

  private get file(): string {
    return join(this.dir, FILE);
  }

  private load(): void {
    let raw: Stored;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8")) as Stored;
    } catch {
      return; // no vault yet
    }
    for (const e of raw.entries ?? []) this.open(e);
  }

  /**
   * Decrypts one stored entry, or keeps it sealed. Sealed means: written by
   * another machine, another login keychain, or a copy of Vunemi the keychain
   * does not trust yet — or asked for before decryption was ready. The name
   * stays visible, the ciphertext is kept so nothing is lost, and the value
   * is never guessed at.
   */
  private open(e: StoredEntry): boolean {
    try {
      const plain = this.crypto.decrypt(Buffer.from(e.cipher, "base64"));
      if (plain.startsWith(BOUND)) {
        const { value, bind } = JSON.parse(plain.slice(BOUND.length)) as { value: string; bind: string[] };
        this.values.set(e.name, value);
        this.binds.set(e.name, bind);
      } else {
        this.values.set(e.name, plain);
        this.binds.delete(e.name);
      }
      this.meta.set(e.name, {
        name: e.name,
        createdAt: e.createdAt,
        ...(e.note ? { note: e.note } : {}),
        ...(e.lastUsedAt ? { lastUsedAt: e.lastUsedAt } : {}),
      });
      this.sealed.delete(e.name);
      this.reasons.delete(e.name);
      return true;
    } catch (err) {
      this.sealed.set(e.name, e);
      this.reasons.set(e.name, err instanceof Error ? err.message : String(err));
      this.meta.set(e.name, { name: e.name, createdAt: e.createdAt, note: t("vaultStore.unreadableNote") });
      return false;
    }
  }

  private plaintext(name: string, value: string): string {
    const bind = this.binds.get(name);
    return bind ? `${BOUND}${JSON.stringify({ value, bind })}` : value;
  }

  private save(): void {
    const stored: Stored = {
      version: 1,
      entries: this.list().flatMap((info) => {
        const value = this.values.get(info.name);
        if (value === undefined) {
          // Written back exactly as it was read, original note included.
          const kept = this.sealed.get(info.name);
          return kept ? [kept] : [];
        }
        return [
          {
            name: info.name,
            ...(info.note ? { note: info.note } : {}),
            createdAt: info.createdAt,
            ...(info.lastUsedAt ? { lastUsedAt: info.lastUsedAt } : {}),
            cipher: this.crypto.encrypt(this.plaintext(info.name, value)).toString("base64"),
          },
        ];
      }),
    };
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(stored, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
