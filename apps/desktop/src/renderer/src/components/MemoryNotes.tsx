import { useState } from "react";
import { BookmarkPlus, Check, ChevronRight, Pencil } from "lucide-react";
import { t } from "@vunemi/i18n";
import type { MemoryNote } from "@vunemi/agent-core";
import type { MemoryView } from "../lib/fold.js";
import { useStore } from "../store.js";

/** "N notes from memory" under an answer: what the model was given, never a claim it used them. */
export function MemoryNotice({ notes }: { notes: MemoryNote[] }) {
  const [open, setOpen] = useState(false);
  const openSettings = useStore((s) => s.openSettings);
  return (
    <div className="mt-2 text-[11.5px] text-faint">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex items-center gap-1 hover:text-muted">
        <ChevronRight size={11} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        {t("memory.given", { count: notes.length })}
      </button>
      {open && (
        <div className="mt-1.5 rounded-md bg-surface-2 p-2.5">
          <ul className="space-y-1">
            {notes.map((note) => <li key={note.id} className="selectable text-[12px] text-muted">{note.text}</li>)}
          </ul>
          <button type="button" onClick={() => openSettings("memory")} className="mt-2 underline decoration-dotted hover:text-muted">
            {t("memory.manage")}
          </button>
        </div>
      )}
    </div>
  );
}

type Proposal = MemoryView["proposals"][number];

/** "Remember these?": nothing is written until the user says so. */
export function MemoryProposals({ runId, proposals }: { runId: string; proposals: Proposal[] }) {
  const open = proposals.filter((p) => p.state === "open");
  const saved = proposals.filter((p) => p.state === "saved");
  return (
    <div className="space-y-2">
      {open.length > 0 && (
        <div className="rounded-xl border border-line-strong bg-surface p-3.5">
          <div className="flex items-center gap-2 text-[12px] font-medium text-muted">
            <BookmarkPlus size={14} strokeWidth={2.2} />
            {t("memory.proposals.title")}
          </div>
          <ul className="mt-2.5 space-y-3">
            {open.map((p) => <ProposalRow key={p.id} runId={runId} proposal={p} />)}
          </ul>
        </div>
      )}
      {saved.map((p) => (
        <p key={p.id} className="flex items-center gap-1.5 text-[11.5px] text-faint">
          <Check size={11} /> {t("memory.proposals.saved")}: {p.text}
        </p>
      ))}
    </div>
  );
}

function ProposalRow({ runId, proposal }: { runId: string; proposal: Proposal }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(proposal.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = (decision: "saved" | "skipped") => {
    setBusy(true);
    setError(null);
    const text = editing && decision === "saved" ? draft : undefined;
    window.vunemi.resolveMemory(runId, proposal.id, decision, text).catch((err: unknown) => {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
      setBusy(false);
    });
  };

  return (
    <li>
      {editing ? (
        <input autoFocus value={draft} maxLength={300} onChange={(e) => setDraft(e.target.value)} aria-label={t("memory.proposals.edit")}
          className="selectable w-full rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[13.5px] text-fg focus:border-ember focus:outline-none" />
      ) : (
        <p className="selectable text-[13.5px] text-fg">{proposal.text}</p>
      )}
      {proposal.updates && <p className="mt-0.5 text-[12px] text-muted line-through">{proposal.updates.text}</p>}
      <p className="mt-0.5 text-[11.5px] text-faint">
        {t(proposal.kind === "general" ? "memory.kind.general" : "memory.kind.topic")} · {t("memory.evidence")}: “{proposal.quote}”
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy || (editing && !draft.trim())} onClick={() => answer("saved")}
          className="flex items-center gap-1.5 rounded-lg bg-fg px-3 py-1.5 text-[12.5px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50">
          <Check size={12} /> {t("memory.proposals.remember")}
        </button>
        {!editing && (
          <button type="button" disabled={busy} onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-[12.5px] text-fg hover:bg-surface-2 disabled:opacity-50">
            <Pencil size={11} /> {t("memory.proposals.edit")}
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => answer("skipped")}
          className="rounded-lg px-3 py-1.5 text-[12.5px] text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50">
          {t("memory.proposals.skip")}
        </button>
      </div>
      {error && <p role="alert" className="mt-1.5 text-[12px] text-danger">{error}</p>}
    </li>
  );
}
