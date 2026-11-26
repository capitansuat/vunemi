#!/usr/bin/env node
// Builds Vunemi for Windows: a per-user installer (NSIS, no administrator
// rights) for x64 or arm64. The macOS build is scripts/package.sh, Linux's is
// scripts/package-linux.sh; nothing here signs anything.
//
//  * Runs on the ARM64 Windows machine for both architectures: the engines
//    are built by scripts/windows/build-*.ps1 (x64 cross-compiled) and put
//    into the unpacked app before the installer is made from it.
//  * A local test build (the default) may be opened with
//    --remote-debugging-port and pointed at a local update feed, as on macOS;
//    VUNEMI_DISTRIBUTION=1 makes a build for other people that refuses both.
//
// Usage: node scripts/package-windows.mjs --arch x64|arm64
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const fail = (message) => {
  console.error(`! ${message}`);
  process.exit(1);
};

if (process.platform !== "win32") fail("bu betik Windows içindir; macOS için: scripts/package.sh");
const archAt = process.argv.indexOf("--arch");
const arch = archAt >= 0 ? process.argv[archAt + 1] : undefined;
if (arch !== "x64" && arch !== "arm64") fail("--arch x64 ya da --arch arm64 gerekli");

const distribution = process.env.VUNEMI_DISTRIBUTION === "1";
const root = process.env.VUNEMI_BUILD_DIR ?? join(homedir(), ".vunemi-build");
const out = join(root, distribution ? "windows-dist" : "windows", arch);

/** A pinned tag, read from the script that pins it, so there is one place. */
function pinned(script, name) {
  const text = readFileSync(join(here, "scripts", script), "utf8");
  const found = new RegExp(`${name}="\\$\\{[A-Z_]+:-([^}]+)\\}"`).exec(text)?.[1];
  if (!found) fail(`${script}: ${name} okunamadı`);
  return found;
}
const engineCache = join(root, "engine-cache", `${pinned("engine-version.sh", "engine_tag")}-win-${arch}`);
const whisperCache = join(root, "whisper-cache", `${pinned("build-whisper-linux.sh", "tag")}-win-${arch}`);
const moveCache = join(root, "move-cache", `${pinned("build-move-linux.sh", "version")}-win-${arch}`);

/**
 * Runs a fixed command (no user input in it). pnpm is a .cmd, which needs the
 * shell; it then gets one command line, each argument quoted.
 */
