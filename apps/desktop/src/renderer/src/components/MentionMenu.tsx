/**
 * What "@" in the message box offers: earlier conversations and meetings to
 * bring into this message. It only shows and reports a pick; the composer
 * owns the keys, since the text box keeps the focus throughout.
 */

import { MessageSquare, Users } from "lucide-react";
import { formatDate, t } from "@vunemi/i18n";
import type { MentionItem } from "../../../shared/ipc.js";

/** A menu row: the item, under the name the user sees and gets written into the text. */
export interface MenuItem extends MentionItem {
  name: string;
}

export function MentionIcon({ kind, size = 13 }: { kind: MentionItem["kind"]; size?: number }) {
  return kind === "meeting" ? <Users size={size} className="shrink-0" /> : <MessageSquare size={size} className="shrink-0" />;
}

export function MentionMenu({
  items,
  active,
  full,
  onPick,
  onHover,
}: {
  items: MenuItem[];
  active: number;
  /** The message already brings in as many as it may. */
  full: boolean;
  onPick: (item: MenuItem) => void;
  onHover: (index: number) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label={t("composer.mention.label")}
      className="absolute bottom-full left-0 z-20 mb-2 w-[min(420px,100%)] rounded-xl border border-line bg-surface p-1.5 shadow-2xl"
    >
      {full || items.length === 0 ? (
        <p className="px-2.5 py-1.5 text-[12.5px] text-faint">{t(full ? "composer.mention.full" : "composer.mention.none")}</p>
      ) : (
        items.map((item, index) => (
          <div
            key={`${item.kind}:${item.id}`}
            role="option"
            aria-selected={index === active}
            // Mouse down, not click: the text box must not lose the focus.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(item);
            }}
            onMouseEnter={() => onHover(index)}
            className={`flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] ${index === active ? "bg-surface-2 text-fg" : "text-muted"}`}
          >
            <MentionIcon kind={item.kind} />
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            <span className="shrink-0 text-[11px] text-faint">{formatDate(item.at, { day: "numeric", month: "short" })}</span>
          </div>
        ))
      )}
    </div>
  );
}
