// Renders the product pages for one locale as static HTML.
import { release, repoUrl } from "./release.mjs";
import { supportCopy } from "./support-copy.mjs";
import { gatekeeperCopy } from "./gatekeeper-copy.mjs";

export const languages = ["en", "de", "es", "fr", "it", "tr", "pt", "ru", "zh", "ja", "ko"];
export const pageNames = ["home", "features", "screens", "download", "support"];
const paths = { home: "", features: "features/", screens: "screens/", download: "download/", support: "support/" };
const site = "https://vunemi.com";
const supportNav = { en: "Support", de: "Hilfe", es: "Ayuda", fr: "Aide", it: "Aiuto", tr: "Destek", pt: "Ajuda", ru: "Помощь", zh: "支持", ja: "サポート", ko: "지원" };

export function esc(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export const pagePath = (lang, page) => `/${lang}/${paths[page]}`;

// Screenshots shown on the site, in gallery order; captions come from copy.screens.captions.
const shots = [
  ["plan", "09-plan-card.png"], ["browser", "08-browser.png"], ["home", "01-home.png"], ["permissions", "02-permissions.png"],
  ["connections", "03-connections.png"], ["scheduled", "06-scheduled-tasks.png"], ["vault", "05-vault.png"], ["model", "07-model.png"],
];
export const shotFiles = shots.map(([, file]) => file);

const icons = [
  '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/>',
  '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-8 8"/>',
  '<path d="M12 20c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8Z"/><path d="M9 9h6M9 12h6M9 15h4"/>',
  '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
];
const svg = (paths, size = 24) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const lockIcon = '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';
const checkIcon = '<path d="m5 12 4 4 10-10"/>';

function head(t, lang, page) {
  const meta = page === "support" ? { title: `${supportCopy[lang].title} — Vunemi`, description: supportCopy[lang].intro } : t.meta[page];
  const alternates = languages.map((code) => `<link rel="alternate" hreflang="${code}" href="${site}${pagePath(code, page)}">`).join("");
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#fbfaf8">
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.description)}">
<link rel="canonical" href="${site}${pagePath(lang, page)}">
${alternates}<link rel="alternate" hreflang="x-default" href="${site}${pagePath("en", page)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Vunemi">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:url" content="${site}${pagePath(lang, page)}">
<meta property="og:image" content="${site}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="${lang}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<link rel="stylesheet" href="/site.css">
<script>document.documentElement.classList.add("js")</script>
</head>`;
}

function header(t, lang, page, all) {
  const link = (p) => `<a href="${pagePath(lang, p)}"${p === page ? ' aria-current="page"' : ""}>${esc(p === "support" ? supportNav[lang] : t.nav[p])}</a>`;
  const options = languages.map((code) => `<option value="${code}"${code === lang ? " selected" : ""}>${esc(all[code].langName)}</option>`).join("");
  return `<a class="skip" href="#main">${esc(t.skip)}</a>
<header class="bar"><div class="wrap bar-inner">
<a class="brand" href="${pagePath(lang, "home")}"><img src="/icon.svg" width="32" height="32" alt="">Vunemi</a>
<nav class="site-nav" aria-label="${esc(t.nav.home)}">${pageNames.slice(1).map(link).join("")}<a href="/docs/${lang}/">${esc(t.nav.guide)}</a><a href="${repoUrl}">GitHub</a></nav>
<div class="bar-actions"><select id="language" aria-label="${esc(t.language)}" data-page="${paths[page]}">${options}</select><a class="pill small" href="${release.url}">${esc(t.nav.download)}</a></div>
</div></header>
<div class="wrap">`;
}

function footer(t, lang) {
  return `<footer><a class="brand small" href="${pagePath(lang, "home")}"><img src="/icon.svg" width="24" height="24" alt="">Vunemi</a><span>${esc(t.footer)}</span><span>© 2026 · <a href="${repoUrl}">GitHub</a></span></footer>
</div>
<script src="/site.js" defer></script>
</body>
</html>
`;
}

const downloadButton = (t, cls = "pill") => `<a class="${cls}" href="${release.url}">${svg('<path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/>', 18)}${esc(t.hero.download)}</a>`;

// The signature: a small, localized Vunemi window that plays a task through plan, approval and undo.
function demoWindow(t) {
  const d = t.demo;
  return `<div class="demo" aria-hidden="true">