function run(command, args, opts = {}) {
  const env = { ...process.env, ...opts.env };
  const result = opts.shell
    ? spawnSync([command, ...args.map((arg) => `"${arg}"`)].join(" "), { cwd: here, stdio: "inherit", shell: true, env })
    : spawnSync(command, args, { cwd: here, stdio: "inherit", env });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} (${result.status ?? result.error?.message})`);
}

/** Nothing of the builder's own folders in what ships, as text or as Windows' UTF-16. */
function noBuilderPath(file) {
  const bytes = readFileSync(file);
  const needle = "C:\\Users\\";
  for (const text of [bytes.toString("latin1"), bytes.toString("utf16le")]) {
    if (text.toLowerCase().includes(needle.toLowerCase())) fail(`${file} derleme yolunu (kullanıcı klasörü) içeriyor`);
  }
}

const ps = (script) => ["-NoProfile", "-NonInteractive", "-File", join(here, "scripts", "windows", script), "-Arch", arch];
console.log("› motor");
run("powershell.exe", ps("build-engine.ps1"));
console.log("› ses motoru");
run("powershell.exe", ps("build-whisper.ps1"));
console.log("› taşıma programı");
run("powershell.exe", ps("build-move.ps1"));

console.log(`› uygulama paketleniyor → ${out} (${arch})`);
run("pnpm", ["--filter", "@vunemi/desktop", "exec", "electron-vite", "build"], { shell: true });
// Without an author, Electron's own company name stays in the .exe's details; Windows should show Vunemi's.
// The install folder is named after the package ("@vunemi/desktop" would make "@vunemidesktop").
// Both electron-builder runs need these: the installer is made from the metadata too.
const metadata = ["--config.extraMetadata.author.name=Vunemi", "--config.extraMetadata.name=vunemi"];
const testBuild = [...metadata, ...(distribution ? [] : ["--config.extraMetadata.vunemiLocalTestBuild=true"])];
if (distribution) console.log("› dağıtım derlemesi: uzaktan hata ayıklama ve yerel güncelleme beslemesiyle açılmaz");
rmSync(out, { recursive: true, force: true });
// arm64: 7-Zip packs ARM64 .exe and .dll files with its ARM64 filter, which the
// installer's own unpacker (NSIS's 7z plugin) doesn't know: it skipped
// Vunemi.exe, both engines and every DLL, and still ended with exit code 0.
// BCJ, which it knows, is forced instead; checked after the build below.
const builderEnv = arch === "arm64" ? { ELECTRON_BUILDER_7Z_FILTER: "BCJ" } : {};
const builder = (...args) => run("pnpm", ["--filter", "@vunemi/desktop", "exec", "electron-builder", "--win", ...args, `--${arch}`, "--publish", "never", `--config.directories.output=${out}`], { shell: true, env: builderEnv });
builder("dir", ...testBuild);

const unpacked = join(out, arch === "x64" ? "win-unpacked" : "win-arm64-unpacked");
const resources = join(unpacked, "resources");
if (!existsSync(resources)) fail(`açılmış uygulama yok: ${unpacked}`);
const company = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item '${join(unpacked, "Vunemi.exe")}').VersionInfo.CompanyName`], { encoding: "utf8" }).stdout.trim();
if (company !== "Vunemi") fail(`Vunemi.exe'nin şirket adı "${company}"`);
for (const [from, name] of [[engineCache, "llama-server.exe"], [whisperCache, "whisper-server.exe"], [moveCache, "vunemi-move.exe"]]) {
  if (!existsSync(join(from, name))) fail(`${name} yok: ${from}`);
  copyFileSync(join(from, name), join(resources, name));
  noBuilderPath(join(resources, name));
}
const licenses = join(resources, "licenses");
mkdirSync(licenses, { recursive: true });
copyFileSync(join(engineCache, "LICENSE"), join(licenses, "llama.cpp-LICENSE"));
copyFileSync(join(whisperCache, "LICENSE"), join(licenses, "whisper.cpp-LICENSE"));
// The flight search is based on Fli (MIT); its notice ships with the app.
copyFileSync(join(here, "apps", "desktop", "src", "main", "flights", "LICENSE"), join(licenses, "fli-LICENSE"));
copyFileSync(join(here, "LICENSE"), join(licenses, "Vunemi-LICENSE"));

console.log("› kurulum dosyası");
builder("nsis", "--prepackaged", unpacked, ...metadata);

const made = readdirSync(out).filter((name) => /^Vunemi-Setup-.*\.exe$/.test(name));
if (made.length !== 1) fail(`beklenen tek kurulum dosyası yerine: ${made.join(", ") || "hiçbiri"}`);

/** The 7z methods inside an installer, with electron-builder's own 7za. */
async function methodsIn(installer) {
  const desktop = createRequire(join(here, "apps", "desktop", "package.json"));
  const { getPath7za } = createRequire(desktop.resolve("electron-builder"))("app-builder-lib/out/toolsets/7zip");
  const list = spawnSync(await getPath7za(), ["l", "-slt", installer], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (list.status !== 0) fail(`kurulum dosyasının içi okunamadı (${list.status ?? list.error?.message})`);
  return [...list.stdout.matchAll(/^Method = (.+)$/gm)].map((m) => m[1].trim());
}
const methods = await methodsIn(join(out, made[0]));
if (methods.length === 0) fail("kurulum dosyasının içinde sıkıştırılmış dosya görünmedi");
if (methods.some((m) => /\bARM64\b/.test(m))) fail("kurulum dosyasında ARM64 filtresiyle sıkıştırılmış dosya var: kurulum bunları açmadan atlar");
console.log(`› hazır: ${join(out, made[0])}`);
