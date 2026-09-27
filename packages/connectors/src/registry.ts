/**
 * The catalogue, and the switch beside each entry.
 *
 * This owns the one fact the rest of the app keeps asking about: which
 * connections are on. Turning one off takes its tools out of the registry's
 * reach, so the model is not merely discouraged from calling them — it
 * cannot. Turning one on again puts them back.
 *
 * What the user chose has to outlive the process, so the on/off set is
 * handed in and handed back; where it is stored is the app's business, not
 * this module's.
 */

import type { ToolRegistry } from "@ocak/agent-core";
import type { AccountStatus, Connector, ConnectorStatus, ConnectorView } from "./types.js";
import { t } from "@ocak/i18n";

export interface ConnectorsOptions {
  tools: ToolRegistry;
  /** Ids the user has switched on or off before; anything absent uses its default. */
  remembered?: Record<string, boolean>;
  /** Called whenever a switch moves, so the choice can be written down. */
  onChange?: (state: Record<string, boolean>) => void;
}

export class Connectors {
  private readonly items = new Map<string, Connector>();
  private readonly chosen: Record<string, boolean>;

  constructor(private readonly opts: ConnectorsOptions) {
    this.chosen = { ...opts.remembered };
  }

  /**
   * Adds a connection and registers its tools. Each capability is its own
   * tool source (`connector:capability`), which is what lets one part be
   * switched off while the rest of the connection keeps working.
   */
  add(connector: Connector): void {
    if (this.items.has(connector.id)) throw new Error(`Connector already added: ${connector.id}`);
    this.items.set(connector.id, connector);
    this.wire(connector);
  }

  /** `connector:capability`, or just the connector when it declares none. */
  private sourceFor(connector: Connector, toolName: string): string {
    if (!connector.capabilities?.length) return connector.id;
    const part = connector.capabilities.find((c) => c.tools.includes(toolName));
    // A tool in no part would have a source nothing ever switches: it would
    // work with the connection off. Refused here rather than trusted to review.
    if (!part) throw new Error(`${connector.id}: tool ${toolName} is in none of its parts`);
    return `${connector.id}:${part.id}`;
  }

  private wire(connector: Connector): void {
    const on = this.isOn(connector.id);
    for (const tool of connector.tools()) {
      const source = this.sourceFor(connector, tool.name);
      this.opts.tools.register(tool, source);
    }
    // Every source this connection owns, including ones with no tools yet.
    for (const source of this.sourcesOf(connector)) {
      this.opts.tools.setEnabled(source, on && this.partOn(connector, source));
    }
  }

  private sourcesOf(connector: Connector): string[] {
    if (!connector.capabilities?.length) return [connector.id];
    return connector.capabilities.map((c) => `${connector.id}:${c.id}`);
  }

  /** Whether one part is on, by the user's choice or its own default. */
  private partOn(connector: Connector, source: string): boolean {
    if (!connector.capabilities?.length) return true;
    const id = source.slice(connector.id.length + 1);
    const part = connector.capabilities.find((c) => c.id === id);
    if (!part) return true;
    return this.chosen[source] ?? part.defaultOn;
  }

  /** Whether one part of a connection is chosen on (the connection itself may still be off). */
  isPartOn(connectorId: string, partId: string): boolean {
    return this.partOn(this.need(connectorId), `${connectorId}:${partId}`);
  }

  /**
   * The switched-off part a tool belongs to, in the user's words, when it
   * may be offered back to them: the connection itself is on and the part
   * is one they can see in Settings. Null otherwise — a connection that is
   * off stays off until they open it themselves.
   */
  partOf(toolName: string): { connectorId: string; partId: string; label: string } | null {
    for (const connector of this.items.values()) {
      const part = connector.capabilities?.find((c) => c.tools.includes(toolName));
      if (!part) continue;
      if (part.hidden || !this.isOn(connector.id) || this.isPartOn(connector.id, part.id)) return null;
      return { connectorId: connector.id, partId: part.id, label: `${connector.label} › ${part.label}` };
    }
    return null;
  }

