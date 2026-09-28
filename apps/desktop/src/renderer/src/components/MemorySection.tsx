import { useEffect, useState } from "react";
import { getLocale, t } from "@vunemi/i18n";
import type { MemoryNoteView, MemorySearchStatus } from "../../../shared/ipc.js";

/** Settings › Memory: every note with the words it came from, and search by meaning. */
export function MemorySection() {
  const [notes, setNotes] = useState<MemoryNoteView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);

  useEffect(() => {
    void window.vunemi.listMemory().then(setNotes).catch((err: unknown) => setError(message(err)));
  }, []);

  async function act(work: () => Promise<MemoryNoteView[]>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      setNotes(await work());
      return true;
    } catch (err) {
      setError(message(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const groups = (["general", "topic"] as const).map((kind) => ({ kind, notes: notes.filter((n) => n.kind === kind) }));

  return (
    <div className="mx-auto max-w-[620px]">
      <h2 className="text-[17px] font-semibold text-fg">{t("memory.title")}</h2>
      <p className="mt-1 text-[13px] text-muted">{t("memory.description")}</p>
      <MeaningSearch />
      {notes.length === 0 ? (
        <p className="mt-6 text-[12.5px] text-muted">{t("memory.empty")}</p>
      ) : (
        groups.filter((g) => g.notes.length > 0).map((g) => (
          <section key={g.kind} className="mt-6">
            <h3 className="text-[12px] font-medium uppercase tracking-wide text-faint">{t(g.kind === "general" ? "memory.kind.general" : "memory.kind.topic")}</h3>
            <ul className="mt-2 divide-y divide-line rounded-xl border border-line bg-surface">
              {g.notes.map((note) => (
                <NoteRow key={note.id} note={note} busy={busy}
                  onSave={(text) => act(() => window.vunemi.updateMemory(note.id, text))}
                  onDelete={() => void act(() => window.vunemi.deleteMemory(note.id))} />
              ))}
            </ul>
          </section>
        ))
      )}
      {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
      {notes.length > 0 && (
        <div className="mt-8">
          {confirmForget ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] text-muted">{t("memory.forgetConfirm")}</span>
              <button type="button" disabled={busy} onClick={() => void act(() => window.vunemi.forgetMemory()).then(() => setConfirmForget(false))}
                className="rounded-lg bg-danger px-3 py-2 text-[12px] text-white disabled:opacity-50">{t("memory.forget")}</button>
              <button type="button" onClick={() => setConfirmForget(false)} className="px-2 text-[12px] text-muted">{t("memory.cancel")}</button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmForget(true)} className="rounded-lg border border-danger/40 px-3 py-2 text-[12px] text-danger">{t("memory.forget")}…</button>
          )}
        </div>
      )}
    </div>
  );
}

function NoteRow({ note, busy, onSave, onDelete }: {
  note: MemoryNoteView;
  busy: boolean;
  onSave: (text: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.text);
  const date = (at: number) => new Date(at).toLocaleDateString(getLocale());

  return (
    <li className="px-3.5 py-3 text-[12.5px]">
      {editing ? (
        <form className="flex flex-col gap-2" onSubmit={(e) => {
          e.preventDefault();
          void onSave(draft).then((ok) => ok && setEditing(false));
        }}>
          <input autoFocus value={draft} maxLength={300} onChange={(e) => setDraft(e.target.value)} aria-label={t("memory.edit")}
            className="selectable w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[13px] text-fg focus:border-ember focus:outline-none" />
          <div className="flex gap-2">
            <button type="submit" disabled={busy || !draft.trim()} className="rounded-lg bg-fg px-3 py-1.5 text-[12px] font-medium text-bg disabled:opacity-50">{t("memory.save")}</button>
            <button type="button" onClick={() => { setDraft(note.text); setEditing(false); }} className="px-2 text-[12px] text-muted">{t("memory.cancel")}</button>
          </div>
        </form>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <span className="selectable min-w-0 break-words text-[13px] text-fg">{note.text}</span>
          <span className="flex shrink-0 gap-3">
            <button type="button" disabled={busy} onClick={() => setEditing(true)} className="text-muted hover:text-fg disabled:opacity-50">{t("memory.edit")}</button>
            <button type="button" disabled={busy} onClick={onDelete} aria-label={t("memory.removeLabel", { text: note.text })}
              className="text-danger disabled:opacity-50">{t("common.delete")}</button>
          </span>
        </div>
      )}
      <ul className="mt-1.5 space-y-0.5">
        {note.evidence.map((e, i) => (
          <li key={i} className="text-[11.5px] text-faint">
            {e.sessionId === null && e.quote === note.text && note.evidence.length === 1
              ? `${t("memory.fromPreferences")} · ${date(e.at)}`
              : `${t("memory.evidence")}: “${e.quote}” · ${date(e.at)}`}
          </li>
        ))}
      </ul>
    </li>
  );
}

/** The meaning model: a one-time download the user asks for. */
function MeaningSearch() {
  const [status, setStatus] = useState<MemorySearchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.vunemi.memorySearch().then(setStatus).catch(() => {});
    return window.vunemi.onMemorySearch(setStatus);
  }, []);

  if (!status || status.state === "unavailable") return null;
  const size = new Intl.NumberFormat(getLocale(), { style: "unit", unit: "megabyte", maximumFractionDigits: 0 }).format(
    status.bytes / 1e6,
  );

  return (
    <section className="mt-5 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-medium text-fg">{t("memory.search.title")}</h3>
        {status.state === "ready" && <span className="text-[12px] text-muted">{t("memory.search.ready")}</span>}
      </div>
      <p className="mt-1 text-[12px] text-muted">{t("memory.search.body", { size })}</p>
      {status.state === "absent" && (
        <button type="button" onClick={() => {
          setError(null);
          void window.vunemi.memorySearchDownload().then(setStatus).catch((err: unknown) => setError(message(err)));
        }} className="mt-3 rounded-lg bg-fg px-3.5 py-1.5 text-[12.5px] font-medium text-bg">{t("memory.search.download")}</button>
      )}
      {status.state === "downloading" && (
        <div className="mt-3 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full bg-ember" style={{ width: `${Math.round((status.received / status.bytes) * 100)}%` }} />
          </div>
          <span className="text-[12px] text-muted">{t("memory.search.downloading", { percent: Math.round((status.received / status.bytes) * 100) })}</span>
          <button type="button" onClick={() => void window.vunemi.memorySearchCancel()} className="text-[12px] text-muted hover:text-fg">{t("memory.search.cancel")}</button>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{t("memory.search.failed", { error })}</p>}
    </section>
  );
}

function message(err: unknown): string {
  // Electron prefixes errors from main with where they came from.
  return (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
