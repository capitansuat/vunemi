/**
 * Everyday apps through their own scripting dictionaries: Music, Photos,
 * Safari and Chrome, Contacts, Messages. Narrow, fixed scripts; the model's
 * values travel only as JSON. Reads ask once (or for the conversation);
 * anything that plays, exports, opens or sends asks every time. Nothing here
 * buys, deletes or reaches a private browser window it can recognise.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Artifact, ToolContext, ToolDef } from "@vunemi/agent-core";
import { checkNavigation } from "@vunemi/browser";
import type { Roots } from "@vunemi/files";
import { t } from "@vunemi/i18n";
import type { ScriptRunner } from "./runner.js";

const MUSIC = "Music";
const PHOTOS = "Photos";
const CONTACTS = "Contacts";
const MESSAGES = "Messages";
const BROWSERS = { Safari: "com.apple.Safari", "Google Chrome": "com.google.Chrome" } as const;
type Browser = keyof typeof BROWSERS;

const MAX_OUTPUT = 20_000;
const MAX_TABS = 100;
const MAX_RESULTS = 20;
const MAX_EXPORT = 10;
/** Photos may first fetch originals from iCloud. */
const EXPORT_TIMEOUT_MS = 120_000;
/** Small pictures of the first results, for the person; a few, so a search stays quick. */
const MAX_THUMBS = 6;
const THUMB_TIMEOUT_MS = 45_000;
const STILL = /\.(jpe?g|heic|heif|png|tiff?|gif|webp)$/i;
const exec = promisify(execFile);

// -- scripts -----------------------------------------------------------------

export const MUSIC_NOW = `
function run(argv) {
  JSON.parse(argv[0]);
  var app = Application("com.apple.Music");
  if (!app.running()) return JSON.stringify({ running: false });
  var out = { running: true, state: String(app.playerState()) };
  if (out.state !== "stopped") {
    try {
      var tr = app.currentTrack();
      out.track = { name: tr.name(), artist: tr.artist(), album: tr.album(), seconds: Math.round(tr.duration()) };
      out.position = Math.round(app.playerPosition());
    } catch (_) {}
  }
  return JSON.stringify(out);
}`;

export const MUSIC_CONTROL = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var app = Application("com.apple.Music");
  // Asking a closed Music to pause or skip would open it first.
  if (a.action !== "play" && !app.running()) return JSON.stringify({ running: false });
  if (a.action === "play") app.play();
  else if (a.action === "pause") app.pause();
  else if (a.action === "next") app.nextTrack();
  else if (a.action === "previous") app.previousTrack();
  else throw new Error("Unknown action.");
  var out = { state: String(app.playerState()) };
  try { var tr = app.currentTrack(); out.track = { name: tr.name(), artist: tr.artist() }; } catch (_) {}
  return JSON.stringify(out);
}`;

export const MUSIC_PLAY = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var app = Application("com.apple.Music");
  var library = app.sources[0].libraryPlaylists[0];
  var found = app.search(library, { for: a.query }) || [];
  if (found.length === 0) return JSON.stringify({ found: false });
  var tr = found[0];
  tr.play();
  return JSON.stringify({ found: true, matches: found.length, track: { name: tr.name(), artist: tr.artist(), album: tr.album() }, state: String(app.playerState()) });
}`;

export const PHOTOS_SEARCH = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var app = Application("com.apple.Photos");
  var found = app.search({ for: a.query }) || [];
  var out = [];
  for (var i = 0; i < found.length && out.length < a.limit; i++) {
    var item = found[i];
    var date = item.date();
    out.push({ id: item.id(), filename: item.filename(), name: item.name() || "", date: date ? date.toISOString() : null,
      favorite: item.favorite(), width: item.width(), height: item.height() });
  }
  return JSON.stringify({ total: found.length, items: out });
}`;

export const PHOTOS_EXPORT = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var app = Application("com.apple.Photos");
  var items = a.ids.map(function (id) { return app.mediaItems.byId(id); });
  app.export(items, { to: Path(a.folder), usingOriginals: false });
  return JSON.stringify({ ok: true });
}`;

