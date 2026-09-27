/**
 * The Vault in a process of its own. The process that holds the key serves
 * requests; the main process holds a VaultClient, which mirrors everything
 * about the Vault except the values — names, notes, bindings — so it can
 * list and check secrets without asking, and asks for everything else.
 *
 * What may cross back is the server's decision, not the client's: a value
 * the server won't release (a mail password, say) is used only inside the
 * Vault process, by handlers registered there.
 */

import { t } from "@vunemi/i18n";
import type { SecretInfo, Vault, VaultState } from "./vault.js";

/** One end of a message channel: a MessagePort, a utilityProcess, or a test pair. */
export interface Port {
  post(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
}

/** An error as it crosses: enough to rebuild it, nothing else. */
export interface RemoteError {
  name: string;
  message: string;
  /** MailNotSent's mark: the outbox reads it to know nothing left the Mac. */
  notSent?: boolean;
}

interface CallMessage {
  kind: "call";
  id: number;
  op: string;
  args: unknown[];
}

/** Something the Vault process says unasked, e.g. a server's output. */
interface EventMessage {
  kind: "event";
  channel: string;
  data: unknown;
}

interface ReplyMessage {
  kind: "reply";
  id: number;
  ok: boolean;
  value?: unknown;
  error?: RemoteError;
  state: VaultState;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (...args: any[]) => unknown;

export interface ServeOptions {
  /** Whether the value of `name` may leave this process for `target`. Default: yes. */
  mayRelease?: (name: string, target: string | undefined) => boolean;
}

const str = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw new TypeError(`${what} must be a string`);
  return value;
};
const optionalStr = (value: unknown, what: string): string | undefined =>
  value === undefined || value === null ? undefined : str(value, what);
const strings = (value: unknown, what: string): string[] => {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new TypeError(`${what} must be a list of strings`);
  return value as string[];
};

export function toRemoteError(err: unknown): RemoteError {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      ...((err as { notSent?: unknown }).notSent === true && { notSent: true }),
    };
  }
  return { name: "Error", message: String(err) };
}

export function fromRemoteError(remote: RemoteError): Error {
  const err = new Error(remote.message);
  err.name = remote.name;
  if (remote.notSent) (err as Error & { notSent: boolean }).notSent = true;
  return err;
}

export class VaultServer {
  private readonly ops = new Map<string, Handler>();
  private readonly ports: Port[] = [];

  constructor(readonly vault: Vault, private readonly opts: ServeOptions = {}) {
    this.ops.set("state", () => undefined);
    this.ops.set("set", (name, value, note, bind) => {
      this.vault.set(str(name, "name"), str(value, "value"), optionalStr(note, "note"), bind === undefined || bind === null ? undefined : strings(bind, "bind"));
    });
    this.ops.set("delete", (name) => this.vault.delete(str(name, "name")));
    this.ops.set("adopt", (name, bind) => this.vault.adopt(str(name, "name"), strings(bind, "bind")));
    this.ops.set("use", (name, target) => {
      const key = str(name, "name");
      const where = optionalStr(target, "target");
      if (this.opts.mayRelease && !this.opts.mayRelease(key, where)) throw new Error(t("vaultStore.keptInside", { name: key }));
      return this.vault.use(key, where);
    });
    this.ops.set("redact", (text) => this.vault.redact(str(text, "text")));
    this.ops.set("clear", () => this.vault.clear());
    this.ops.set("reopen", () => this.vault.reopen());
    this.ops.set("sealedEntries", () =>
      this.vault.sealedEntries().map((entry) => ({ ...entry, cipher: entry.cipher.toString("base64") })));
  }

  /** Adds an operation run inside this process, e.g. "mail.send". */
  register(op: string, handler: Handler): void {
    if (this.ops.has(op)) throw new Error(`"${op}" is already registered`);
    this.ops.set(op, handler);
  }

  async handle(op: string, args: unknown[]): Promise<unknown> {
    const handler = this.ops.get(op);
    if (!handler) throw new Error(`Unknown vault operation "${op}"`);
    return handler(...args);
  }

  /** Tells every attached client something unasked. */
  emit(channel: string, data: unknown): void {
    for (const port of this.ports) port.post({ kind: "event", channel, data } satisfies EventMessage);
  }

  attach(port: Port): void {
    this.ports.push(port);
    port.onMessage((message) => {
      const call = message as Partial<CallMessage>;
      if (!call || call.kind !== "call" || typeof call.id !== "number" || typeof call.op !== "string" || !Array.isArray(call.args)) return;
      const id = call.id;
      void this.handle(call.op, call.args).then(
        (value) => port.post({ kind: "reply", id, ok: true, value, state: this.vault.state() } satisfies ReplyMessage),
        (err: unknown) => port.post({ kind: "reply", id, ok: false, error: toRemoteError(err), state: this.vault.state() } satisfies ReplyMessage),
      );
    });
  }
}

const EMPTY: VaultState = { available: false, secrets: [], readable: [], binds: {}, unreadable: [] };
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The main process's Vault. Reads come from a mirror kept current by every
 * reply; writes and uses go to the Vault process. It never holds a value it
 * wasn't handed by use().
 */
export class VaultClient {
  private port: Port | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private mirror: VaultState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private readonly events = new Map<string, Set<(data: unknown) => void>>();
  private readonly detachListeners = new Set<(reason: string) => void>();

