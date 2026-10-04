import { useEffect, useState } from "react";
import { getLocale, t } from "@vunemi/i18n";
import type { ModelsMemoryView } from "../../../shared/ipc.js";
import { formatGB } from "../lib/format.js";
import { formatTokens } from "../lib/labels.js";

/** The page asks again this often, and only while it is on screen. */
const REFRESH_MS = 5_000;

/** What Vunemi's local models hold now, and the model manager's last decision. */
export function MemoryInUse() {
  const [view, setView] = useState<ModelsMemoryView | null>(null);
  const locale = getLocale();

  useEffect(() => {
    let live = true;
    const read = () =>
      void window.vunemi
        .modelsMemory()
        .then((v) => {
          if (live) setView(v);
        })
        .catch((err: unknown) => console.error("[vunemi] models memory:", err));
    read();
    const timer = setInterval(read, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  if (!view) return null;
  const size = (bytes: number | null) => (bytes === null ? t("modelsMemory.unmeasured") : formatGB(bytes, locale));
  const time = (at: number) => new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const last = view.last;
  return (
    <section className="my-5">
      <h3 className="text-[13px] font-medium text-fg">{t("modelsMemory.title")}</h3>
      <ul className="mt-2 space-y-1 text-[12.5px] text-muted">
        {view.residents.map((r) => (
          <li key={r.id} className="flex justify-between gap-3">
            <span>{t(`modelsMemory.${r.id}`)}</span>
            <span className="tabular-nums">{r.loaded ? size(r.bytes) : t("modelsMemory.notLoaded")}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11.5px] text-faint">
        {t("modelsMemory.summary", { total: formatGB(view.total, locale), available: size(view.available) })}
      </p>
      {last && (
        <p className="mt-1 text-[11.5px] text-faint">
          {last.kind === "unloaded"
            ? t("modelsMemory.unloaded", { time: time(last.at), names: last.ids.map((id) => t(`modelsMemory.${id}`)).join(", ") })
            : t("modelsMemory.lowered", { time: time(last.at), context: formatTokens(last.context) })}
        </p>
      )}
    </section>
  );
}