  /** Switches one part of a connection, leaving the others alone. */
  setPartOn(connectorId: string, partId: string, on: boolean): void {
    const connector = this.need(connectorId);
    const source = `${connectorId}:${partId}`;
    if (!connector.capabilities?.some((c) => c.id === partId)) throw new Error(`No such part: ${source}`);
    this.chosen[source] = on;
    this.opts.tools.setEnabled(source, this.isOn(connectorId) && on);
    this.opts.onChange?.({ ...this.chosen });
  }

  /** Activates only after the connection's own live status probe succeeds. */
  async setOnIfReady(id: string): Promise<void> {
    const status = await this.need(id).status();
    if (status.state !== "ready") {
      throw new Error(status.state === "blocked" ? status.reason : `Connection is not ready: ${id}`);
    }
    this.setOn(id, true);
  }

  /**
   * Puts a new connector where one with the same id is, keeping whether the
   * user had it on: a server whose secrets just moved into the Vault.
   */
  replace(connector: Connector): void {
    const old = this.items.get(connector.id);
    if (!old) return this.add(connector);
    for (const source of this.sourcesOf(old)) this.opts.tools.unregister(source);
    this.items.set(connector.id, connector);
    this.wire(connector);
  }

  /** Takes a connection out entirely — a server the user removed. */
  remove(id: string): void {
    const connector = this.items.get(id);
    if (!connector || !this.items.delete(id)) return;
    for (const source of this.sourcesOf(connector)) this.opts.tools.unregister(source);
    delete this.chosen[id];
    this.opts.onChange?.({ ...this.chosen });
  }

  /**
   * Re-registers a connection's tools. An MCP server only says what it can
   * do once it has been asked, so its tool list changes after connecting.
   */
  reload(id: string): void {
    const connector = this.need(id);
    for (const source of this.sourcesOf(connector)) this.opts.tools.unregister(source);
    this.wire(connector);
  }

  get(id: string): Connector | undefined {
    return this.items.get(id);
  }

  /** Ids of the connections switched on. Asks nothing of them. */
  onIds(): string[] {
    return [...this.items.keys()].filter((id) => this.isOn(id));
  }

  isOn(id: string): boolean {
    const connector = this.items.get(id);
    return this.chosen[id] ?? connector?.defaultOn ?? false;
  }

  setOn(id: string, on: boolean): void {
    const connector = this.need(id);
    this.chosen[id] = on;
    // Switching the connection off takes every part with it; switching it on
    // restores each part to what the user last chose for that part.
    for (const source of this.sourcesOf(connector)) {
      this.opts.tools.setEnabled(source, on && this.partOn(connector, source));
    }
    this.opts.onChange?.({ ...this.chosen });
  }

  /** The whole list, with each one's real state. For the connections screen. */
  async list(): Promise<ConnectorView[]> {
    return Promise.all(
      [...this.items.values()].map(async (connector) => ({
        ...definitionOf(connector),
        status: await this.statusOf(connector),
        toolCount: connector.tools().length,
        connectable: typeof connector.connect === "function",
        ...(await this.permittedOf(connector)),
        parts: (connector.capabilities ?? []).filter((part) => !part.hidden).map((part) => ({
          id: part.id,
          label: part.label,
          ...(part.description && { description: part.description }),
          tools: part.tools.length,
          on: this.partOn(connector, `${connector.id}:${part.id}`),
        })),
        accounts: await this.accountsOf(connector),
        // Copied, so labels written as getters are read now, in the current language.
        providers: (connector.providers ?? []).map((provider) => ({ ...provider })),
      })),
    );
  }