  constructor(port?: Port, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (port) this.attach(port);
  }

  /** Talks to a (new) Vault process from now on; calls in flight on the old one fail. */
  attach(port: Port): void {
    this.detach(t("vaultStore.processGone"));
    this.port = port;
    port.onMessage((message) => {
      if (this.port !== port) return;
      const event = message as Partial<EventMessage>;
      if (event?.kind === "event" && typeof event.channel === "string") {
        for (const listener of this.events.get(event.channel) ?? []) listener(event.data);
        return;
      }
      const reply = message as Partial<ReplyMessage>;
      if (!reply || reply.kind !== "reply" || typeof reply.id !== "number") return;
      if (reply.state) this.update(reply.state);
      const waiting = this.pending.get(reply.id);
      if (!waiting) return;
      this.pending.delete(reply.id);
      clearTimeout(waiting.timer);
      if (reply.ok) waiting.resolve(reply.value);
      else waiting.reject(fromRemoteError(reply.error ?? { name: "Error", message: "unknown error" }));
    });
  }

  /** The Vault process is gone: every waiting call fails, and the vault reads as locked. */
  detach(reason: string): void {
    const had = this.port !== null;
    this.port = null;
    if (had) for (const listener of this.detachListeners) listener(reason);
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error(reason));
      this.pending.delete(id);
    }
    if (this.mirror.available) this.update({ ...this.mirror, available: false });
  }

  /** Things the Vault process says unasked, on one channel. */
  onEvent(channel: string, listener: (data: unknown) => void): () => void {
    let set = this.events.get(channel);
    if (!set) this.events.set(channel, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /** The Vault process went away: whatever it was running for us is gone with it. */
  onDetach(listener: (reason: string) => void): () => void {
    this.detachListeners.add(listener);
    return () => this.detachListeners.delete(listener);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get available(): boolean {
    return this.mirror.available;
  }

  list(): SecretInfo[] {
    return this.mirror.secrets.map((info) => ({ ...info }));
  }

  /** Whether the Vault holds a readable value by that name. */
  has(name: string): boolean {
    return this.mirror.readable.includes(name);
  }

  targets(name: string): string[] {
    return [...(this.mirror.binds[name] ?? [])];
  }

  unreadable(): { name: string; reason: string }[] {
    return this.mirror.unreadable.map((item) => ({ ...item }));
  }

  call<T = unknown>(op: string, args: unknown[] = [], timeoutMs = this.timeoutMs): Promise<T> {
    const port = this.port;
    if (!port) return Promise.reject(new Error(t("vaultStore.processGone")));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(t("vaultStore.processTimeout", { seconds: Math.round(timeoutMs / 1000) })));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        port.post({ kind: "call", id, op, args } satisfies CallMessage);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Fetches the current state; the mirror updates with the reply. */
  async refresh(): Promise<void> {
    await this.call("state");
  }

  async set(name: string, value: string, note?: string, bind?: string[]): Promise<void> {
    await this.call("set", [name, value, note ?? null, bind ?? null]);
  }

  async delete(name: string): Promise<void> {
    await this.call("delete", [name]);
  }

  async adopt(name: string, bind: string[]): Promise<void> {
    await this.call("adopt", [name, bind]);
  }

  /** A value the Vault process agrees to release, for handing straight to its consumer. */
  use(name: string, target?: string): Promise<string> {
    return this.call<string>("use", [name, target ?? null]);
  }

  redact(text: string): Promise<string> {
    if (!text) return Promise.resolve(text);
    return this.call<string>("redact", [text]);
  }

  async clear(): Promise<void> {
    await this.call("clear");
  }

  reopen(): Promise<{ opened: string[]; still: { name: string; reason: string }[] }> {
    return this.call("reopen");
  }

  async sealedEntries(): Promise<{ name: string; note?: string; cipher: Buffer }[]> {
    const entries = await this.call<{ name: string; note?: string; cipher: string }[]>("sealedEntries");
    return entries.map((entry) => ({ ...entry, cipher: Buffer.from(entry.cipher, "base64") }));
  }

  private update(state: VaultState): void {
    this.mirror = state;
    for (const listener of this.listeners) listener();
  }
}

/**
 * Two ends of an in-memory channel. Messages are structured-cloned and
 * delivered on a later tick, as they would be between processes.
 */
export function portPair(): [Port, Port] {
  const handlers: [((message: unknown) => void)[], ((message: unknown) => void)[]] = [[], []];
  const end = (mine: 0 | 1): Port => ({
    post: (message) => {
      const copy = structuredClone(message);
      setImmediate(() => { for (const handler of handlers[mine === 0 ? 1 : 0]) handler(copy); });
    },
    onMessage: (handler) => { handlers[mine].push(handler); },
  });
  return [end(0), end(1)];
}

/** A server and a client joined in this process: for tests, and nothing else. */
export async function connectLocal(vault: Vault, opts: ServeOptions = {}): Promise<{ client: VaultClient; server: VaultServer }> {
  const [serverEnd, clientEnd] = portPair();
  const server = new VaultServer(vault, opts);
  server.attach(serverEnd);
  const client = new VaultClient(clientEnd);
  await client.refresh();
  return { client, server };
}
