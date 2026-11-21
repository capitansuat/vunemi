/**
 * "Shall I keep this conversation in …?": asked once per conversation, under
 * the answer, when a topic fits what was asked (decided in main). A yes puts
 * the conversation in the topic; a no is remembered so it isn't asked again.
 */
import { useState } from "react";
import { BookMarked, Check } from "lucide-react";
import { t } from "@vunemi/i18n";

export function TopicAsk({ runId, ask }: { runId: string; ask: { topic: string; state: "open" | "linked" | "skipped" } }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (ask.state === "skipped") return null;
  if (ask.state === "linked") {
    return (
      <p className="flex items-center gap-1.5 text-[11.5px] text-faint">
        <Check size={11} /> {t("topics.ask.linked", { topic: ask.topic })}
      </p>
    );
  }
  const answer = (decision: "linked" | "skipped") => {
    setBusy(true);
    setError(null);
    window.vunemi.resolveTopic(runId, decision).catch((err: unknown) => {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
      setBusy(false);
    });
  };
  return (
    <div className="rounded-xl border border-line-strong bg-surface p-3.5">
      <div className="flex items-center gap-2 text-[13.5px] text-fg">
        <BookMarked size={14} strokeWidth={2.2} className="shrink-0 text-muted" />
        {t("topics.ask.question", { topic: ask.topic })}
      </div>
      <p className="mt-1 text-[12px] text-muted">{t("topics.ask.why")}</p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => answer("linked")}
          className="flex items-center gap-1.5 rounded-lg bg-fg px-3 py-1.5 text-[12.5px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50">
          <Check size={12} /> {t("topics.ask.yes")}
        </button>
        <button type="button" disabled={busy} onClick={() => answer("skipped")}
          className="rounded-lg px-3 py-1.5 text-[12.5px] text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50">
          {t("topics.ask.no")}
        </button>
      </div>
      {error && <p role="alert" className="mt-1.5 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
