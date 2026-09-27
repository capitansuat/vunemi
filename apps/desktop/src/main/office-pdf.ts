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

export async function renderOfficePdf(html: string, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) throw new Error("PDF rendering cancelled.");
  const window = new BrowserWindow({
    show: false,
    width: 794,
    height: 1123,
    webPreferences: {
      javascript: false,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
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
    if (signal.aborted || window.isDestroyed()) throw new Error("PDF rendering cancelled.");
    const pdf = await contents.printToPDF({ printBackground: true, pageSize: "A4" });
    if (signal.aborted || window.isDestroyed()) throw new Error("PDF rendering cancelled.");
    return pdf;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    if (!window.isDestroyed()) window.destroy();
  }
}
