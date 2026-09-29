import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { review, translations } from "./content.mjs";
import { release } from "../src/release.mjs";
import { updateFeed } from "../src/update-feed.mjs";
import { languages, pageNames, pagePath, renderPage, redirectPage, shotFiles } from "../src/pages.mjs";
import { supportCopy } from "../src/support-copy.mjs";
import { gatekeeperCopy } from "../src/gatekeeper-copy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// The site lives in website/ of the app repository; the release check compares against the app.
const appRepo = resolve(process.env.VUNEMI_APP_REPO ?? join(here, "../.."));
const publicDir = resolve(here, "../public");
const copy = Object.fromEntries(await Promise.all(languages.map(async (code) => [code, (await import(`../src/copy/${code}.mjs`)).default])));
const languageNames = { tr: "Türkçe", en: "English", de: "Deutsch", fr: "Français", es: "Español", it: "Italiano", pt: "Português", ru: "Русский", zh: "中文", ja: "日本語", ko: "한국어" };
const expectedKeys = Object.keys(translations.tr).sort();
const command = process.argv[2] ?? "--build";

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function validateContent() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(review.date) || !/^[a-f0-9]{40}$/.test(review.commit)) throw new Error("Invalid documentation review metadata");
  for (const language of languages) {
    const copy = translations[language];
    if (!copy || JSON.stringify(Object.keys(copy).sort()) !== JSON.stringify(expectedKeys)) throw new Error(`Documentation keys differ for ${language}`);
    for (const [key, value] of Object.entries(copy)) {
      if (typeof value !== "string" || !value.trim() || value.includes("{{")) throw new Error(`Invalid ${language}.${key}`);
    }
  }
  if (Object.keys(translations).length !== languages.length) throw new Error("Unexpected documentation locale");
}

// Every locale must have exactly the shape of the English copy, with no empty text.
function sameShape(reference, value, path) {
  if (typeof reference === "string") {
    if (typeof value !== "string" || !value.trim()) throw new Error(`Missing site text: ${path}`);
    return;
  }
  if (Array.isArray(reference)) {
    if (!Array.isArray(value) || value.length !== reference.length) throw new Error(`Site list length differs: ${path}`);
    reference.forEach((item, i) => sameShape(item, value[i], `${path}[${i}]`));
    return;
  }
  if (!value || typeof value !== "object" || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(reference).sort())) throw new Error(`Site keys differ: ${path}`);
  for (const key of Object.keys(reference)) sameShape(reference[key], value[key], `${path}.${key}`);
}

function validateSite() {
  for (const language of languages) sameShape(copy.en, copy[language], language);
  for (const language of languages) sameShape(supportCopy.en, supportCopy[language], `support.${language}`);
  for (const language of languages) sameShape(gatekeeperCopy.en, gatekeeperCopy[language], `gatekeeper.${language}`);
  for (const file of [...shotFiles, "hero-plan.png"]) {
    if (!existsSync(join(publicDir, "screenshots", file))) throw new Error(`Missing product screenshot: ${file}`);
  }
  for (const file of ["working-day.jpg", "og.png", "site.css", "site.js", "icon.svg"]) {
    if (!existsSync(join(publicDir, file))) throw new Error(`Missing site asset: ${file}`);
  }
}