// One folder per photo: an edited photo exports as "FullSizeRender" and two can share a
// name, so a file can't be matched back to its photo by name. One that fails leaves its
// folder empty; losing the permission stops them all.
export const PHOTOS_THUMBS = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var app = Application("com.apple.Photos");
  for (var i = 0; i < a.ids.length; i++) {
    try {
      app.export([app.mediaItems.byId(a.ids[i])], { to: Path(a.folders[i]), usingOriginals: false });
    } catch (e) {
      if (e.errorNumber === -1743 || e.errorNumber === -1712 || e.errorNumber === -600) throw e;
    }
  }
  return JSON.stringify({ ok: true });
}`;

export const BROWSER_TABS = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var app = Application(a.bundle);
  if (!app.running()) return JSON.stringify({ running: false, tabs: [] });
  var chrome = a.bundle === "com.google.Chrome";
  var wins = app.windows();
  var tabs = [];
  var skipped = 0;
  for (var i = 0; i < wins.length && tabs.length < a.limit; i++) {
    var w = wins[i];
    if (chrome && w.mode() === "incognito") { skipped++; continue; }
    var list;
    try { list = w.tabs(); } catch (_) { continue; }
    for (var j = 0; j < list.length && tabs.length < a.limit; j++) {
      var tab = list[j];
      tabs.push({ window: i + 1, title: chrome ? tab.title() : tab.name(), url: tab.url() });
    }
  }
  return JSON.stringify({ running: true, tabs: tabs, skippedPrivate: skipped });
}`;

export const BROWSER_OPEN = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var app = Application(a.bundle);
  if (a.bundle === "com.google.Chrome") {
    var wins = app.windows();
    var target = null;
    for (var i = 0; i < wins.length; i++) if (wins[i].mode() !== "incognito") { target = wins[i]; break; }
    if (target) {
      target.tabs.push(app.Tab({ url: a.url }));
      target.activeTabIndex = target.tabs.length;
    } else {
      var w = app.Window().make();
      w.activeTab.url = a.url;
    }
  } else {
    app.documents.push(app.Document({ url: a.url }));
  }
  app.activate();
  return JSON.stringify({ ok: true });
}`;

export const CONTACTS_SEARCH = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  // Contacts is still AddressBook underneath; "com.apple.Contacts" isn't an app.
  var app = Application("com.apple.AddressBook");
  var found = app.people.whose({ name: { _contains: a.query } })();
  var out = [];
  for (var i = 0; i < found.length && out.length < a.limit; i++) {
    var p = found[i];
    var person = { name: p.name(), organization: p.organization() || "" };
    if (a.want !== "phone") person.emails = p.emails.value().slice(0, 3);
    if (a.want !== "email") person.phones = p.phones.value().slice(0, 3);
    out.push(person);
  }
  return JSON.stringify({ total: found.length, people: out });
}`;

// Says which step failed: before "send" nothing went; at "send" it is unknown.
// The service type is compared here, not in whose(): Messages answered that
// with "Can't convert types".
export const MESSAGES_SEND = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var app = Application("com.apple.MobileSMS");
  var step = "account list";
  var account;
  try {
    var all = app.accounts();
    // One account Messages can't describe (it answered "AppleEvent handler
    // failed" for one) is passed over, not the end of the send.
    step = "account details";
    var skipped = 0;
    for (var i = 0; i < all.length && !account; i++) {
      try {
        if (String(all[i].serviceType()) === a.service && all[i].enabled()) account = all[i];
      } catch (e) {
        if (e.errorNumber === -1743 || e.errorNumber === -1712 || e.errorNumber === -600) throw e;
        skipped++;
      }
    }
    if (!account) return JSON.stringify(skipped === all.length && skipped > 0 ? { failed: step, reason: "Messages couldn't describe any of its " + skipped + " accounts." } : { noAccount: true });
    // Addressed straight by handle, as AppleScript's participant "x" of account
    // does; searching the participants with whose() failed with "AppleEvent handler failed".
    step = "recipient";
    var target = account.participants.byName(a.to);
    step = "send";
    app.send(a.text, { to: target });
  } catch (e) {
    if (e.errorNumber === -1743 || e.errorNumber === -1712 || e.errorNumber === -600) throw e;
    return JSON.stringify({ failed: step, reason: String(e.message || e) });
  }
  return JSON.stringify({ handedOver: true, account: account.description() });
}`;

// -- checks ------------------------------------------------------------------

function words(value: unknown, field: string, max = 200): string {
  const s = String(value ?? "").trim();
  if (!s || s.length > max) throw new Error(`${field} must be 1 to ${max} characters.`);
  return s;
}

function browser(value: unknown): Browser {
  const name = String(value ?? "Safari");
  if (!(name in BROWSERS)) throw new Error('browser must be "Safari" or "Google Chrome".');
  return name as Browser;
}

/** A phone number or an email address; nothing that could name a group chat by accident. */
export function recipient(value: unknown): string {
  const s = String(value ?? "").trim();
  if (/^\+?[0-9][0-9 ()-]{4,19}$/.test(s)) return s.replace(/[ ()-]/g, "");
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200) return s;
  throw new Error("to must be one phone number (e.g. +905551234567) or one email address.");
}

function bounded(value: unknown): string {
  const s = JSON.stringify(value, null, 2);
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n[truncated]` : s;
}