  /**
   * The guidance for everything currently switched on. Telling the model how
   * to use a tool it cannot call wastes context and invites it to try.
   */
  instructions(): string {
    const on = [...this.items.values()].filter((c) => this.isOn(c.id));
    const guides = on
      .filter((c) => c.instructions && this.sourcesOf(c).some((s) => this.opts.tools.isEnabled(s)))
      .map((c) => c.instructions!);
    // A guide names every tool of its connection; the ones in a part the user
    // switched off don't exist right now. Said plainly, so a model asked to
    // add an event says adding is off instead of reading and claiming it did.
    const off = on.flatMap((c) =>
      (c.capabilities ?? []).filter((part) => !part.hidden && !this.isPartOn(c.id, part.id)).flatMap((part) => part.tools),
    );
    if (off.length > 0) {
      guides.push(`Switched off by the user: ${off.join(", ")}. If the task needs one, call it anyway: Vunemi asks the user whether to allow it once or switch it on. Never say it was done unless it ran.`);
    }
    // A new user starts with every connection off; asked what Vunemi can do,
    // a model that knew only its own scratchpad described nothing else.
    const offConnections = [...this.items.values()].filter((c) => !this.isOn(c.id)).map((c) => c.label);
    if (offConnections.length > 0) {
      guides.push(`Also part of Vunemi, but not switched on: ${offConnections.join(", ")}. None of them can be used until the user switches it on in Settings › Connections. When the user asks what you can do, or asks for something one of them does, say so.`);
    }
    return guides.join("\n\n");
  }

  /** Runs a connection's own sign-in or permission prompt. */
  async connect(id: string): Promise<ConnectorStatus> {
    const connector = this.need(id);
    if (!connector.connect) return this.statusOf(connector);
    const status = await connector.connect();
    // Connecting is how a server tells us what it can do, so the tools it
    // contributes are only correct after this.
    this.reload(id);
    // Authorising something is also saying you want it on.
    if (status.state === "ready" && !this.isOn(id)) this.setOn(id, true);
    return status;
  }

  /**
   * Adds an account to a connection — a second mailbox, a different Drive.
   * Adding one is also saying you want the connection on.
   */
  async addAccount(id: string, provider: string, input?: unknown): Promise<AccountStatus> {
    const connector = this.need(id);
    if (!connector.addAccount) throw new Error(t("connectors.noAccounts", { label: connector.label }));
    const account = await connector.addAccount(provider, input);
    if (account.state === "ready" && !this.isOn(id)) this.setOn(id, true);
    return account;
  }

  async removeAccount(id: string, accountId: string): Promise<void> {
    const connector = this.need(id);
    if (!connector.removeAccount) throw new Error(t("connectors.noAccounts", { label: connector.label }));
    await connector.removeAccount(accountId);
  }

  async disconnect(id: string): Promise<void> {
    const connector = this.need(id);
    await connector.disconnect?.();
    this.setOn(id, false);
  }

  /** Never asks a switched-off connection about its accounts, as with status. */
  private async accountsOf(connector: Connector): Promise<AccountStatus[]> {
    if (!connector.accounts || !this.isOn(connector.id)) return [];
    try {
      return await connector.accounts();
    } catch {
      return [];
    }
  }

  private async statusOf(connector: Connector): Promise<ConnectorStatus> {
    // Off is off: don't go asking macOS or a server about something the user
    // has switched away, and don't let a failing probe make "off" look broken.
    if (!this.isOn(connector.id)) return { state: "off" };
    try {
      return await connector.status();
    } catch (err) {
      return { state: "blocked", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * The one probe made for a connection that is off: a macOS permission is
   * a local question with no prompt, and knowing it is already given saves
   * the user a "Connect" that would do nothing but switch it on.
   */
  private async permittedOf(connector: Connector): Promise<{ permitted?: boolean; permissionStatus?: Extract<ConnectorStatus, { state: "blocked" }> }> {
    if (this.isOn(connector.id) || connector.needs.kind !== "permission" || !connector.connect) return {};
    try {
      const status = await connector.status();
      return status.state === "blocked"
        ? { permitted: false, permissionStatus: status }
        : { permitted: status.state === "ready" };
    } catch {
      return { permitted: false };
    }
  }

  private need(id: string): Connector {
    const connector = this.items.get(id);
    if (!connector) throw new Error(`No such connector: ${id}`);
    return connector;
  }
}

function definitionOf(connector: Connector) {
  const { id, label, group, description, provides, needs, defaultOn, origin, instructions } = connector;
  return { id, label, group, description, provides, needs, defaultOn, origin, ...(instructions && { instructions }) };
}
