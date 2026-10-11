/** Render trusted converter output without granting the document a browser or network. */
import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";

const PDF_TIMEOUT_MS = 30_000;
const POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

function withPolicy(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`;
  return /<head\b[^>]*>/i.test(html)
    ? html.replace(/<head\b[^>]*>/i, (tag) => `${tag}${meta}`)
    : `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

/** Loads the HTML in a window of its own, with no scripts and no network, and hands it to `work`. */
async function isolated<T>(html: string, signal: AbortSignal, size: { width: number; height: number; offscreen?: boolean }, work: (window: BrowserWindow) => Promise<T>): Promise<T> {
  if (signal.aborted) throw new Error("Rendering cancelled.");
  const window = new BrowserWindow({
    show: false,
    width: size.width,
    height: size.height,
    webPreferences: {
      javascript: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      ...(size.offscreen && { offscreen: true }),
      partition: `vunemi-office-pdf-${randomUUID()}`,
    },
  });
  const contents = window.webContents;
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith("data:") });
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  const cancel = () => { if (!window.isDestroyed()) window.destroy(); };
  const timer = setTimeout(cancel, PDF_TIMEOUT_MS);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(withPolicy(html)).toString("base64")}`;
    await window.loadURL(dataUrl);
    if (signal.aborted || window.isDestroyed()) throw new Error("Rendering cancelled.");
    const made = await work(window);
    if (signal.aborted || window.isDestroyed()) throw new Error("Rendering cancelled.");
    return made;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    if (!window.isDestroyed()) window.destroy();
  }
}

export async function renderOfficePdf(html: string, signal: AbortSignal): Promise<Uint8Array> {
  return isolated(html, signal, { width: 794, height: 1123 }, (window) => window.webContents.printToPDF({ printBackground: true, pageSize: "A4" }));
}

/**
 * A picture of the top of an HTML page, as PNG: what a table looks like, for
 * the person to see. Drawn off screen, so no window ever appears.
 */
export async function renderHtmlPicture(html: string, signal: AbortSignal): Promise<Uint8Array> {
  const page = `<style>html{background:#fff}body{margin:16px}</style>${html}`;
  return isolated(page, signal, { width: 900, height: 520, offscreen: true }, async (window) => {
    // Off screen, a frame is painted a moment after the page has loaded.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const image = await window.webContents.capturePage();
    if (image.isEmpty()) throw new Error("Nothing was drawn.");
    return image.toPNG();
  });
}
