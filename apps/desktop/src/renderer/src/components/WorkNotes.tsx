import { useEffect, useState } from "react";
import { NotebookPen, Trash2 } from "lucide-react";
import { formatDate, t } from "@vunemi/i18n";
import type { WorkNoteView } from "../../../shared/ipc.js";
import type { RunView } from "../lib/fold.js";
import { useStore } from "../store.js";

/** "Note saved: …" under a run. A conversation's own notes can be deleted here; a project's, in its notes view. */
export function SavedNotes({ notes }: { notes: NonNullable<RunView["notes"]> }) {
  const conversationId = useStore((s) => s.sessions.current);
  const [gone, setGone] = useState<Set<string>>(new Set());
  return (
    <div className="mt-2 space-y-1 text-[11.5px] text-faint">
      {notes.filter((n) => !gone.has(n.id)).map((note) => (
        <div key={note.id} className="flex items-center gap-1.5">
          <NotebookPen size={11} />
          <span className="min-w-0 truncate">{t("workNotes.saved", { title: note.title })}</span>
          {note.scope === "conversation" && (
            <button
              type="button"
              aria-label={t("workNotes.delete")}
              title={t("workNotes.delete")}
              className="rounded p-0.5 hover:text-muted"
              onClick={() => void window.vunemi
                .deleteWorkNote(note.id, { conversationId })
                .then(() => setGone((g) => new Set([...g, note.id])))
                .catch((err: unknown) => console.error("[vunemi] work notes:", err))}
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** A project's notes: newest first, each with its day and a delete. */
export function ProjectNotesView() {
  const projectId = useStore((s) => s.notesProject);
  const project = useStore((s) => s.sessions.projects.find((p) => p.id === s.notesProject));
  const [notes, setNotes] = useState<WorkNoteView[]>([]);
  useEffect(() => {
    // Another project's notes must not show while this one's load, nor arrive late over them.
    setNotes([]);
    if (!projectId) return;
    let cancelled = false;
    window.vunemi
      .listWorkNotes({ projectId })
      .then((list) => {
        if (!cancelled) setNotes(list);
      })
      .catch((err: unknown) => console.error("[vunemi] work notes:", err));
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  if (!projectId || !project) return null;
  return (
    <div className="mx-auto w-full max-w-[760px] flex-1 overflow-y-auto px-6 py-6">
      <h1 className="mb-4 text-[15px] font-semibold">{t("workNotes.title", { name: project.name })}</h1>
      {notes.length === 0 && <p className="text-[13px] text-muted">{t("workNotes.empty")}</p>}
      <ul className="space-y-3">
        {notes.map((note) => (
          <li key={note.id} className="rounded-md border border-line p-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{note.title}</div>
                <div className="text-[11.5px] text-faint">{formatDate(note.updatedAt, { dateStyle: "medium" })}</div>
              </div>
              <button
                type="button"
                aria-label={t("workNotes.delete")}
                title={t("workNotes.delete")}
                className="rounded p-1 text-faint hover:bg-surface-2 hover:text-fg"
                onClick={() =>
                  void window.vunemi
                    .deleteWorkNote(note.id, { projectId })
                    .then(setNotes)
                    .catch((err: unknown) => console.error("[vunemi] work notes:", err))
                }
              >
                <Trash2 size={13} />
              </button>
            </div>
            <p className="selectable mt-2 whitespace-pre-wrap text-[12.5px] text-muted">{note.text}</p>
            {note.sources.length > 0 && <p className="mt-2 text-[11.5px] text-warn">{t("workNotes.outside", { sources: note.sources.join(", ") })}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
