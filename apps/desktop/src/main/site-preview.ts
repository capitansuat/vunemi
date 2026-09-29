/**
 * A web page Vunemi made, shown beside the chat when the user clicks
 * Preview. It runs its scripts, but cut off from everything else:
 *
 *  - its own in-memory session: no cookies, no storage, nothing of Vunemi's;
 *  - it sees only the files in its own folder, served under vunemi-preview://;
 *  - every other request is cancelled, a dead proxy stands behind that, and
 *    WebRTC may not go around it, so nothing it read can leave this Mac;
 *  - no permissions, no downloads, no new windows, no navigation away.
 *
 * The page may have been written under the influence of something the agent
 * read; this is why it is never opened in the user's own browser.
 */
import { protocol, session, WebContentsView, type BrowserWindow, type Session } from "electron";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, relative, sep } from "node:path";
import type { PaneBounds } from "../shared/ipc.js";
import { ORIGIN, POLICY, SCHEME, servedFile, TYPES } from "./site-files.js";

export { previewable } from "./site-files.js";

/** Before the app is ready: the scheme must behave like a real origin for relative links and fetch. */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

export class SitePreview {
  private view: WebContentsView | null = null;
  private root: string | null = null;
  private bounds: PaneBounds | null = null;
  private covered = false;
  private ses: Session | null = null;

  constructor(private readonly window: () => BrowserWindow | null) {}

  /** Shows `file` (already checked to be one the user may open). Returns its name for the pane. */
  show(file: string): string {
    const real = realpathSync(file);
    this.root = realpathSync(dirname(real));
    const view = this.ensureView();
    const path = relative(this.root, real).split(sep).map(encodeURIComponent).join("/");
    void view.webContents.loadURL(`${ORIGIN}/${path}`);
    this.layout();
    return basename(real);
  }

  setBounds(bounds: PaneBounds | null): void {
    this.bounds = bounds;
    this.layout();
  }

  /** While Vunemi is locked the page is not on screen. */
  setCovered(covered: boolean): void {
    this.covered = covered;
    this.layout();
  }

  close(): void {
    const view = this.view;
    this.view = null;
    this.root = null;
    if (!view) return;
    const win = this.window();
    if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
    view.webContents.close();
  }

  // -- internals -------------------------------------------------------------

  private layout(): void {
    const view = this.view;
    const win = this.window();
    if (!view || !win || win.isDestroyed()) return;
    const shown = this.bounds !== null && !this.covered;
    if (shown && !win.contentView.children.includes(view)) win.contentView.addChildView(view);
    if (!shown && win.contentView.children.includes(view)) win.contentView.removeChildView(view);
    if (shown) view.setBounds(this.bounds!);
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view;
    const ses = this.session();
    const view = new WebContentsView({
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, navigateOnDragDrop: false },
    });
    const wc = view.webContents;
    wc.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    const stay = (e: { preventDefault(): void }, url: string) => {
      if (!url.startsWith(`${ORIGIN}/`)) e.preventDefault();
    };
    wc.on("will-navigate", stay);
    wc.on("will-redirect", stay);
    wc.on("will-frame-navigate", (e) => {
      if (!e.url.startsWith(`${ORIGIN}/`) && !e.url.startsWith("about:")) e.preventDefault();
    });
    this.view = view;
    return view;
  }

  private session(): Session {
    if (this.ses) return this.ses;
    // No "persist:": nothing the page stores outlives Vunemi.
    const ses = session.fromPartition("vunemi-preview", { cache: false });
    ses.protocol.handle(SCHEME, (request) => {
      const file = this.root ? servedFile(this.root, request.url) : null;
      if (!file) return new Response("Not found", { status: 404 });
      const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
      return new Response(readFileSync(file), { headers: { "content-type": type, "content-security-policy": POLICY } });
    });
    ses.webRequest.onBeforeRequest((details, callback) => {
      const url = details.url;
      callback({ cancel: !(url.startsWith(`${SCHEME}:`) || url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) });
    });
    // Behind the cancel, a proxy that goes nowhere: no request and no DNS lookup reaches the network.
    void ses.setProxy({ proxyRules: "http://127.0.0.1:9", proxyBypassRules: "" });
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on("will-download", (e) => e.preventDefault());
    this.ses = ses;
    return ses;
  }
}