export const MUSIC_GUIDE = `Music:
- music_now_playing says what Music is playing; it does not open Music.
- music_control (play, pause, next, previous) and music_play (search the user's library and play the first match) change what plays; each asks the user. Nothing is bought or downloaded.
- After music_play, say which song actually started (the tool reports it), not the one you hoped for.`;

export const PHOTOS_GUIDE = `Photos:
- photos_search uses the Photos search itself, so it understands the same things as its search field: things and scenes ("dog", "beach"), people the user has named in Photos, places, dates, and text in pictures. Search in the words the user used; try English too if nothing is found.
- It returns ids, file names and dates, not the pictures. To look at pictures, photos_export copies up to 10 of them into a new folder inside an allowed folder; then files_read the exported file.`;

export const BROWSERS_GUIDE = `Safari and Chrome (the user's own browsers, separate from Vunemi's browser):
- browser_tabs lists open tabs (title and address). Chrome's incognito windows are skipped; Safari's scripting can't tell private windows apart, so say that if it matters.
- browser_open_url opens a public http(s) page; it asks the user each time.`;

export const CONTACTS_GUIDE = `Contacts:
- contacts_search finds people by name and returns their name, organisation, and up to three emails or phone numbers. Set want to the one detail the task needs: email for mail, phone for a text. If a task truly needs both, search twice. Don't repeat details the user didn't ask for.`;

export const MESSAGES_GUIDE = `Messages:
- messages_send sends a real message from the user's own Messages account. Only when the user asked for this exact message. Find the address with contacts_search (open the contacts group) if you only have a name; if several match, ask.
- It asks the user every time and shows them the recipient and text. It can only confirm it handed the message to Messages, not that it was delivered; say so.`;


// -- tools -------------------------------------------------------------------

/** A message repeated within this long is flagged on the card: usually a retry, not a wish. */
const REPEAT_WINDOW_MS = 30 * 60_000;
/** Contacts carry other people's details; fewer is enough to pick the right person. */
const MAX_CONTACTS = 10;

export interface EverydayOptions {
  /** Vunemi's own folder for small pictures of found photos; none, none shown. */
  thumbDir?: string;
}

interface FoundPhoto { id: string; filename: string; date: string | null }

/**
 * Small PNG copies of the first photos found, made in Vunemi's own folder:
 * Photos exports each, sips shrinks it, the export is thrown away. For the
 * person's eyes on the call card; the model never gets them. Best effort:
 * a search never fails for want of a picture.
 */