function render(language) {
  const t = translations[language];
  const dateLocale = { pt: "pt-BR", zh: "zh-CN" }[language] ?? language;
  const reviewedDate = new Intl.DateTimeFormat(dateLocale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${review.date}T12:00:00Z`));
  const options = languages.map(code => `<option value="${code}"${code === language ? " selected" : ""}>${languageNames[code]}</option>`).join("");
  const alternates = languages.map(code => `<link rel="alternate" hreflang="${code}" href="https://vunemi.com/docs/${code}/">`).join("\n  ");
  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f7f3ec">
  <meta name="description" content="${escapeHtml(t.intro)}">
  <meta name="docs-reviewed-commit" content="${review.commit}">
  <meta name="docs-reviewed-version" content="${review.appVersion}">
  <link rel="canonical" href="https://vunemi.com/docs/${language}/">
  ${alternates}
  <link rel="icon" type="image/svg+xml" href="/icon.svg">
  <title>${escapeHtml(t.title)} — Vunemi</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #26241f; background: #f7f3ec; }
    * { box-sizing: border-box; }
    body { margin: 0; background: radial-gradient(circle at 87% 10%, #ffe4d1 0, transparent 30%), #f7f3ec; }
    a { color: #a64628; }
    a:focus-visible, select:focus-visible { outline: 3px solid #ec673a; outline-offset: 4px; }
    .wrap { width: min(1040px, calc(100% - 40px)); margin: auto; }
    header { display: flex; align-items: center; gap: 20px; padding: 26px 0; }
    .brand { display: inline-flex; align-items: center; gap: 10px; color: #26241f; font-size: 21px; font-weight: 750; letter-spacing: -.04em; text-decoration: none; }
    .brand img { width: 42px; height: 42px; border-radius: 12px; }
    .home { margin-left: auto; text-decoration: none; font-weight: 600; }
    select { max-width: 145px; padding: 9px 12px; border: 1px solid #d9d1c7; border-radius: 11px; background: #fffdf9; color: inherit; font: inherit; }
    main { padding: 62px 0 95px; }
    .eyebrow { color: #ad5030; font-size: 13px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
    h1 { max-width: 800px; margin: 18px 0; font-size: clamp(43px, 7vw, 72px); line-height: 1.07; letter-spacing: -.06em; }
    .intro { max-width: 760px; margin: 0; color: #625a50; font-size: clamp(18px, 2vw, 21px); line-height: 1.65; }
    .status { margin-top: 40px; padding: 25px 29px; border: 1px solid #e9d6c6; border-radius: 18px; background: #fff5ec; }
    .status h2 { margin-top: 0; color: #9d4527; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 17px; margin-top: 56px; }
    section.card { padding: 30px; border: 1px solid #e5ddd2; border-radius: 19px; background: #fffdfa; }
    h2 { margin: 0 0 13px; font-size: 23px; letter-spacing: -.03em; }
    p { margin: 0; line-height: 1.72; }
    .card p, .status p { color: #625a50; }
    .dev { margin-top: 18px; padding: 30px; border: 1px solid #e3d1c0; border-radius: 19px; background: #f8e9dd; }
    .dev p { max-width: 860px; color: #625a50; }
    pre { overflow-x: auto; margin: 22px 0 0; padding: 19px; border-radius: 12px; background: #26241f; color: #fffaf4; line-height: 1.6; }
    code { font: 13px/1.6 ui-monospace, "SF Mono", Menlo, monospace; }
    .reviewed { margin-top: 45px; color: #786f65; font-size: 14px; }
    footer { padding: 25px 0 36px; border-top: 1px solid #ded6cb; color: #786f65; font-size: 14px; }
    @media (max-width: 700px) { header { gap: 12px; } .home { font-size: 14px; } select { max-width: 105px; font-size: 14px; } main { padding-top: 35px; } .grid { grid-template-columns: 1fr; margin-top: 38px; } section.card, .dev, .status { padding: 23px; } }
  </style>
</head>
<body>
  <div class="wrap">
    <header><a class="brand" href="${pagePath(language, "home")}"><img src="/icon.svg" width="42" height="42" alt=""> Vunemi</a><a class="home" href="${pagePath(language, "home")}">${escapeHtml(t.home)}</a><select id="language" aria-label="${escapeHtml(t.language)}">${options}</select></header>
    <main>
      <span class="eyebrow">${escapeHtml(t.docs)}</span>
      <h1>${escapeHtml(t.title)}</h1>
      <p class="intro">${escapeHtml(t.intro)}</p>
      <section class="status"><h2>${escapeHtml(t.statusTitle)}</h2><p>${escapeHtml(t.statusBody)}</p><p><a href="${release.url}">${escapeHtml(copy[language].hero.download)} ↓</a> · <a href="${pagePath(language, "download")}">Vunemi ${release.version}</a></p></section>
      <div class="grid">
        <section class="card"><h2>${escapeHtml(t.modelTitle)}</h2><p>${escapeHtml(t.modelBody)}</p></section>
        <section class="card"><h2>${escapeHtml(t.permissionsTitle)}</h2><p>${escapeHtml(t.permissionsBody)}</p></section>
        <section class="card"><h2>${escapeHtml(t.privacyTitle)}</h2><p>${escapeHtml(t.privacyBody)}</p></section>
        <section class="card"><h2>${escapeHtml(t.safetyTitle)}</h2><p>${escapeHtml(t.safetyBody)}</p></section>
        <section class="card"><h2>${escapeHtml(t.helpTitle)}</h2><p>${escapeHtml(t.helpBody)}</p></section>
        <section class="card"><h2>${escapeHtml(t.contributeTitle)}</h2><p>${escapeHtml(t.contributeBody)}</p><p><a href="https://github.com/capitansuat/vunemi">GitHub ↗</a></p></section>
      </div>
      <section class="dev"><h2>${escapeHtml(t.devTitle)}</h2><p>${escapeHtml(t.devBody)}</p><pre><code>pnpm install\npnpm typecheck\npnpm test\nbash scripts/package.sh</code></pre></section>
      <p class="reviewed">${escapeHtml(t.reviewed)}: ${escapeHtml(reviewedDate)}</p>
    </main>
    <footer>© 2026 Vunemi · ${escapeHtml(t.footer)}</footer>
  </div>
  <script>document.querySelector('#language').addEventListener('change', event => { location.href = '/docs/' + event.target.value + '/'; });</script>
</body>
</html>
`;
}

function rootPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Vunemi documentation</title><meta http-equiv="refresh" content="0;url=/docs/en/"></head><body><script>const l=navigator.language.toLowerCase().split('-')[0];const ok=${JSON.stringify(languages)};location.replace('/docs/'+(ok.includes(l)?l:'en')+'/');</script><a href="/docs/en/">English</a></body></html>\n`;
}

function git(args) {
  return execFileSync("git", args, { cwd: appRepo, encoding: "utf8" }).trim();
}

function releaseCheck() {
  if (!existsSync(join(appRepo, "apps/desktop/package.json"))) throw new Error(`App repository not found at ${appRepo}; set VUNEMI_APP_REPO`);
  const pkg = JSON.parse(readFileSync(join(appRepo, "apps/desktop/package.json"), "utf8"));
  if (pkg.version !== review.appVersion) throw new Error(`App version changed (${pkg.version}); review public docs before release`);
  if (release.version !== review.appVersion) throw new Error(`Site offers ${release.version} but the docs were reviewed for ${review.appVersion}`);
  git(["merge-base", "--is-ancestor", review.commit, "HEAD"]);
  const watched = ["apps/desktop/src", "apps/desktop/package.json", "packages", "native/VunemiHelper"];
  const committed = git(["diff", "--name-only", `${review.commit}..HEAD`, "--", ...watched]);
  const local = git(["status", "--porcelain", "--", ...watched]);
  if (committed || local) throw new Error(`Application changed since documentation review. Recheck the facts and update review.commit/date.\n${committed}\n${local}`);
  if (release.zip !== undefined) {
    if (release.zip !== `Vunemi-${release.version}-arm64.zip`) throw new Error(`Update zip ${release.zip} does not match ${release.version}`);
    if (!/^[a-f0-9]{64}$/.test(release.zipSha256 ?? "") || !(release.zipSizeMb > 0)) throw new Error("Update zip size or SHA-256 missing");
  }
}

try {
  validateContent();
  validateSite();
  const pages = new Map([[join(publicDir, "docs/index.html"), rootPage()]]);
  for (const language of languages) pages.set(join(publicDir, `docs/${language}/index.html`), render(language));
  for (const page of pageNames) {
    pages.set(join(publicDir, pagePath("x", page).slice(3), "index.html"), redirectPage(page));
    for (const language of languages) pages.set(join(publicDir, pagePath(language, page), "index.html"), renderPage(copy, language, page));
  }
  const feed = updateFeed(release, copy, languages);
  if (feed) pages.set(join(publicDir, "update/mac-arm64.json"), `${JSON.stringify(feed, null, 2)}\n`);

  if (!["--build", "--check", "--release-check"].includes(command)) throw new Error(`Unknown option: ${command}`);
  for (const [path, html] of pages) {
    if (command === "--build") {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, html);
    } else if (readFileSync(path, "utf8") !== html) {
      throw new Error(`Generated documentation is stale: ${path}`);
    }
  }
  if (command === "--release-check") releaseCheck();
  console.log(`Vunemi site: ${pages.size} pages in ${languages.length} locales ${command === "--build" ? "generated" : "verified"}`);
} catch (error) {
  console.error(`Vunemi site check failed: ${error.message}`);
  process.exitCode = 1;
}
