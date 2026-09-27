/**
 * The browser inside the Vunemi window. Each tab is a WebContentsView shown in
 * the right-hand pane; the agent drives it over Electron's built-in CDP
 * channel (`webContents.debugger`), through the same PageDriver as every
 * other backend. Nothing to install; the user watches every step and can
 * click, type or log in themselves at any time.
 *
 * Pages here are untrusted web content: their own persistent session
 * (separate from the app UI), sandboxed, no preload, no Node, every
 * permission request denied, and no request to this Mac or the local
 * network, whatever asks for it, except the private-network sites the user
 * trusted in Settings. Downloads are allowed, but only into the user's
 * Downloads folder, only a few per session and only up to a size — a page
 * that starts downloading on its own shouldn't be able to fill a disk, and
 * whatever does arrive is recorded where the user can undo it.
 */

import { app, session, WebContentsView, type BrowserWindow, type Session } from "electron";
import { lookup } from "node:dns/promises";
import { existsSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { requestGuard, trustableHost, trustWouldOpen, type BrowserBackend, type CdpSession, type PointerEvent, type TabInfo, type TrustedSites } from "@vunemi/browser";
import { CURSOR_WORLD_ID, cursorScript } from "./agent-cursor.js";
import type { EmbeddedState, PaneBounds } from "../shared/ipc.js";

const PARTITION = "persist:vunemi-browser";

/**
 * The embedded browser's cookies and sign-ins were kept under the app's
 * earlier name. Moved once, before the session is first opened; a rename on
 * the same disk, so nothing is copied or lost.
 */
export function carryOverBrowserData(userData: string): void {
  const old = join(userData, "Partitions", "ocak-browser");
  const now = join(userData, "Partitions", "vunemi-browser");
  try {
    if (existsSync(old) && !existsSync(now)) renameSync(old, now);
  } catch (err) {
    console.error("[vunemi] browser data not carried over:", err instanceof Error ? err.message : String(err));
  }
}

/** Downloads: what a page may leave behind without being asked. */
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_DOWNLOADS = 20;

export interface Downloaded {
  name: string;
  path: string;
  bytes: number;
  url: string;
}

interface Tab {
  id: string;
  view: WebContentsView;
  session: CdpSession | null;
  /** The page the guard last refused in this tab, until it navigates again. */
  blocked: { host: string; trustable: boolean; reason: string } | null;
}

function webUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (s === "about:blank") return s;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

export class EmbeddedBrowser {
  private win: BrowserWindow | null = null;
  private readonly tabs: Tab[] = [];
  private active: string | null = null;
  private bounds: PaneBounds | null = null;
  /** The pane's last size, kept while it is closed so the page's layout does not change. */
  private size = { width: 1024, height: 800 };
  private covered = false;
  private readonly listeners = new Set<(s: EmbeddedState) => void>();
  private readonly detachListeners = new Set<(id: string) => void>();
  private readonly downloadListeners = new Set<(d: Downloaded) => void>();
  private downloads = 0;
  private ses: Session | null = null;

  /** `trusted` is the user's list of private-network sites pages may open. */
  constructor(private readonly trusted: () => TrustedSites = () => new Set()) {}

  /** Call once the window exists; tabs live in it. */
  setHost(win: BrowserWindow): void {
    this.win = win;
    // A parked page follows the window's bottom edge.
    win.on("resize", () => this.layout());
    win.on("closed", () => {
      for (const t of [...this.tabs]) this.forget(t);
      this.win = null;
      this.changed();
    });
  }

  get available(): boolean {
    return this.win !== null && !this.win.isDestroyed();
  }

  async clearData(): Promise<void> {
    for (const tab of [...this.tabs]) this.close(tab.id);
    const browserSession = this.ses ?? session.fromPartition(PARTITION);
    await browserSession.clearStorageData();
    await browserSession.clearCache();
    await browserSession.clearAuthCache();
  }

  get state(): EmbeddedState {
    return {
      tabs: this.tabs.filter((t) => !t.view.webContents.isDestroyed()).map((t) => {
        const wc = t.view.webContents;
        return {
          id: t.id,
          url: wc.getURL(),
          title: wc.getTitle() || wc.getURL() || "Yeni sekme",
          loading: wc.isLoading(),
          canGoBack: wc.navigationHistory.canGoBack(),
          canGoForward: wc.navigationHistory.canGoForward(),
          agent: t.session !== null,
          blocked: t.blocked ? { host: t.blocked.host, trustable: t.blocked.trustable } : null,
        };
      }),
      activeId: this.active,
    };
  }

  onState(listener: (s: EmbeddedState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A file a page put in the user's Downloads folder. */
  onDownload(listener: (d: Downloaded) => void): () => void {
    this.downloadListeners.add(listener);
    return () => this.downloadListeners.delete(listener);
  }

  onDetach(listener: (id: string) => void): () => void {
    this.detachListeners.add(listener);
    return () => this.detachListeners.delete(listener);
  }

  // -- user and agent share these ------------------------------------------

  open(raw: string): string {
    const win = this.win;
    if (!win || win.isDestroyed()) throw new Error("The Vunemi window is closed.");
    const url = webUrl(raw);
    if (!url) throw new Error("Only http(s) pages can be opened.");

    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    this.secureSession(view.webContents.session);
    view.setBackgroundColor("#ffffff");
    // A real size even while the pane is closed, so layout and hit-testing work.
    view.setBounds(this.bounds ?? this.parked());
    const tab: Tab = { id: String(view.webContents.id), view, session: null, blocked: null };
    this.tabs.push(tab);
    this.wire(tab);
    win.contentView.addChildView(view);
    this.activate(tab.id);
    void view.webContents.loadURL(url).catch(() => {});
    return tab.id;
  }

  navigate(id: string, raw: string): void {
    const url = webUrl(raw);
    if (!url) throw new Error("Only http(s) pages can be opened.");
    void this.get(id).view.webContents.loadURL(url).catch(() => {});
  }

  history(id: string, action: "back" | "forward" | "reload" | "stop"): void {
    const wc = this.get(id).view.webContents;
    if (action === "back") wc.navigationHistory.goBack();
    else if (action === "forward") wc.navigationHistory.goForward();
    else if (action === "reload") wc.reload();
    else wc.stop();
  }

  activate(id: string): void {
    this.get(id);
    this.active = id;
    this.layout();
    this.changed();
  }

  close(id: string): void {
    const tab = this.get(id);
    const i = this.tabs.indexOf(tab);
    this.forget(tab);
    if (this.active === id) this.active = (this.tabs[i] ?? this.tabs[i - 1])?.id ?? null;
    this.layout();
    this.changed();
  }

  /** Where the renderer's pane is, in window coordinates; null hides the page. */
  setBounds(bounds: PaneBounds | null): void {
    this.bounds = bounds;
    if (bounds) this.size = { width: bounds.width, height: bounds.height };
    this.layout();
  }

  /**
   * Hides the page without forgetting where it goes. The page is a native
   * view drawn above the window's HTML, so the lock screen can't cover it;
   * this does. The agent keeps its tabs either way.
   */
  setCovered(covered: boolean): void {
    this.covered = covered;
    this.layout();
  }

  /** A JPEG of what the tab shows, drawn fresh even while the window is hidden. */
  async capture(id: string): Promise<Buffer> {
    const image = await this.get(id).view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: false });
    if (image.isEmpty()) throw new Error("The page produced an empty picture.");
    return image.toJPEG(70);
  }

  /** Why the tab's last page was refused, for the agent; null if it wasn't. */
  blockReason(id: string): string | null {
    return this.tabs.find((t) => t.id === id)?.blocked?.reason ?? null;
  }

  // -- agent side ----------------------------------------------------------

  attach(id: string): CdpSession {
    const tab = this.get(id);
    if (tab.session) return tab.session;
    const dbg = tab.view.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    const handlers = new Map<string, Set<(p: unknown) => void>>();
    dbg.on("message", (_e, method, params) => {
      const set = handlers.get(method);
      if (set) for (const h of [...set]) h(params);
    });
    tab.session = {
      send: (method, params) => dbg.sendCommand(method, params ?? {}),
      on: (event, handler) => {
        let set = handlers.get(event);
        if (!set) handlers.set(event, (set = new Set()));
        set.add(handler);
        return () => set.delete(handler);
      },
    };
    this.changed();
    return tab.session;
  }

  /** Draws the agent's cursor where it's about to act; resolves when it has arrived. */
  async showPointer(id: string, p: PointerEvent): Promise<void> {
    const wc = this.tabs.find((t) => t.id === id)?.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    await wc.executeJavaScriptInIsolatedWorld(CURSOR_WORLD_ID, [{ code: cursorScript(p) }]);
  }

  /** Lets go of every tab without closing any; the user keeps browsing. */
  release(): void {
    for (const t of this.tabs) this.detach(t);
    this.changed();
  }

  // -- internals -------------------------------------------------------------

  private get(id: string): Tab {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) throw new Error(`No embedded tab ${id}.`);
    return tab;
  }

  private detach(tab: Tab): void {
    if (!tab.session) return;
    tab.session = null;
    if (tab.view.webContents.isDestroyed()) {
      for (const l of this.detachListeners) l(tab.id);
      return;
    }
    const dbg = tab.view.webContents.debugger;
    dbg.removeAllListeners("message");
    dbg.removeAllListeners("detach");
    try {
      if (dbg.isAttached()) dbg.detach();
    } catch {
      // Already gone with its page.
    }
    for (const l of this.detachListeners) l(tab.id);
    this.wireDetach(tab);
  }

  private forget(tab: Tab): void {
    const i = this.tabs.indexOf(tab);
    if (i >= 0) this.tabs.splice(i, 1);
    this.detach(tab);
    if (this.win && !this.win.isDestroyed()) this.win.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }

  /**
   * The active tab is always drawn: a hidden page ignores clicks, and the
   * agent keeps working with the pane closed or the window locked. When the
   * user should not see it, it is parked outside the window but for one
   * pixel in the rounded bottom-left corner, which macOS clips. Wholly
   * outside, Chromium counts the page as hidden again.
   */
  private layout(): void {
    for (const t of this.tabs) {
      if (t.view.webContents.isDestroyed()) continue;
      if (t.id !== this.active) {
        t.view.setVisible(false);
        continue;
      }
      const shown = this.bounds !== null && !this.covered;
      t.view.setVisible(true);
      t.view.setBounds(shown ? this.bounds! : this.parked());
    }
  }

  private parked(): { x: number; y: number; width: number; height: number } {
    const height = this.win && !this.win.isDestroyed() ? this.win.getContentBounds().height : this.size.height;
    return { x: 1 - this.size.width, y: height - 1, ...this.size };
  }

  private changed(): void {
    const s = this.state;
    for (const l of this.listeners) l(s);
  }

  private wireDetach(tab: Tab): void {
    tab.view.webContents.debugger.once("detach", () => {
      // e.g. the page crashed or DevTools took over.
      if (!tab.session) return;
      tab.session = null;
      tab.view.webContents.debugger.removeAllListeners("message");
      for (const l of this.detachListeners) l(tab.id);
      this.changed();
    });
  }

  private wire(tab: Tab): void {
    const wc = tab.view.webContents;
    const update = () => this.changed();
    wc.on("did-start-loading", update);
    wc.on("did-stop-loading", update);
    wc.on("did-navigate", update);
    wc.on("did-navigate-in-page", update);
    wc.on("page-title-updated", update);
    wc.on("render-process-gone", update);
    wc.on("did-start-navigation", (details) => {
      if (!details.isMainFrame || details.isSameDocument || !tab.blocked) return;
      tab.blocked = null;
      this.changed();
    });
    this.wireDetach(tab);

    // Only web pages; a page can't steer the view to file:, chrome: etc.
    wc.on("will-navigate", (e, url) => {
      if (!webUrl(url)) e.preventDefault();
    });
    wc.on("will-redirect", (e, url) => {
      if (!webUrl(url)) e.preventDefault();
    });
    // target=_blank and window.open become tabs here, never native windows.
    wc.setWindowOpenHandler(({ url }) => {
      if (webUrl(url)) setImmediate(() => this.open(url));
      return { action: "deny" };
    });
    wc.on("destroyed", () => {
      if (this.tabs.includes(tab)) {
        this.tabs.splice(this.tabs.indexOf(tab), 1);
        if (tab.session) for (const l of this.detachListeners) l(tab.id);
        if (this.active === tab.id) this.active = this.tabs.at(-1)?.id ?? null;
        this.layout();
        this.changed();
      }
    });
  }

  /** Remembers a refused page so the pane can say why and where to trust it. */
  private refused(webContentsId: number | undefined, url: string, reason: string): void {
    const tab = this.tabs.find((t) => t.id === String(webContentsId));
    if (!tab) return;
    const site = trustableHost(url);
    const host = "host" in site ? site.host : hostName(url);
    tab.blocked = { host, trustable: "host" in site && trustWouldOpen(reason), reason };
    this.changed();
  }

  private secureSession(ses: Session): void {
    if (this.ses === ses) return;
    this.ses = ses;
    // Look like the Chrome this is, not "Electron"/"vunemi", which some sites
    // block or serve a degraded page to.
    ses.setUserAgent(app.userAgentFallback.replace(/\s(Electron|vunemi|@vunemi\/desktop)\/\S+/gi, ""));
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    // Every request, not only the address the agent opened: a page redirects,
    // opens a window, frames or fetches 127.0.0.1 or the user's router itself.
    // A page's own requests are judged by the page it is on, so a public page
    // can't reach into a trusted intranet site behind the user's back.
    const guard = requestGuard(async (host) => (await lookup(host, { all: true })).map((a) => a.address), undefined, this.trusted);
    ses.webRequest.onBeforeRequest((details, callback) => {
      const page = details.resourceType === "mainFrame" ? undefined : details.webContents?.getURL() || details.referrer;
      guard(details.url, page).then(
        (refused) => {
          if (refused && details.resourceType === "mainFrame") this.refused(details.webContentsId, details.url, refused);
          callback({ cancel: refused !== null });
        },
        () => callback({ cancel: true }),
      );
    });
    ses.on("will-download", (e, item) => {
      if (this.downloads >= MAX_DOWNLOADS) return e.preventDefault();
      const total = item.getTotalBytes();
      if (total > MAX_DOWNLOAD_BYTES) return e.preventDefault();

      // Downloads land where downloads land, under a name that is ours.
      const dir = app.getPath("downloads");
      const path = join(dir, uniqueIn(dir, safeName(item.getFilename())));
      item.setSavePath(path);
      this.downloads += 1;
      // A server that doesn't say the size up front is held to it as the bytes arrive.
      item.on("updated", () => {
        if (item.getReceivedBytes() > MAX_DOWNLOAD_BYTES) item.cancel();
      });
      item.once("done", (_event, state) => {
        if (state !== "completed") return;
        const info: Downloaded = { name: basename(path), path, bytes: item.getReceivedBytes(), url: item.getURL() };
        for (const l of this.downloadListeners) l(info);
      });
    });
  }
}