async function thumbnails(run: ScriptRunner, dir: string, items: FoundPhoto[], ctx: ToolContext): Promise<Artifact[]> {
  const stills = items.filter((item) => STILL.test(item.filename)).slice(0, MAX_THUMBS);
  if (stills.length === 0) return [];
  const folder = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const raw = join(folder, "export");
  const folders = stills.map((_, i) => join(raw, String(i + 1)));
  for (const each of folders) mkdirSync(each, { recursive: true });
  try {
    await run(PHOTOS_THUMBS, { app: PHOTOS, ids: stills.map((item) => item.id), folders }, { timeoutMs: THUMB_TIMEOUT_MS, signal: ctx.signal });
    const out: Artifact[] = [];
    for (const [i, item] of stills.entries()) {
      const file = readdirSync(folders[i]!).find((name) => !name.startsWith("."));
      if (!file) continue;
      const png = join(folder, `${i + 1}.png`);
      await exec("/usr/bin/sips", ["-Z", "480", "-s", "format", "png", join(folders[i]!, file), "--out", png], { timeout: 20_000, signal: ctx.signal });
      out.push({ kind: "image", path: png, label: item.date ? `${item.filename} · ${item.date.slice(0, 10)}` : item.filename });
    }
    return out;
  } finally {
    rmSync(raw, { recursive: true, force: true });
  }
}

