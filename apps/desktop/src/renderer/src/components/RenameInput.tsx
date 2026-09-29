import { useState } from "react";

/** A name edited in place: Enter or leaving the field keeps it, Escape leaves it as it was. */
export function RenameInput({ initial, label, onDone, className }: { initial: string; label: string; onDone: (name: string | null) => void; className?: string }) {
  const [value, setValue] = useState(initial);
  const [done, setDone] = useState(false);
  const finish = (name: string | null) => {
    if (done) return;
    setDone(true);
    const kept = name?.trim();
    onDone(kept && kept !== initial ? kept : null);
  };
  return (
    <input
      autoFocus
      aria-label={label}
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(value);
        if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      }}
      className={className ?? "w-full rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px] text-fg outline-none"}
    />
  );
}
