/**
 * The messages waiting their turn, shown just above the composer.
 *
 * They sit where the user typed them rather than in the transcript, because
 * they haven't happened yet: the transcript is a record of what the agent
 * did, and a queued message is still only an intention. Each one can be taken
 * back, or can interrupt: an emergency or a correction shouldn't wait for
 * the task it is correcting to finish.
 */

import { Zap, X } from "lucide-react";
import { useStore } from "../store.js";
import { t } from "@vunemi/i18n";

export function Queue() {
  const queue = useStore((s) => s.queue);
  const dropQueued = useStore((s) => s.dropQueued);
  const interrupt = useStore((s) => s.interruptQueued);

  if (queue.length === 0) return null;

  return (
    <ul className="mb-2 space-y-1.5">
      {queue.map((message, index) => (
        <li
          key={message.id}
          className="flex items-center gap-2 rounded-xl border border-dashed border-line bg-surface-2/60 px-3 py-2"
        >
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-3 text-[10px] font-medium text-muted tabular-nums">
            {index + 1}
          </span>
          <p className="selectable min-w-0 flex-1 truncate text-[13px] text-fg" title={message.text}>
            {message.text}
          </p>
          <span className="shrink-0 text-[11px] text-faint">{t("queue.waiting")}</span>
          <button
            type="button"
            onClick={() => void interrupt(message.id)}
            title={t("queue.interruptHint")}
            className="flex shrink-0 items-center gap-1 rounded-full border border-ember/40 bg-ember-soft px-2.5 py-1 text-[11.5px] font-medium text-ember transition-colors hover:bg-ember/15"
          >
            <Zap size={12} />
            {t("queue.interrupt")}
          </button>
          <button
            type="button"
            onClick={() => void dropQueued(message.id)}
            aria-label={t("queue.remove")}
            title={t("queue.remove")}
            className="grid size-6 shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-surface-3 hover:text-fg"
          >
            <X size={13} />
          </button>
        </li>
      ))}
    </ul>
  );
}
