import { useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { t } from "@vunemi/i18n";
import type { LockState } from "../../../shared/ipc.js";

/**
 * What a locked Vunemi shows: one button, and macOS does the asking. Opaque,
 * so nothing of the conversation shows through; the agent's page, a native
 * view above this, is hidden by main.
 */
export function LockScreen({ away, onState }: { away: boolean; onState: (state: LockState) => void }) {
  const [asking, setAsking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const asked = useRef(false);

  async function unlock() {
    setAsking(true);
    setMessage(null);
    try {
      const attempt = await window.vunemi.unlock();
      if (!attempt.ok) setMessage(attempt.message);
      onState(attempt.state);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  }

  // Ask once by itself, but only with someone looking: a prompt raised at an
  // empty desk, or behind the Mac's own lock screen, just times out and
  // greets them with an error. Locked with the Mac, the window still has
  // focus, so it waits for the Mac to open first.
  useEffect(() => {
    if (away) return;
    const askOnce = () => {
      if (asked.current) return;
      asked.current = true;
      void unlock();
    };
    if (document.hasFocus()) askOnce();
    window.addEventListener("focus", askOnce);
    return () => window.removeEventListener("focus", askOnce);
  }, [away]);

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="lock-title" className="drag fixed inset-0 z-[100] flex flex-col items-center justify-center bg-bg px-6 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-surface-2">
        <Lock size={24} className="text-ember" />
      </div>
      <h1 id="lock-title" className="mt-5 text-[19px] font-semibold text-fg">{t("lock.title")}</h1>
      <p className="mt-1.5 max-w-[340px] text-[13px] text-muted">{t("lock.body")}</p>
      <button type="button" autoFocus disabled={asking} onClick={() => void unlock()}
        className="no-drag mt-6 rounded-lg bg-ember px-5 py-2 text-[13px] font-medium text-white disabled:opacity-60">
        {asking ? t("lock.asking") : t("lock.unlock")}
      </button>
      {message && <p role="alert" className="mt-3 max-w-[360px] text-[12px] text-danger">{message}</p>}
      <p className="mt-10 text-[11.5px] text-faint">{t("lock.stopHint", { keys: "⌘⇧⎋" })}</p>
    </div>
  );
}