function hostName(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 100);
  }
}

/** Keeps a page from choosing where its file lands or what it is called. */
export function safeName(name: string): string {
  const clean = basename(name).replace(/[/\\:\u0000]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return clean || "indirilen";
}

export function uniqueIn(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} ${n}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/** One of the Vunemi window's tabs, as a BrowserBackend. Tab ids are webContents ids. */
export class EmbeddedBackend implements BrowserBackend {
  readonly kind = "embedded" as const;

  constructor(private readonly browser: EmbeddedBrowser) {}

  get connected(): boolean {
    return this.browser.available;
  }

  async listTabs(): Promise<TabInfo[]> {
    return this.browser.state.tabs.map((t) => ({ targetId: t.id, url: t.url, title: t.title }));
  }

  async openTab(url: string): Promise<string> {
    return this.browser.open(url);
  }

  async closeTab(targetId: string): Promise<void> {
    this.browser.close(targetId);
  }

  async activateTab(targetId: string): Promise<void> {
    this.browser.activate(targetId);
  }

  async attach(targetId: string): Promise<CdpSession> {
    return this.browser.attach(targetId);
  }

  blockReason(targetId: string): string | null {
    return this.browser.blockReason(targetId);
  }

  /**
   * With the window closed the task goes on, but Chromium stops drawing the
   * page (measured 26 Sep: document.hidden, no animation frames, while the
   * accessibility tree still reads). capturePage counts as a viewer for the
   * moment of the picture, so it comes out current; stayHidden keeps the
   * window where the user put it.
   */
  async capture(targetId: string): Promise<Buffer> {
    return this.browser.capture(targetId);
  }

  onDetach(listener: (targetId: string) => void): () => void {
    return this.browser.onDetach(listener);
  }

  async close(): Promise<void> {
    this.browser.release();
  }
}
