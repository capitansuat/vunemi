import { useEffect, useLayoutEffect, useRef } from "react";
import { WifiOff, X } from "lucide-react";
import { useStore } from "../store.js";
import { t } from "@vunemi/i18n";

/**
 * A page Vunemi made, beside the chat. The page is a native view main lays
 * over the stage, in a session with no internet; this draws the frame.
 */
export function SitePane() {
  const preview = useStore((s) => s.preview);
  const close = useStore((s) => s.closePreview);
  const stage = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      window.vunemi.previewBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener("resize", report);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", report);
      window.vunemi.previewBounds(null);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  if (!preview) return null;
  return (
    <aside className="flex w-[46%] min-w-[420px] max-w-[820px] shrink-0 flex-col border-l border-line bg-surface">
      <div className="drag flex h-[52px] shrink-0 items-center gap-2 px-3">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{preview.title}</span>
        <span className="flex items-center gap-1 text-[11.5px] text-faint" title={t("artefacts.previewNote")}>
          <WifiOff size={12} /> {t("artefacts.offline")}
        </span>
        <button type="button" onClick={close} aria-label={t("pane.close")} className="no-drag rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg">
          <X size={15} />
        </button>
      </div>
      <div ref={stage} className="min-h-0 flex-1 bg-white" />
    </aside>
  );
}
