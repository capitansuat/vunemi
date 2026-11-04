import { Info } from "lucide-react";

/** Says plainly that a feature is not on this system yet, where it would otherwise be. */
export function NotOnThisSystem({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div role="note" className="mt-3 flex items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2.5 text-[12.5px] text-muted">
      <Info size={14} className="mt-0.5 shrink-0" />
      <span>
        {text}
        {children}
      </span>
    </div>
  );
}
