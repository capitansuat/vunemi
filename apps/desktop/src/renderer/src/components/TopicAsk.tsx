/**
 * The question under a run about topics, decided in main. A topic that fits
 * what was asked: "Shall I keep this conversation in …?", once per
 * conversation. A web lookup's temporary topic: keep it, under a name the
 * user can change, or delete it; unanswered, it stays temporary.
 */
import { useState } from "react";
import { BookMarked, Check, Trash2 } from "lucide-react";
import { t } from "@vunemi/i18n";

type Decision = "linked" | "skipped" | "kept" | "deleted";

export function TopicAsk({ runId, ask }: { runId: string; ask: { topic: string; state: "open" | Decision; temporary?: true } }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(ask.topic);
  if (ask.state === "skipped") return null;
  if (ask.state === "linked" || ask.state === "kept") {
    return (
      <p className="flex items-center gap-1.5 text-[11.5px] text-faint">
        <Check size={11} /> {t("topics.ask.linked", { topic: ask.topic })}
      </p>
    );
  }
  if (ask.state === "deleted") {
    return (
      <p className="flex items-center gap-1.5 text-[11.5px] text-faint">
        <Trash2 size={11} /> {t("topics.ask.deleted")}
      </p>
    );
  }
  const answer = (decision: Decision, typed?: string) => {
    setBusy(true);
    setError(null);
    window.vunemi.resolveTopic(runId, decision, ...(typed !== undefined ? [typed] : [])).catch((err: unknown) => {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
      setBusy(false);
    });
  };
  const primary = "flex items-center gap-1.5 rounded-lg bg-fg px-3 py-1.5 text-[12.5px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50";
  const quiet = "rounded-lg px-3 py-1.5 text-[12.5px] text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50";
  return (
    <div className="rounded-xl border border-line-strong bg-surface p-3.5">
      <div className="flex items-center gap-2 text-[13.5px] text-fg">
        <BookMarked size={14} strokeWidth={2.2} className="shrink-0 text-muted" />
        {t(ask.temporary ? "topics.ask.questionTemporary" : "topics.ask.question", { topic: ask.topic })}
      </div>
      <p className="mt-1 text-[12px] text-muted">{t(ask.temporary ? "topics.ask.whyTemporary" : "topics.ask.why")}</p>
      {ask.temporary ? (
        <>
          <label className="mt-2.5 flex items-center gap-2 text-[12px] text-muted">
            {t("topics.ask.name")}
            <input
              type="text"
              value={name}
              disabled={busy}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-line bg-bg px-2 py-1 text-[12.5px] text-fg outline-none focus:border-line-strong"
            />
          </label>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button type="button" disabled={busy || !name.trim()} onClick={() => answer("kept", name.trim())} className={primary}>
              <Check size={12} /> {t("topics.ask.keep")}
            </button>
            <button type="button" disabled={busy} onClick={() => answer("deleted")} className={quiet}>
              {t("topics.ask.delete")}
            </button>
          </div>
        </>
      ) : (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => answer("linked")} className={primary}>
            <Check size={12} /> {t("topics.ask.yes")}
          </button>
          <button type="button" disabled={busy} onClick={() => answer("skipped")} className={quiet}>
            {t("topics.ask.no")}
          </button>
        </div>
      )}
      {error && <p role="alert" className="mt-1.5 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
