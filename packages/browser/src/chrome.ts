/**
 * Launches (or reuses) a Chrome with its own profile for the agent.
 *
 * Chrome 136+ refuses `--remote-debugging-port` on the user's default
 * profile, which is fine here: the isolated mode is *meant* to be a separate
 * profile. Driving the user's real, logged-in Chrome goes through the
 * extension instead.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CdpBrowserBackend } from "./backend.js";
import { CdpConnection } from "./cdp.js";

const MAC_CANDIDATES = [
  "Google Chrome.app/Contents/MacOS/Google Chrome",
  "Chromium.app/Contents/MacOS/Chromium",
  "Brave Browser.app/Contents/MacOS/Brave Browser",
  "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

export function findChrome(): string | null {
  const override = process.env.VUNEMI_CHROME;
  if (override && existsSync(override)) return override;
  for (const base of ["/Applications", join(homedir(), "Applications")]) {
    for (const rel of MAC_CANDIDATES) {
      const p = join(base, rel);
      if (existsSync(p)) return p;
    }
  }
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

export interface LaunchOptions {
  userDataDir: string;
  executablePath?: string;
  headless?: boolean;
  timeoutMs?: number;
}

export async function launchIsolatedChrome(opts: LaunchOptions): Promise<CdpBrowserBackend> {
  mkdirSync(opts.userDataDir, { recursive: true });
  const portFile = join(opts.userDataDir, "DevToolsActivePort");

  // A Chrome we started earlier with this profile may still be running.
  const reused = await tryConnect(portFile);
  if (reused) return new CdpBrowserBackend(reused);

  const exe = opts.executablePath ?? findChrome();
  if (!exe) {
    throw new Error("No Chrome-family browser found. Install Google Chrome, or set VUNEMI_CHROME to a Chromium executable.");
  }

  rmSync(portFile, { force: true });
  const child: ChildProcess = spawn(
    exe,
    [
      `--user-data-dir=${opts.userDataDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--window-size=1280,900",
      ...(opts.headless ? ["--headless=new"] : []),
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    const conn = await tryConnect(portFile);
    if (conn) {
      return new CdpBrowserBackend(conn, () => stopChrome(child));
    }
    if (exited) throw new Error(`Chrome exited during startup (${exe}).`);
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill();
  throw new Error("Chrome did not open its DevTools port in time.");
}

/**
 * Asks Chrome to quit and waits until it has, so its profile is fully
 * written before anyone touches it. Escalates to SIGKILL after a grace period.
 */
async function stopChrome(child: ChildProcess, graceMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), graceMs));
  if ((await Promise.race([exited, timer])) === "timeout") {
    child.kill("SIGKILL");
    await exited;
  }
}

async function tryConnect(portFile: string): Promise<CdpConnection | null> {
  if (!existsSync(portFile)) return null;
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  if (!port || !path) return null;
  try {
    return await CdpConnection.connect(`ws://127.0.0.1:${port}${path}`, 2_000);
  } catch {
    return null;
  }
}