export function createEverydayTools(run: ScriptRunner, roots: Roots, opts: EverydayOptions = {}): ToolDef[] {
  /** Messages handed to Messages, by recipient and text, so a retry shows on the card. */
  const sent = new Map<string, number>();
  const sentAgo = (to: unknown, text: unknown): number | null => {
    let who = String(to ?? "").trim();
    try {
      who = recipient(to);
    } catch {
      // Refused when it runs; the card keeps what was asked.
    }
    const at = sent.get(`${who.toLowerCase()}\u0000${String(text ?? "")}`);
    return at !== undefined && Date.now() - at < REPEAT_WINDOW_MS ? Math.max(1, Math.round((Date.now() - at) / 60_000)) : null;
  };
  const readOnce = (scope: string) => ({ actionClass: "read" as const, alwaysAsk: true as const, allowSessionApproval: true as const, approvalScope: () => scope, untrustedOutput: true });
  return [
    {
      name: "music_now_playing",
      description: "Say what the Music app is playing: state, song, artist, album, position. Does not open Music if it is closed.",
      parameters: { type: "object", properties: {} },
      ...readOnce("mac-app:music"),
      preview: async () => t("connectors.apps.requestPreview", { app: MUSIC }),
      async run() {
        const now = (await run(MUSIC_NOW, { app: MUSIC })) as { running: boolean };
        return now.running ? bounded(now) : "Music is not open.";
      },
    },
    {
      name: "music_control",
      description: "Play, pause, or skip to the next or previous song in Music.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["play", "pause", "next", "previous"] } }, required: ["action"] },
      actionClass: "write-local",
      alwaysAsk: true,
      preview: async (a) => t("apps.music.control", { action: t(`apps.music.${["play", "pause", "next", "previous"].includes(String(a.action)) ? String(a.action) : "play"}` as "apps.music.play") }),
      async run(a) {
        const action = String(a.action ?? "");
        if (!["play", "pause", "next", "previous"].includes(action)) throw new Error("action must be play, pause, next or previous.");
        const result = (await run(MUSIC_CONTROL, { app: MUSIC, action })) as { running?: boolean };
        return result.running === false ? `Music is not open, so there is nothing to ${action === "pause" ? "pause" : "skip"}. Nothing was changed.` : bounded(result);
      },
    },
    {
      name: "music_play",
      description: "Search the user's Music library (song, artist or album) and play the first match.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      actionClass: "write-local",
      alwaysAsk: true,
      preview: async (a) => t("apps.music.search", { query: String(a.query ?? "").slice(0, 100) }),
      async run(a) {
        const query = words(a.query, "query");
        const result = (await run(MUSIC_PLAY, { app: MUSIC, query })) as { found: boolean };
        return result.found ? bounded(result) : `Nothing in the Music library matches "${query}".`;
      },
    },
    {
      name: "photos_search",
      description:
        "Search the Photos library the way its search field does: things and scenes (\"dog\"), named people, places, dates, text in pictures. Returns up to 20 items: id, file name, date, size. Not the pictures themselves.",
      parameters: { type: "object", properties: { query: { type: "string", description: 'e.g. "dog", "Ayşe", "Istanbul 2024"' } }, required: ["query"] },
      ...readOnce("mac-app:photos"),
      preview: async (a) => t("connectors.apps.requestPreview", { app: `${PHOTOS}: "${String(a.query ?? "").slice(0, 80)}"` }),
      async run(a, ctx) {
        const query = words(a.query, "query");
        const result = (await run(PHOTOS_SEARCH, { app: PHOTOS, query, limit: MAX_RESULTS }, { timeoutMs: 60_000 })) as { total: number; items?: FoundPhoto[] };
        if (result.total === 0) return `Photos found nothing for "${query}".`;
        let shown = 0;
        if (opts.thumbDir && ctx.gallery && result.items?.length) {
          try {
            const pictures = await thumbnails(run, opts.thumbDir, result.items, ctx);
            if (pictures.length > 0) ctx.gallery(pictures);
            shown = pictures.length;
          } catch (error) {
            if (ctx.signal.aborted) throw error;
          }
        }
        // The model can't see them; it should know the person can.
        return `${bounded(result)}${shown > 0 ? `\nThe user sees small pictures of the first ${shown} on the card, and can click one to see it larger. You don't see them.` : ""}`;
      },
    },
    {
      name: "photos_export",
      description: "Copy up to 10 photos (ids from photos_search) into a new folder inside an allowed folder, as files the user and files_read can open.",
      parameters: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "string" } }, folder: { type: "string", description: "An allowed folder, e.g. ~/Desktop" } },
        required: ["ids", "folder"],
      },
      actionClass: "write-local",
      alwaysAsk: true,
      preview: async (a) => t("apps.photos.export", { count: Array.isArray(a.ids) ? a.ids.length : 0, folder: String(a.folder ?? "") }),
      async run(a, ctx) {
        const ids = Array.isArray(a.ids) ? a.ids.map((id) => String(id)).filter((id) => /^[A-Za-z0-9/_:-]{1,120}$/.test(id)) : [];
        if (ids.length === 0 || ids.length > MAX_EXPORT || ids.length !== (a.ids as unknown[]).length) throw new Error(`Give 1 to ${MAX_EXPORT} photo ids from photos_search.`);
        const parent = roots.resolve(String(a.folder ?? ""), "write");
        if (!statSync(parent).isDirectory()) throw new Error("folder must be a folder.");
        // A new folder of its own, so an export can never replace a file already there.
        // In the user's own time, as Finder shows it.
        const now = new Date();
        const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replace("T", " ").replace(/:/g, ".");
        const folder = join(parent, `Vunemi Photos ${stamp}`);
        mkdirSync(folder);
        await run(PHOTOS_EXPORT, { app: PHOTOS, ids, folder }, { timeoutMs: EXPORT_TIMEOUT_MS, signal: ctx.signal });
        const files = readdirSync(folder).filter((name) => !name.startsWith("."));
        if (files.length === 0) throw new Error("Photos reported the export, but the folder is empty.");
        for (const name of files) ctx.produced?.({ kind: "file", path: join(folder, name) });
        // Whole paths, so the model reads each file by the path it was given.
        return `Exported ${files.length} file(s) into a new folder. Their paths:\n${files.map((name) => `- ${join(folder, name)}`).join("\n")}`;
      },
    },
    {
      name: "browser_tabs",
      description: "List the open tabs (title and address) in the user's Safari or Google Chrome. Does not open the browser if it is closed.",
      parameters: { type: "object", properties: { browser: { type: "string", enum: Object.keys(BROWSERS) } }, required: ["browser"] },
      actionClass: "read",
      alwaysAsk: true,
      allowSessionApproval: true,
      approvalScope: (a) => `mac-app:${String(a.browser ?? "Safari").toLowerCase()}`,
      untrustedOutput: true,
      preview: async (a) => t("connectors.apps.requestPreview", { app: String(a.browser ?? "Safari") }),
      async run(a) {
        const name = browser(a.browser);
        const result = (await run(BROWSER_TABS, { app: name, bundle: BROWSERS[name], limit: MAX_TABS })) as { running: boolean; tabs: unknown[] };
        if (!result.running) return `${name} is not open.`;
        return result.tabs.length === 0 ? `${name} has no open tabs it can show.` : bounded(result);
      },
    },
    {
      name: "browser_open_url",
      description: "Open a public http(s) page in the user's own Safari or Google Chrome (not Vunemi's browser).",
      parameters: { type: "object", properties: { browser: { type: "string", enum: Object.keys(BROWSERS) }, url: { type: "string" } }, required: ["browser", "url"] },
      actionClass: "write-local",
      alwaysAsk: true,
      preview: async (a) => t("apps.browser.open", { browser: String(a.browser ?? "Safari"), url: String(a.url ?? "").slice(0, 200) }),
      async run(a) {
        const name = browser(a.browser);
        const url = String(a.url ?? "").trim();
        // The same rule as Vunemi's own browser: public http(s) pages only.
        const refused = url === "about:blank" ? "Give a full http(s) address." : checkNavigation(url);
        if (refused) throw new Error(refused);
        await run(BROWSER_OPEN, { app: name, bundle: BROWSERS[name], url: new URL(url).href });
        return `Opened ${new URL(url).href} in ${name}.`;
      },
    },
    {
      name: "contacts_search",
      description: "Find people in Contacts by name. Returns up to 10: name, organisation, and up to three emails or phone numbers, whichever want asks for.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          want: { type: "string", enum: ["email", "phone"], description: "The one detail the task needs: email for mail, phone for a text. The other is not read." },
        },
        required: ["query", "want"],
      },
      ...readOnce("mac-app:contacts"),
      preview: async (a) => t("connectors.apps.requestPreview", { app: `${CONTACTS}: "${String(a.query ?? "").slice(0, 80)}"` }),
      async run(a) {
        const query = words(a.query, "query", 100);
        // One detail at a time: offered "both", a small model took it for an email.
        if (a.want !== "email" && a.want !== "phone") throw new Error('want must be "email" or "phone". Search again for the other if the task needs both.');
        const want = a.want;
        const result = (await run(CONTACTS_SEARCH, { app: CONTACTS, query, want, limit: MAX_CONTACTS })) as { total: number };
        return result.total === 0 ? `No contact's name contains "${query}".` : bounded(result);
      },
    },
    {
      name: "messages_send",
      description: "Send one text message from the user's own Messages account to one phone number or email address. Asks the user every time; only for a message the user asked for.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "One phone number with country code, or one email address" },
          text: { type: "string" },
          service: { type: "string", enum: ["iMessage", "SMS", "RCS"], description: "Default iMessage" },
        },
        required: ["to", "text"],
      },
      actionClass: "outbound",
      alwaysAsk: true,
      preview: async (a) => {
        const card = t("apps.messages.send", { service: String(a.service ?? "iMessage"), to: String(a.to ?? ""), text: String(a.text ?? "").slice(0, 500) });
        const ago = sentAgo(a.to, a.text);
        return ago === null ? card : `${t("apps.messages.repeat", { minutes: ago })}\n${card}`;
      },
      async run(a) {
        const to = recipient(a.to);
        const text = String(a.text ?? "");
        if (!text.trim() || text.length > 2000) throw new Error("text must be 1 to 2000 characters.");
        const service = String(a.service ?? "iMessage");
        if (!["iMessage", "SMS", "RCS"].includes(service)) throw new Error("service must be iMessage, SMS or RCS.");
        const result = (await run(MESSAGES_SEND, { app: MESSAGES, to, text, service })) as { noAccount?: boolean; account?: string; failed?: string; reason?: string };
        if (result.noAccount) throw new Error(t("apps.messages.noAccount", { service }));
        if (result.failed === "send") {
          // Maybe sent: remembered, so a second try shows on the card as a repeat.
          sent.set(`${to.toLowerCase()}\u0000${text}`, Date.now());
          throw new Error(t("apps.messages.sendUnknown", { detail: result.reason ?? "" }));
        }
        if (result.failed) throw new Error(t("apps.messages.notSent", { step: result.failed, detail: result.reason ?? "" }));
        const ago = sentAgo(to, text);
        sent.set(`${to.toLowerCase()}\u0000${text}`, Date.now());
        return `${ago !== null ? `The same text went to ${to} ${ago} min ago as well. ` : ""}Handed to Messages to send with ${service} (${result.account ?? "account"}) to ${to}. Messages doesn't report delivery to Vunemi; the user can check it in Messages.`;
      },
    },
  ];
}
