/**
 * Which files a site preview may serve: only those inside the folder of the
 * page the user opened, judged by their real path. No Electron here.
 */
import { realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

export const SCHEME = "vunemi-preview";
export const ORIGIN = `${SCHEME}://site`;

export const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** What the page may load: itself, inline data, and nothing from anywhere else. */
export const POLICY =
  "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self' data: blob:; form-action 'none'; frame-src 'self'; base-uri 'self'";

export function previewable(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === ".html" || ext === ".htm";
}

/** The file a request asks for, if it is inside `root`; null for anything else. */
export function servedFile(root: string, url: string): string | null {
  let rel: string;
  try {
    const u = new URL(url);
    if (`${u.protocol}//${u.host}` !== ORIGIN) return null;
    rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  try {
    const real = realpathSync(resolve(root, rel));
    // By the real path: a link inside the folder may point anywhere.
    if (real !== root && !real.startsWith(root + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