<div class="demo-top"><span class="lights"><i></i><i></i><i></i></span><span class="chip"><b></b>${esc(d.model)}</span></div>
<div class="demo-body">
<p class="bubble user s1">${esc(d.user)}</p>
<div class="typing s2"><i></i><i></i><i></i></div>
<div class="panel plan s3"><p class="panel-title">${svg('<path d="M4 6h10M4 12h10M4 18h10M18 6l1.5 1.5L22 5"/>', 16)}${esc(d.planTitle)}</p><ol>${d.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol><p class="actions"><span class="btn dark press-go">${esc(d.go)}</span><span class="btn">${esc(d.edit)}</span><span class="btn ghost">${esc(d.cancel)}</span></p></div>
<div class="panel approve s4"><div><p class="panel-strong">${esc(d.cardTitle)}</p><p class="panel-sub">${esc(d.cardBody)}</p></div><p class="actions"><span class="btn dark press-ok">${esc(d.approve)}</span><span class="btn">${esc(d.deny)}</span></p></div>
<p class="bubble bot s5">${svg(checkIcon, 16)}${esc(d.done)}</p>
<p class="log s6"><span>${esc(d.logItem)}</span><span class="btn small">${esc(d.undo)}</span></p>
</div>
<p class="demo-foot">${svg(lockIcon, 14)}${esc(d.localNote)}</p>
</div>`;
}

// Small still vignettes, one per strength.
function vignette(t, i) {
  const d = t.demo;
  if (i === 0) return `<div class="vig"><span class="chip big"><b></b>${esc(d.model)}</span><p class="vig-line">${svg(lockIcon, 16)}${esc(d.localNote)}</p><p class="vig-line muted">${svg('<path d="M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8Z"/><path d="m4 4 16 16"/>', 16)}${esc(d.noCloud)}</p></div>`;
  if (i === 1) return `<div class="vig"><div class="panel approve still"><div><p class="panel-strong">${esc(d.cardTitle)}</p><p class="panel-sub">${esc(d.cardBody)}</p></div><p class="actions"><span class="btn dark">${esc(d.approve)}</span><span class="btn">${esc(d.deny)}</span></p></div></div>`;
  return `<div class="vig"><p class="vig-title">${esc(t.featuresPage.safety[2].title)}</p><p class="log still"><span>${esc(d.logItem)}</span><span class="btn small">${esc(d.undo)}</span></p><p class="log still faded"><span>${esc(d.cardTitle)}</span><span class="btn small">${esc(d.undo)}</span></p></div>`;
}

function figure(t, [key, file]) {
  const caption = t.screens.captions[key];
  return `<figure><a href="/screenshots/${file}"><img src="/screenshots/${file}" width="1600" height="1050" alt="${esc(caption)}" loading="lazy" decoding="async"></a><figcaption>${esc(caption)}</figcaption></figure>`;
}

function featureCards(t) {
  return t.features.cards.map((card, i) => `<article class="card reveal"><span class="icon">${svg(icons[i])}</span><h3>${esc(card.title)}</h3><p>${esc(card.body)}</p><p class="example">${esc(card.example)}</p></article>`).join("");
}

const neverSection = (t) => `<section class="never reveal" aria-labelledby="never-title"><div><h2 id="never-title">${esc(t.never.title)}</h2><p>${esc(t.never.intro)}</p></div><ul>${t.never.items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></section>`;
const notesSection = (t, title = t.notes.title, items = t.notes.items) => `<section class="notes reveal"><h2>${esc(title)}</h2><ul>${items.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></section>`;

function home(t, lang) {
  return `<main id="main">
<section class="hero" aria-labelledby="hero-title">
<img class="hero-icon" src="/icon.svg" width="88" height="88" alt="">
<p class="kicker">${esc(t.hero.eyebrow)}</p>
<h1 id="hero-title">${esc(t.hero.title)}</h1>
<p class="lead">${esc(t.hero.lead)}</p>
<div class="hero-actions">${downloadButton(t)}<a class="pill light" href="${pagePath(lang, "features")}">${esc(t.hero.explore)}</a></div>
<p class="download-caution">${esc(gatekeeperCopy[lang][0])} <a href="${pagePath(lang, "download")}">${esc(gatekeeperCopy[lang][6])}</a></p>
<ul class="facts">${t.hero.facts.map((f) => `<li>${esc(f)}</li>`).join("")}<li>v${release.version}</li></ul>
<div class="stage">${demoWindow(t)}</div>
</section>
<section class="section" aria-labelledby="strengths-title">
<h2 id="strengths-title" class="section-title center reveal">${esc(t.strengths.title)}</h2>
<div class="strength-grid">${t.strengths.items.map((s, i) => `<article class="strength reveal">${vignette(t, i)}<h3>${esc(s.title)}</h3><p>${esc(s.body)}</p></article>`).join("")}</div>
</section>
<section class="section" aria-labelledby="features-title">
<h2 id="features-title" class="section-title center reveal">${esc(t.features.title)}</h2>
<p class="section-intro center reveal">${esc(t.features.intro)}</p>
<div class="card-grid">${featureCards(t)}</div>
<p class="center"><a class="more" href="${pagePath(lang, "features")}">${esc(t.features.more)} ›</a></p>
</section>
<section class="section" aria-labelledby="screens-title">
<h2 id="screens-title" class="section-title center reveal">${esc(t.screens.title)}</h2>
<p class="section-intro center reveal">${esc(t.screens.intro)}</p>
<div class="rail" tabindex="0">${shots.map((s) => figure(t, s)).join("")}</div>
<p class="center"><a class="more" href="${pagePath(lang, "screens")}">${esc(t.screens.more)} ›</a></p>
</section>
${neverSection(t)}
<section class="section" aria-labelledby="start-title">
<h2 id="start-title" class="section-title center reveal">${esc(t.start.title)}</h2>
<ol class="steps">${t.start.steps.map((s) => `<li class="reveal"><h3>${esc(s.title)}</h3><p>${esc(s.body)}</p></li>`).join("")}</ol>
<div class="hero-actions">${downloadButton(t)}</div>
</section>
${notesSection(t)}
<section class="story reveal" aria-labelledby="story-title">
<div class="story-copy"><p class="kicker light">${esc(t.story.eyebrow)}</p><h2 id="story-title">${esc(t.story.title)}</h2><p>${esc(t.story.body)}</p></div>
<div class="story-visual"><img class="story-photo" src="/working-day.jpg" width="1536" height="1024" loading="lazy" alt=""><img class="story-screen" src="/screenshots/01-home.png" width="1600" height="1050" loading="lazy" alt=""></div>
</section>
${community(t)}
</main>`;
}

const community = (t) => `<section class="community reveal" aria-labelledby="community-title"><svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 3 .8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7 3.6 3.6 0 0 1 .1-2.7s.8-.3 2.8 1a9.6 9.6 0 0 1 5 0c2-1.3 2.8-1 2.8-1a3.6 3.6 0 0 1 .1 2.7 3.9 3.9 0 0 1 1 2.7c0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.8v2.7c0 .3.2.6.7.5A10 10 0 0 0 12 2Z"/></svg><div><h2 id="community-title">${esc(t.community.title)}</h2><p>${esc(t.community.body)}</p></div><a class="pill light" href="${repoUrl}">${esc(t.community.link)} ↗</a></section>`;

function features(t, lang) {
  const f = t.featuresPage;
  const items = (list) => list.map((i) => `<article class="reveal"><h3>${esc(i.title)}</h3><p>${esc(i.body)}</p></article>`).join("");
  return `<main id="main">
<div class="page-intro"><p class="kicker">${esc(t.hero.eyebrow)}</p><h1>${esc(f.title)}</h1><p>${esc(f.intro)}</p></div>
<div class="card-grid">${featureCards(t)}</div>
<section class="section" aria-labelledby="chat-title"><h2 id="chat-title" class="section-title">${esc(f.chatTitle)}</h2><div class="detail-grid">${items(f.chat)}</div></section>
<section class="section" aria-labelledby="conn-title"><h2 id="conn-title" class="section-title">${esc(f.connTitle)}</h2><p class="section-intro">${esc(f.connIntro)}</p>
<dl class="conn-list">${f.connections.map((c) => `<div><dt>${esc(c.name)}</dt><dd><p>${esc(c.body)}</p><p class="parts"><span>${esc(f.partsLabel)}:</span> ${esc(c.parts)}</p></dd></div>`).join("")}</dl></section>
<section class="section" aria-labelledby="safety-title"><h2 id="safety-title" class="section-title">${esc(f.safetyTitle)}</h2><div class="detail-grid">${items(f.safety)}</div></section>
${neverSection(t)}
<section class="section"><div class="detail-grid two">${items(f.extras)}</div></section>
${notesSection(t)}
<div class="hero-actions">${downloadButton(t)}</div>
</main>`;
}

function screens(t) {
  return `<main id="main">
<div class="page-intro"><p class="kicker">${esc(t.hero.eyebrow)}</p><h1>${esc(t.screensPage.title)}</h1><p>${esc(t.screensPage.intro)}</p></div>
<div class="screenshot-grid">${shots.map((s) => figure(t, s)).join("")}</div>
</main>`;
}

function download(t, lang) {
  const d = t.downloadPage;
  const warning = gatekeeperCopy[lang];
  return `<main id="main">
<section class="download-hero">
<img class="hero-icon" src="/icon.svg" width="96" height="96" alt="">
<h1>${esc(d.title)}</h1>
<p class="lead">${esc(d.intro)}</p>
<div class="hero-actions">${downloadButton(t)}</div>
<p class="file">Vunemi ${release.version} · ${release.asset} · ${release.sizeMb} MB</p>
<p class="release-links"><a href="${release.notes}">${esc(d.notes)} ↗</a><a href="${repoUrl}">${esc(d.source)} ↗</a><a href="/docs/${lang}/">${esc(d.guide)}</a></p>
</section>
<section class="release-highlights" aria-labelledby="release-highlights-title">
<h2 id="release-highlights-title">${esc(d.highlightsTitle)} · ${release.version}</h2>
<ul>${d.highlights.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>
</section>
<aside class="gatekeeper-notice" aria-labelledby="gatekeeper-title">
<div class="gatekeeper-mark" aria-hidden="true">!</div>
<div><h2 id="gatekeeper-title">${esc(warning[1])}</h2><p>${esc(warning[2])}</p><p>${esc(warning[3])}</p><p>${esc(warning[4])}</p><p><a href="https://support.apple.com/en-gb/102445">${esc(warning[5])} ↗</a></p></div>
</aside>
<div class="download-grid">
<section class="panel-box"><h2>${esc(d.installTitle)}</h2><ol class="install">${d.install.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></section>
<section class="panel-box"><h2>${esc(d.requirementsTitle)}</h2><ul>${d.requirements.map((r) => `<li>${esc(r)}</li>`).join("")}</ul><h3>${esc(d.updateTitle)}</h3><p>${esc(d.updateBody)}</p><h3>${esc(d.checksum)}</h3><p class="checksum">${release.sha256}</p></section>
</div>
${notesSection(t)}
</main>`;
}

function support(_t, lang) {
  const s = supportCopy[lang];
  return `<main id="main" class="support-page">
<div class="page-intro"><p class="kicker">Vunemi</p><h1>${esc(s.title)}</h1><p>${esc(s.intro)}</p></div>
<form id="support-form" class="support-form" action="/api/support" method="post" data-sending="${esc(s.sending)}" data-success="${esc(s.success)}" data-failure="${esc(s.failure)}" data-rate="${esc(s.rate)}" data-verify="${esc(s.verify)}">
<input type="hidden" name="language" value="${lang}">
<div class="support-trap" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
<label for="support-category">${esc(s.category)}</label>
<select id="support-category" name="category" required><option value="bug">${esc(s.bug)}</option><option value="idea">${esc(s.idea)}</option><option value="question">${esc(s.question)}</option></select>
<label for="support-version">${esc(s.version)}</label><input id="support-version" name="version" type="text" maxlength="80" autocomplete="off">
<label for="support-message">${esc(s.message)}</label><textarea id="support-message" name="message" minlength="10" maxlength="2000" required rows="7"></textarea>
<p class="support-caution">${esc(s.caution)}</p>
<div class="cf-turnstile" data-sitekey="0x4AAAAAAFFf3gXR1E08P-Ab"></div>
<button class="pill" type="submit">${esc(s.send)}</button><p id="support-status" role="status" aria-live="polite"></p>
</form>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</main>`;
}

const bodies = { home, features, screens, download, support };

export function renderPage(all, lang, page) {
  const t = all[lang];
  return `${head(t, lang, page)}
<body data-page="${page}">
${header(t, lang, page, all)}
${bodies[page](t, lang)}
${footer(t, lang)}`;
}

// The old addresses (/, /features/ …) and ?lang= links land on the right locale.
export function redirectPage(page) {
  const target = paths[page];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vunemi</title>
<link rel="canonical" href="${site}${pagePath("en", page)}">
${languages.map((code) => `<link rel="alternate" hreflang="${code}" href="${site}${pagePath(code, page)}">`).join("")}
<script>(function(){var ok=${JSON.stringify(languages)},q=new URLSearchParams(location.search).get("lang"),s=null;try{s=localStorage.getItem("vunemi.lang")}catch(e){}var n=(navigator.language||"en").toLowerCase().split("-")[0];var l=[q,s,n].find(function(x){return x&&ok.indexOf(x)>=0})||"en";location.replace("/"+l+"/${target}");})();</script>
<meta http-equiv="refresh" content="1;url=/en/${target}">
</head>
<body><p><a href="/en/${target}">Vunemi</a></p></body>
</html>
`;
}
