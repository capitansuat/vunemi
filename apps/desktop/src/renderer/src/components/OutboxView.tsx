import { useEffect, useState } from "react";
import type { OutboxEvent, Pending, UncertainSend } from "@ocak/mail";
import { formatDate, t } from "@ocak/i18n";

export function OutboxView() {
  const [pending, setPending] = useState<Pending[]>([]);
  const [uncertain, setUncertain] = useState<UncertainSend[]>([]);
  const [events, setEvents] = useState<OutboxEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => void window.ocak.listOutbox().then((value) => {
      setPending(value.pending);
      setUncertain(value.uncertain);
      setEvents(value.events);
    }).catch((err: unknown) => setError(String(err)));
    refresh();
    return window.ocak.onOutbox(refresh);
  }, []);

  async function cancel(id: string) {
    setError(null);
    try {
      if (!await window.ocak.cancelOutbox(id)) setError(t("outbox.tooLate"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function dismiss(id: string) {
    setError(null);
    try {
      await window.ocak.dismissOutbox(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 py-8">
      <div className="mx-auto max-w-[760px]">
        <h1 className="text-[17px] font-semibold text-fg">{t("app.nav.outbox")}</h1>
        <p className="mt-1 text-[13px] text-muted">{t("outbox.intro")}</p>
        {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
        <h2 className="mt-6 text-[12px] font-medium text-muted">{t("outbox.pending")}</h2>
        {pending.length === 0 ? <p className="mt-2 text-[12.5px] text-faint">{t("outbox.nonePending")}</p> : (
          <ul className="mt-2 space-y-2">{pending.map((item) => (
            <li key={item.id} className="rounded-xl border border-line bg-surface p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[13px] font-medium text-fg">{item.draft.subject}</p>
                  <p className="mt-1 text-[11.5px] text-muted">{item.account} → {item.draft.to.join(", ")}</p>
                  <p className="mt-1 text-[11.5px] text-faint">{t("outbox.scheduled", { time: formatDate(item.at, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) })}</p>
                </div>
                <button type="button" onClick={() => void cancel(item.id)} className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-fg hover:border-line-strong">{t("common.undo")}</button>
              </div>
            </li>
          ))}</ul>
        )}
        {uncertain.length > 0 && (
          <>
            <h2 className="mt-7 text-[12px] font-medium text-danger">{t("outbox.uncertain")}</h2>
            <p className="mt-1 text-[12px] text-muted">{t("outbox.uncertainBody")}</p>
            <ul className="mt-2 space-y-2">{uncertain.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-danger/40 bg-surface p-3">
                <span className="text-[12.5px] text-fg">{item.subject} · {item.account}</span>
                <button type="button" onClick={() => void dismiss(item.id)} className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-fg hover:border-line-strong">{t("outbox.dismiss")}</button>
              </li>
            ))}</ul>
          </>
        )}
        <h2 className="mt-7 text-[12px] font-medium text-muted">{t("outbox.history")}</h2>
        <ul className="mt-2 space-y-1.5">{[...events].reverse().filter((event) => event.kind !== "held").map((event, index) => (
          <li key={`${event.id}-${index}`} className="rounded-lg border border-line bg-surface px-3 py-2 text-[12px] text-fg">
            {t(`outbox.status.${event.kind}`)} · {event.id}{event.kind === "failed" ? ` — ${event.error}` : ""}
          </li>
        ))}</ul>
      </div>
    </div>
  );
}
