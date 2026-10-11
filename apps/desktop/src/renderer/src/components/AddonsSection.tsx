import { useEffect, useState } from "react";
import { getLocale, t } from "@vunemi/i18n";
import type { AddonId, AddonView } from "../../../shared/ipc.js";

/**
 * Settings › Add-ons: abilities that are a download. Each is a separate
 * program from its developer's release page; nothing is fetched until the
 * user presses Download, and removing one puts it in the Trash.
 */
export function AddonsSection() {
  const [list, setList] = useState<AddonView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.vunemi.addons().then(setList).catch((err: unknown) => setError(String((err as Error).message ?? err)));
    return window.vunemi.onAddons(setList);
  }, []);

  const act = (run: () => Promise<AddonView[] | void>) => {
    setError(null);
    void run().then((next) => next && setList(next), (err: unknown) => setError(String((err as Error).message ?? err)));
  };

  return (
    <div className="mx-auto max-w-[620px]">
      <h2 className="text-[17px] font-semibold text-fg">{t("settings.sections.addons")}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{t("addons.intro")}</p>
      {list?.map((addon) => (
        <Addon
          key={addon.id}
          addon={addon}
          onInstall={() => act(() => window.vunemi.installAddon(addon.id))}
          onCancel={() => act(() => window.vunemi.cancelAddon(addon.id))}
          onRemove={() => act(() => window.vunemi.removeAddon(addon.id))}
        />
      ))}
      {error && (
        <p role="alert" className="mt-3 text-[12px] text-danger">
          {error}
        </p>
      )}
      <p className="mt-6 text-[12px] leading-relaxed text-muted">{t("addons.credit")}</p>
    </div>
  );
}

function Addon({ addon, onInstall, onCancel, onRemove }: { addon: AddonView; onInstall(): void; onCancel(): void; onRemove(): void }) {
  const { status } = addon;
  const id: AddonId = addon.id;
  const size = new Intl.NumberFormat(getLocale(), { style: "unit", unit: "megabyte", maximumFractionDigits: 0 }).format(addon.bytes / 1e6);
  const percent = status.state === "downloading" ? Math.min(100, Math.round((status.received / addon.bytes) * 100)) : 0;
  const quiet = "rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-fg hover:bg-surface-2";

  return (
    <section aria-labelledby={`addon-${id}`} className="mt-4 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id={`addon-${id}`} className="text-[13px] font-medium text-fg">
            {t(`addons.items.${id}.title`)}
            {status.state === "ready" && <span className="ml-2 text-[12px] font-normal text-muted">{t("addons.ready")}</span>}
          </h3>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">{t(`addons.items.${id}.body`)}</p>
          <p className="mt-1 text-[11.5px] text-muted">{t("addons.from", { engine: addon.engine, version: addon.version, size })}</p>
        </div>
        {(status.state === "absent" || status.state === "failed" || status.state === "outdated") && (
          <button type="button" onClick={onInstall} className="shrink-0 rounded-lg bg-fg px-3.5 py-1.5 text-[12.5px] font-medium text-bg">
            {status.state === "absent" ? t("addons.get") : status.state === "outdated" ? t("addons.update") : t("addons.retry")}
          </button>
        )}
        {(status.state === "ready" || status.state === "outdated") && (
          <button type="button" onClick={onRemove} className={`shrink-0 ${quiet}`}>
            {t("addons.remove")}
          </button>
        )}
      </div>
      {status.state === "downloading" && (
        <div className="mt-3 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full bg-ember" style={{ width: `${percent}%` }} />
          </div>
          <span className="text-[12px] text-muted">{t("addons.downloading", { percent })}</span>
          <button type="button" onClick={onCancel} className="text-[12px] text-muted hover:text-fg">
            {t("addons.cancel")}
          </button>
        </div>
      )}
      {status.state === "installing" && <p className="mt-3 text-[12px] text-muted">{t("addons.installing")}</p>}
      {status.state === "outdated" && <p className="mt-2 text-[12px] text-muted">{t("addons.outdated", { version: status.version })}</p>}
      {status.state === "failed" && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {t(`addons.failed.${status.reason}`)}
        </p>
      )}
    </section>
  );
}
