/**
 * Notes, through its own scripting dictionary. Notes' body is HTML; Vunemi
 * writes plain text escaped into it and reads the plain-text form back.
 * Locked notes are left closed. Deleting puts a note in Recently Deleted,
 * where Notes keeps it for 30 days, and never touches one already there:
 * deleting it again would be for good.
 */

import type { ToolContext, ToolDef } from "@ocak/agent-core";
import { t } from "@ocak/i18n";
import type { ScriptRunner } from "./runner.js";

const APP = "Notes";
const MAX_TEXT = 20_000;
const LIMIT = 20;

/** Shared by the write templates: text → Notes HTML, safely. */
const HTML = `
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function paragraphs(s) { return String(s).split("\\n").map(function (l) { return "<div>" + (l ? esc(l) : "<br>") + "</div>"; }).join(""); }
`;

export const NOTES_SEARCH = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var Notes = Application("com.apple.Notes");
  var q = a.query;
  var scope = a.folder ? Notes.folders.byName(a.folder).notes : Notes.notes;
  var found = scope.whose({ _or: [{ name: { _contains: q } }, { plaintext: { _contains: q } }] })();
  var out = [];
  for (var i = 0; i < found.length && out.length < a.limit; i++) {
    var n = found[i];
    out.push({ id: n.id(), name: n.name(), folder: n.container().name(), modified: n.modificationDate().toISOString() });
  }
  return JSON.stringify(out);
}`;

export const NOTES_READ = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var n = Application("com.apple.Notes").notes.byId(a.id);
  var locked = n.passwordProtected();
  return JSON.stringify({ name: n.name(), text: locked ? "" : n.plaintext(), locked: locked });
}`;

export const NOTES_CREATE = `${HTML}
function run(argv) {
  var a = JSON.parse(argv[0]);
  var Notes = Application("com.apple.Notes");
  var folder;
  if (a.folder) {
    var named = Notes.folders.whose({ name: a.folder })();
    if (named.length === 0) return JSON.stringify({ noFolder: true, folders: Notes.folders.name().slice(0, 50) });
    folder = named[0];
  } else {
    folder = Notes.defaultAccount().defaultFolder();
  }
  // The same title in the same folder is almost always a retry or a note to add to.
  var twins = folder.notes.whose({ name: a.title })();
  if (twins.length > 0 && !a.again) return JSON.stringify({ exists: { id: twins[0].id(), name: twins[0].name() } });
  var note = Notes.Note({ body: "<h1>" + esc(a.title) + "</h1>" + paragraphs(a.body) });
  folder.notes.push(note);
  return JSON.stringify({ id: note.id(), name: note.name() });
}`;

export const NOTES_APPEND = `${HTML}
function run(argv) {
  var a = JSON.parse(argv[0]);
  var n = Application("com.apple.Notes").notes.byId(a.id);
  if (n.passwordProtected()) throw new Error("The note is locked.");
  n.body = n.body() + paragraphs(a.text);
  return JSON.stringify({ id: n.id(), name: n.name() });
}`;

/** A note's name and folder, for a card: nothing of what it says. */
export const NOTES_INFO = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var n = Application("com.apple.Notes").notes.byId(a.id);
  return JSON.stringify({ name: n.name(), folder: n.container().name() });
}`;

/**
 * Changes one passage, found exactly once, and leaves the rest of the note —
 * its formatting, lists and links — as it was. Notes with attachments are
 * refused: writing their body back could lose what is attached.
 */
export const NOTES_EDIT = `${HTML}
function run(argv) {
  var a = JSON.parse(argv[0]);
  var n = Application("com.apple.Notes").notes.byId(a.id);
  if (n.passwordProtected()) return JSON.stringify({ locked: true, name: n.name() });
  if (n.attachments().length > 0) return JSON.stringify({ attachments: true, name: n.name() });
  var body = n.body();
  var find = esc(a.find);
  var count = body.split(find).length - 1;
  if (count !== 1) return JSON.stringify({ count: count, plain: n.plaintext().split(a.find).length - 1, name: n.name() });
  var repl = esc(a.replace).split("\\n").join("<br>");
  n.body = body.replace(find, function () { return repl; });
  return JSON.stringify({ id: n.id(), name: n.name(), before: body, after: n.body() });
}`;

/** Undo of an edit: puts the old body back, unless the note changed since. */
export const NOTES_SET_BODY = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var n = Application("com.apple.Notes").notes.byId(a.id);
  if (n.body() !== a.expect) return JSON.stringify({ changed: true, name: n.name() });
  n.body = a.body;
  return JSON.stringify({ name: n.name() });
}`;

