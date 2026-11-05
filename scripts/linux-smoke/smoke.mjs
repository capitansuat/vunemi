// Smoke run of a Linux Vunemi build under Xvfb: the window opens, Settings
// load, the Linux notes are there, the Vault behaves, and a simple task
// reaches its first approval card against mock-model.mjs.
//
//   node scripts/linux-smoke/mock-model.mjs &
//   xvfb-run -a node scripts/linux-smoke/smoke.mjs <executable> [args...]
//
// Only a local test build can be driven: it allows --remote-debugging-port
// (a VUNEMI_DISTRIBUTION=1 build refuses to start with it). Running as root
// needs --no-sandbox among the args. Options, from the environment:
//   SMOKE_DIR   work folder (throwaway HOME, screenshots, app.log); default: a new temp folder
//   USERDATA    the app's data folder, when not $HOME/.config/Vunemi (a dev run uses @vunemi/desktop-dev)
//   KEYRING=1   expect a working keyring (run inside with-keyring.sh); otherwise expect none
//   ENGINES=1   also check that the built-in llama.cpp and whisper.cpp engines are found
// Playwright is resolved from the current folder or NODE_PATH; it is not a
// dependency of this repository.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(join(process.cwd(), "noop.js"));
const { chromium } = require("playwright");

const S = process.env.SMOKE_DIR ?? mkdtempSync(join(tmpdir(), "vunemi-smoke-"));
console.log(`work folder: ${S}`);
const [exe, ...extra] = process.argv.slice(2);
const home = join(S, "home");
const shots = join(S, "shots");
rmSync(home, { recursive: true, force: true });
mkdirSync(join(home, "Documents"), { recursive: true });
mkdirSync(shots, { recursive: true });
const userData = process.env.USERDATA ?? join(home, ".config", "Vunemi");
mkdirSync(userData, { recursive: true });
// The files connection and its write part on, so the task can ask to write; synthetic only.
writeFileSync(join(userData, "settings.json"), JSON.stringify({ connections: { files: true, "files:write": true }, language: "en" }));

