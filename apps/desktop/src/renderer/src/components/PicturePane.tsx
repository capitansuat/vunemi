import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useStore } from "../store.js";
import { t } from "@ocak/i18n";

/** A picture from a call card, large, beside the chat. Esc or the cross closes it. */
export function PicturePane() {
  const viewer = useStore((s) => s.viewer);
  const close = useStore((s) => s.showPicture);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!viewer) return;
    let live = true;
    setSrc(null);
    setFailed(false);
    void window.ocak
      .readImage(viewer.path)
      .then((url) => live && setSrc(url))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [viewer?.path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  if (!viewer) return null;
  return (
    <aside className="flex w-[46%] min-w-[360px] max-w-[820px] shrink-0 flex-col border-l border-line bg-surface">
      <div className="drag flex h-[52px] shrink-0 items-center gap-2 px-3">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">{viewer.label ?? t("call.picture")}</span>
        <button
          type="button"
          onClick={() => close(null)}
          aria-label={t("pane.close")}
          className="no-drag rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg"
        >
          <X size={15} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {failed ? (
          <p className="text-[12.5px] text-faint">{t("call.pictureGone")}</p>
        ) : src ? (
          <img src={src} alt={viewer.label ?? ""} className="max-h-full max-w-full rounded-lg object-contain shadow-lg" />
        ) : (
          <div className="size-40 animate-pulse rounded-lg bg-surface-3" />
        )}
      </div>
    </aside>
  );
}
