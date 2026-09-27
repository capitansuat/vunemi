/**
 * A browser backend supplies tabs and a CDP session per tab. Everything the
 * agent does to a page is written once against `CdpSession` (see page.ts), so
 * the isolated browser and the user's real Chrome (via the extension relay)
 * behave identically.
 */

import { CdpConnection, type CdpSession } from "./cdp.js";

export interface TabInfo {
  targetId: string;
  url: string;
  title: string;
}

export interface BrowserBackend {
  readonly kind: "isolated" | "extension" | "embedded";
  listTabs(): Promise<TabInfo[]>;
  openTab(url: string): Promise<string>;
  closeTab(targetId: string): Promise<void>;
  activateTab(targetId: string): Promise<void>;
  attach(targetId: string): Promise<CdpSession>;
  /** Called when a tab's session ends underneath us (tab closed, user cancelled debugging). */
  onDetach(listener: (targetId: string) => void): () => void;
  readonly connected: boolean;
  close(): Promise<void>;
  /**
   * A JPEG of the tab taken the host's own way, when CDP's picture could be
   * stale — a page in a hidden window stops drawing. Optional.
   */
  capture?(targetId: string): Promise<Buffer>;
}

/** Drives a Chrome we launched ourselves, over its browser-level CDP endpoint. */
export class CdpBrowserBackend implements BrowserBackend {
  readonly kind = "isolated" as const;
  private readonly sessions = new Map<string, CdpSession>();
  private readonly detachListeners = new Set<(targetId: string) => void>();

  constructor(
    private readonly conn: CdpConnection,
    private readonly onClose?: () => Promise<void>,
  ) {
    conn.on("Target.detachedFromTarget", (p) => {
      const { targetId } = p as { targetId?: string };
      if (!targetId) return;
      this.sessions.delete(targetId);
      for (const l of this.detachListeners) l(targetId);
    });
  }

  onDetach(listener: (targetId: string) => void): () => void {
    this.detachListeners.add(listener);
    return () => this.detachListeners.delete(listener);
  }

  get connected(): boolean {
    return !this.conn.isClosed;
  }

  async listTabs(): Promise<TabInfo[]> {
    const { targetInfos } = await this.conn.send<{
      targetInfos: { targetId: string; type: string; url: string; title: string }[];
    }>("Target.getTargets");
    return targetInfos
      .filter((t) => t.type === "page" && !t.url.startsWith("devtools://"))
      .map(({ targetId, url, title }) => ({ targetId, url, title }));
  }

  async openTab(url: string): Promise<string> {
    const { targetId } = await this.conn.send<{ targetId: string }>("Target.createTarget", { url });
    return targetId;
  }

  async closeTab(targetId: string): Promise<void> {
    this.sessions.delete(targetId);
    await this.conn.send("Target.closeTarget", { targetId });
  }

  async activateTab(targetId: string): Promise<void> {
    await this.conn.send("Target.activateTarget", { targetId });
  }

  async attach(targetId: string): Promise<CdpSession> {
    const cached = this.sessions.get(targetId);
    if (cached) return cached;
    const { sessionId } = await this.conn.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const session = this.conn.session(sessionId);
    this.sessions.set(targetId, session);
    return session;
  }

  async close(): Promise<void> {
    this.conn.close();
    await this.onClose?.();
  }
}