const port = 9333;
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), LANG: "en_US.UTF-8", NODE_OPTIONS: "" };
const app = spawn(exe, [...extra, `--remote-debugging-port=${port}`], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
app.stdout.on("data", (d) => (log += d));
app.stderr.on("data", (d) => (log += d));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(1000); }
  }
  check("CDP reachable", !!browser);
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("index.html"));
    if (!page) await sleep(500);
  }
  check("window opened", !!page, page?.url());
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "Settings" }).first().waitFor({ timeout: 30000 });
  await page.screenshot({ path: join(shots, "1-main.png") });
  const platform = await page.evaluate(() => window.vunemi.platformInfo());
  check("platform says linux", platform.id === "linux" && platform.features.meetings === false, JSON.stringify(platform.features));

  if (process.env.ENGINES === "1") {
    const engine = await page.evaluate(() => window.vunemi.getEngine());
    check("built-in llama.cpp engine found", engine.available === true, JSON.stringify({ available: engine.available, state: engine.engine.state }));
    const voice = await page.evaluate(() => window.vunemi.voiceStatus());
    check("built-in whisper engine found, speaking off", voice.canSpeak === false && (voice.canHear === true || !!voice.download), JSON.stringify(voice));
  }
  await page.getByRole("button", { name: "Settings" }).first().click();
  await sleep(800);
  await page.screenshot({ path: join(shots, "2-settings.png") });
  check("settings loaded", await page.getByText("Permissions").first().isVisible().catch(() => false));

  const section = async (label) => { await page.getByRole("button", { name: label, exact: true }).first().click(); await sleep(700); };
  await section("Updates");
  await page.screenshot({ path: join(shots, "3-updates.png") });
  check("updates says not on Linux, with a download link", await page.getByText("doesn't update itself on Linux").isVisible().catch(() => false) && await page.getByRole("button", { name: "Open the download page" }).isVisible().catch(() => false));
  await section("Security");
  check("app lock says not on Linux", await page.getByText("The app lock is not available on Linux yet").isVisible().catch(() => false));
  await section("Add-ons");
  check("add-ons say not on Linux", await page.getByText("Add-ons are not available on Linux yet").isVisible().catch(() => false));
  await section("Vault");
  await page.screenshot({ path: join(shots, "4-vault.png") });
  const vaultText = await page.locator("body").innerText();
  if (process.env.KEYRING === "1") {
    const status = await page.evaluate(() => window.vunemi.vaultStatus());
    check("vault open with the keyring", status.available === true && !status.keyring, JSON.stringify(status));
    const after = await page.evaluate(() => window.vunemi.vaultSet("smoke-token", "synthetic-smoke-value-123", "smoke test"));
    check("secret stored", after.secrets.some((s) => s.name === "smoke-token"));
    const keyFile = join(userData, "vault-key.linux");
    check("key file sealed by the keyring", existsSync(keyFile) && readFileSync(keyFile).subarray(0, 4).toString() === "VKL1");
    const stored = readFileSync(join(userData, "vault.json"), "utf8");
    const cipher = Buffer.from(JSON.parse(stored).entries[0].cipher, "base64");
    check("no plaintext on disk, Linux format", !stored.includes("synthetic-smoke-value-123") && cipher.subarray(0, 4).toString() === "OCL1");
  } else {
    check("vault explains the keyring", /keyring/i.test(vaultText), (vaultText.match(/[^\n]*keyring[^\n]*/i) ?? [""])[0].slice(0, 200));
    const refused = await page.evaluate(() => window.vunemi.vaultSet("smoke-token", "synthetic-smoke-value-123").then(() => "stored", (e) => String(e.message)));
    check("vault refuses to store without a keyring", refused !== "stored" && !existsSync(join(userData, "vault-key.linux")), refused.slice(0, 160));
    const stored = existsSync(join(userData, "vault.json")) ? readFileSync(join(userData, "vault.json"), "utf8") : "";
    check("nothing written in the clear", !stored.includes("synthetic-smoke-value-123"));
  }
  await section("Connections");
  await sleep(1500);
  await page.screenshot({ path: join(shots, "5-connections.png"), fullPage: true });
  const conn = await page.locator("body").innerText();
  check("Mac-only connections say not on Linux", conn.includes("Not available on Linux yet"));

  // Back to chat, and a task.
  await page.getByRole("button", { name: "Back to chat" }).first().click().catch(() => undefined);
  await sleep(800);
  const box = page.locator("textarea").first();
  await box.waitFor({ timeout: 15000 });
  // The model list comes from the mock at LM Studio's address.
  for (let i = 0; i < 30; i++) {
    const model = await page.evaluate(() => window.vunemi.listProviders().then((p) => JSON.stringify(p)));
    if (model.includes("mock-tool-model")) break;
    await sleep(1000);
  }
  await box.fill("Write a short note to Documents/vunemi-smoke.txt saying hello.");
  await box.press("Enter");
  const card = page.getByRole("button", { name: "Approve", exact: true }).first();
  const appeared = await card.waitFor({ timeout: 60000 }).then(() => true, () => false);
  await page.screenshot({ path: join(shots, "6-approval.png"), fullPage: true });
  check("first approval card shown", appeared);
  check("nothing written before approval", !existsSync(join(home, "Documents", "vunemi-smoke.txt")));
  if (appeared) {
    await card.click();
    for (let i = 0; i < 20 && !existsSync(join(home, "Documents", "vunemi-smoke.txt")); i++) await sleep(500);
    check("written after approval", existsSync(join(home, "Documents", "vunemi-smoke.txt")) && readFileSync(join(home, "Documents", "vunemi-smoke.txt"), "utf8").includes("Synthetic smoke test"));
    await sleep(1500);
    await page.screenshot({ path: join(shots, "7-after.png"), fullPage: true });
  }
  await browser.close().catch(() => undefined);
} catch (err) {
  check("smoke run", false, String(err?.stack ?? err).slice(0, 600));
} finally {
  app.kill("SIGTERM");
  await sleep(1500);
  app.kill("SIGKILL");
  writeFileSync(join(S, "app.log"), log);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
