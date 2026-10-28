import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import { t } from "@vunemi/i18n";

/** The last task here was cut short by Vunemi closing; picking it up is the user's call. */
export function RecoveryActions({ standalone = false }: { standalone?: boolean }) {
  const { sessions, running, model, setSessions } = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cut = sessions.sessions.find((s) => s.id === sessions.current)?.interrupted;
  useEffect(() => { setBusy(false); setError(null); }, [sessions.current]);
  if (!cut || running) return null;

  // Main acts only when the request names the conversation open now; the
  // handler also checks it here, so a stale click sends nothing at all.
  const owner = sessions.current;
  const current = () => {
    const state = useStore.getState();
    return !state.running && state.sessions.current === owner && Boolean(state.sessions.sessions.find((s) => s.id === owner)?.interrupted);
  };
  let sending = false;
  const act = (fn: () => Promise<unknown>) => {
    if (busy || sending || !current()) return;
    sending = true;
    setBusy(true);
    setError(null);
    fn().catch((e: unknown) => {
      if (useStore.getState().sessions.current !== owner) return;
      setBusy(false);
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
    });
  };
  return (
    <div data-recovery-actions role="status" className={standalone ? "rounded-xl border border-warn-line bg-warn-soft p-3.5" : "border-t border-line px-3.5 py-3"}>
      {standalone && <p className="text-[13.5px] font-medium text-fg">{t("app.recovery.title")}</p>}
      <p className="mt-1.5 text-[12.5px] leading-snug text-muted">
        {t("app.recovery.steps", { count: cut.steps })} {t("app.recovery.body")}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !model}
          onClick={() => act(() => window.vunemi.resumeInterrupted(model!, owner))}
          className="rounded-lg bg-fg px-3.5 py-1.5 text-[13px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {t("app.recovery.resume")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => act(async () => { const next = await window.vunemi.dismissInterrupted(owner); if (useStore.getState().sessions.current !== owner) return; setSessions(next); setBusy(false); })}
          className="rounded-lg px-3.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-50"
        >
          {t("app.recovery.dismiss")}
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
}