/**
 * Deletes into Recently Deleted. A note already there, locked, or in a
 * folder Vunemi can't name is left alone; what happened is read back, not
 * assumed.
 */
export const NOTES_DELETE = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var Notes = Application("com.apple.Notes");
  var n = Notes.notes.byId(a.id);
  var name = n.name();
  var folder = n.container();
  var folderName = folder.name();
  if (a.trash.indexOf(folderName) !== -1) return JSON.stringify({ inTrash: true, name: name });
  if (n.passwordProtected()) return JSON.stringify({ locked: true, name: name });
  var from = folder.id();
  Notes.delete(n);
  var where = null;
  try { where = Notes.notes.byId(a.id).container().name(); } catch (e) {}
  return JSON.stringify({ name: name, from: from, fromName: folderName, where: where });
}`;

/** Undo of a delete: the same note, back in the folder it came from. */
export const NOTES_RESTORE = `
function run(argv) {
  var a = JSON.parse(argv[0]);
  var Notes = Application("com.apple.Notes");
  var n = Notes.notes.byId(a.id);
  Notes.move(n, { to: Notes.folders.byId(a.folder) });
  return JSON.stringify({ name: n.name(), folder: n.container().name() });
}`;

/**
 * What Notes calls its Recently Deleted folder, in the languages Vunemi
 * speaks. A note in it is never deleted again from here.
 */
export const RECENTLY_DELETED = [
  "Recently Deleted", "Son Silinenler", "Zuletzt gelöscht", "Suppressions récentes", "Eliminado recientemente",
  "Eliminados recientemente", "Eliminati di recente", "Apagados Recentemente", "Excluídos Recentemente",
  "Eliminadas recentemente", "Недавно удаленные", "Недавно удалённые", "最近删除", "最近刪除", "最近削除した項目", "최근 삭제된 항목",
];

interface Found {
  id: string;
  name: string;
  folder: string;
  modified: string;
}

function text(value: unknown, field: string): string {
  const s = String(value ?? "").trim();
  if (!s) throw new Error(`${field} must not be empty.`);
  return s;
}

function optional(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return s ? s : null;
}

export const NOTES_INSTRUCTIONS = `Using Notes:
- notes_search finds notes by words in the title or text and gives each note's id. notes_read needs that id.
- notes_create makes a new note; notes_append adds lines to the end of one.
- notes_edit changes one passage: give the exact text as notes_read showed it and what to put instead ("" removes it). notes_delete moves a note to Recently Deleted. The user approves each and can undo it.
- Locked notes cannot be read.`;

export function createNotesTools(run: ScriptRunner): ToolDef[] {
  /** Note names by id, from searches and writes, so a card can say which note it changes. */
  const names = new Map<string, string>();
  /**
   * For a card that changes a note: its name, and whether it sits in Recently
   * Deleted. Asked of Notes when the note wasn't listed in this conversation.
   */
  async function about(id: string): Promise<{ name: string; trashed: boolean }> {
    try {
      const info = (await run(NOTES_INFO, { app: APP, id })) as { name: string; folder: string };
      names.set(id, info.name);
      return { name: info.name, trashed: RECENTLY_DELETED.includes(info.folder) };
    } catch {
      return { name: names.get(id) ?? "?", trashed: false };
    }
  }
  return [
    {
      name: "notes_search",
      description: "Search the user's Notes by words in the title or text. Returns up to 20 notes with their ids.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to look for." },
          folder: { type: "string", description: "Only this folder, by name. Optional." },
        },
        required: ["query"],
      },
      actionClass: "read",
      untrustedOutput: true,
      preview: async (a) => t("apps.notes.search", { query: String(a.query ?? "").slice(0, 60) }),
      async run(a) {
        const found = (await run(NOTES_SEARCH, { app: APP, query: text(a.query, "query"), folder: optional(a.folder), limit: LIMIT })) as Found[];
        if (found.length === 0) return `No notes contain "${String(a.query)}".`;
        for (const n of found) names.set(n.id, n.name);
        return found.map((n) => `- ${n.name} (folder ${n.folder}, changed ${n.modified.slice(0, 10)}) id=${n.id}`).join("\n");
      },
    },
    {
      name: "notes_read",
      description: "Read the text of one note, by the id notes_search gave.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "The note's id from notes_search." } },
        required: ["id"],
      },
      actionClass: "read",
      untrustedOutput: true,
      // Only a name already listed: reading the note for its card would be the read itself.
      preview: async (a) => {
        const name = names.get(String(a.id ?? ""));
        return name === undefined ? t("apps.notes.readAny") : t("apps.notes.read", { name: name.slice(0, 80) });
      },
      async run(a) {
        const note = (await run(NOTES_READ, { app: APP, id: text(a.id, "id") })) as { name: string; text: string; locked: boolean };
        if (note.locked) return `The note "${note.name}" is locked; Vunemi can't read it. The user can open it in Notes.`;
        names.set(String(a.id), note.name);
        // Notes starts the text with the title; said once is enough.
        const lines = note.text.split("\n");
        const content = lines[0]?.trim() === note.name.trim() ? lines.slice(1).join("\n").replace(/^\n+/, "") : note.text;
        const body = content.length > MAX_TEXT
          ? `${content.slice(0, MAX_TEXT)}\n[… ${content.length - MAX_TEXT} more characters not shown]`
          : content;
        return `# ${note.name}\n${body}`;
      },
    },
    {
      name: "notes_create",
      description: "Create a new note with a title and plain text. Lines are kept.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The note's title." },
          body: { type: "string", description: "The note's text. Use \\n for new lines." },
          folder: { type: "string", description: "Folder name. Optional; the default folder otherwise." },
          again: { type: "boolean", description: "Only when the user wants a second note with a title that already exists." },
        },
        required: ["title", "body"],
      },
      actionClass: "write-local",
      preview: async (a) => t("apps.notes.create", { title: String(a.title ?? "").slice(0, 60) }),
      async run(a) {
        const made = (await run(NOTES_CREATE, {
          app: APP,
          title: text(a.title, "title"),
          body: String(a.body ?? ""),
          folder: optional(a.folder),
          again: a.again === true,
        })) as { id: string; name: string; noFolder?: boolean; folders?: string[]; exists?: { id: string; name: string } };
        if (made.noFolder) throw new Error(`Notes has no folder called "${String(a.folder)}". Folders: ${(made.folders ?? []).join(", ")}.`);
        if (made.exists) {
          names.set(made.exists.id, made.exists.name);
          return `Nothing was created: a note called "${made.exists.name}" already exists there (id=${made.exists.id}). To add to it, use notes_append with that id; to make a second one anyway, only if the user wants that, call notes_create again with again=true.`;
        }
        names.set(made.id, made.name);
        return `Created the note "${made.name}" (id=${made.id}).`;
      },
    },
    {
      name: "notes_append",
      description: "Add text to the end of an existing note, by id.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The note's id from notes_search or notes_create." },
          text: { type: "string", description: "Text to add. Use \\n for new lines." },
        },
        required: ["id", "text"],
      },
      actionClass: "write-local",
      preview: async (a) => {
        const name = names.get(String(a.id ?? ""));
        return name === undefined
          ? t("apps.notes.append", { text: String(a.text ?? "").slice(0, 60) })
          : t("apps.notes.appendTo", { name: name.slice(0, 80), text: String(a.text ?? "").slice(0, 60) });
      },
      async run(a) {
        const note = (await run(NOTES_APPEND, { app: APP, id: text(a.id, "id"), text: text(a.text, "text") })) as { id: string; name: string };
        names.set(note.id, note.name);
        return `Added to the note "${note.name}".`;
      },
    },
    {
      name: "notes_edit",
      description: "Change one passage of a note, by id: the exact text as notes_read showed it, and what to put instead. The rest of the note is kept. The user approves it on a card and can undo it.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The note's id from notes_search." },
          find: { type: "string", description: "The exact text to change; it must appear once in the note." },
          replace: { type: "string", description: "What to put instead. Empty removes it. Use \\n for new lines." },
        },
        required: ["id", "find", "replace"],
      },
      actionClass: "write-local",
      alwaysAsk: true,
      preview: async (a) =>
        t("apps.notes.edit", {
          name: (await about(String(a.id ?? ""))).name.slice(0, 80),
          find: String(a.find ?? "").slice(0, 120),
          replace: String(a.replace ?? "").slice(0, 120),
        }),
      async run(a, ctx: ToolContext) {
        const id = text(a.id, "id");
        const find = String(a.find ?? "");
        if (!find.trim()) throw new Error("find must not be empty. Nothing was changed.");
        const done = (await run(NOTES_EDIT, { app: APP, id, find, replace: String(a.replace ?? "") })) as {
          id?: string; name: string; locked?: boolean; attachments?: boolean; count?: number; plain?: number; before?: string; after?: string;
        };
        if (done.locked) throw new Error(`The note "${done.name}" is locked. Nothing was changed.`);
        if (done.attachments) throw new Error(`The note "${done.name}" has attachments, and changing it from here could lose them. Nothing was changed; the user can edit it in Notes.`);
        if (done.count !== undefined) {
          const why = done.count > 1 ? `appears ${done.count} times; give a longer passage that appears once`
            : done.plain && done.plain > 0 ? "crosses formatting (bold, a link, a list) and can't be changed from here; give a shorter passage inside one line"
            : "is not in the note; read it again with notes_read and copy the text exactly";
          throw new Error(`That text ${why}. Nothing was changed.`);
        }
        names.set(id, done.name);
        ctx.offerUndo(t("apps.notes.undoEdit", { name: done.name }), async () => {
          const back = (await run(NOTES_SET_BODY, { app: APP, id, expect: done.after, body: done.before })) as { changed?: boolean };
          if (back.changed) throw new Error(t("apps.notes.changedSince", { name: done.name }));
        });
        return `Changed the note "${done.name}". The user can undo it from the activity log.`;
      },
    },
    {
      name: "notes_delete",
      description: "Delete one note, by id: it goes to Recently Deleted, where Notes keeps it for 30 days. The user approves it on a card and can put it back.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "The note's id from notes_search." } },
        required: ["id"],
      },
      actionClass: "write-local",
      alwaysAsk: true,
      preview: async (a) => {
        const note = await about(String(a.id ?? ""));
        return t(note.trashed ? "apps.notes.deleteTrashed" : "apps.notes.delete", { name: note.name.slice(0, 80) });
      },
      async run(a, ctx: ToolContext) {
        const id = text(a.id, "id");
        const gone = (await run(NOTES_DELETE, { app: APP, id, trash: RECENTLY_DELETED })) as {
          name: string; inTrash?: boolean; locked?: boolean; from?: string; fromName?: string; where?: string | null;
        };
        if (gone.inTrash) throw new Error(`The note "${gone.name}" is already in Recently Deleted; deleting it again would be for good, and Vunemi doesn't do that. Nothing was changed.`);
        if (gone.locked) throw new Error(`The note "${gone.name}" is locked. Nothing was changed.`);
        // Read back, not assumed: only a note that is still there can come back.
        if (!gone.where) return `Deleted the note "${gone.name}". Notes did not keep it where Vunemi can reach it, so it can't be put back from here; the user can look in Recently Deleted in Notes.`;
        ctx.offerUndo(t("apps.notes.undoDelete", { name: gone.name }), async () => {
          await run(NOTES_RESTORE, { app: APP, id, folder: gone.from });
        });
        return `Moved the note "${gone.name}" to ${gone.where}. The user can put it back from the activity log.`;
      },
    },
  ];
}
