import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { getLocale, lower, t } from "@vunemi/i18n";
import type { AddonCategory, AddonId, AddonView } from "../../../shared/ipc.js";

type Filter = "all" | "installed" | AddonCategory;

/**
 * Settings › Add-ons: abilities that are a download, laid out as a shelf
 * that can grow: by category, with a search and a filter. Each is a
 * separate program from its developer's release page; nothing is fetched
 * until the user presses Download, and removing one puts it in the Trash.
 * One the user has is updated by itself when Vunemi opens with a newer pin.
 */
export function AddonsSection() {
  const [list, setList] = useState<AddonView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    void window.vunemi.addons().then(setList).catch((err: unknown) => setError(String((err as Error).message ?? err)));
    return window.vunemi.onAddons(setList);
  }, []);

  const act = (run: () => Promise<AddonView[] | void>) => {
    setError(null);
    void run().then((next) => next && setList(next), (err: unknown) => setError(String((err as Error).message ?? err)));
  };

  // In the catalogue's order, which is the order the shelves are shown in.
  const categories = useMemo(() => [...new Set((list ?? []).map((a) => a.category))], [list]);
  const shown = useMemo(() => {
    const words = lower(query.trim()).split(/\s+/).filter(Boolean);
    return (list ?? []).filter((a) => {
      if (filter === "installed" ? a.status.state === "absent" || (a.status.state === "failed" && !a.status.from) : filter !== "all" && a.category !== filter) return false;
      const text = lower([t(`addons.items.${a.id}.title`), t(`addons.items.${a.id}.body`), a.engine, a.publisher].join(" "));
      return words.every((word) => text.includes(word));
    });
  }, [list, query, filter]);

  const card = (addon: AddonView) => (
    <Addon
      key={addon.id}
      addon={addon}
      onInstall={() => act(() => window.vunemi.installAddon(addon.id))}
      onCancel={() => act(() => window.vunemi.cancelAddon(addon.id))}
      onRemove={() => act(() => window.vunemi.removeAddon(addon.id))}
    />
  );
  const chips: { key: Filter; label: string }[] = [
    { key: "all", label: t("addons.all") },
    ...categories.map((c) => ({ key: c as Filter, label: t(`addons.categories.${c}`) })),
    { key: "installed", label: t("addons.ready") },
  ];

  return (
    <div className="mx-auto max-w-[620px]">
      <h2 className="text-[17px] font-semibold text-fg">{t("settings.sections.addons")}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{t("addons.intro")} {t("addons.autoUpdate")}</p>

      <div className="mt-4 flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
        <Search size={14} className="shrink-0 text-faint" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("addons.search")}
          aria-label={t("addons.search")}
          className="w-full bg-transparent text-[13px] text-fg placeholder:text-faint focus:outline-none"
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            aria-pressed={filter === chip.key}
            onClick={() => setFilter(chip.key)}
            className={`rounded-full border px-3 py-1 text-[12.5px] transition-colors ${
              filter === chip.key ? "border-line-strong bg-surface-2 text-fg" : "border-line text-muted hover:border-line-strong hover:text-fg"
            }`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-[12px] text-danger">
          {error}
        </p>
      )}
      {list !== null && shown.length === 0 && <p className="mt-6 text-[13px] text-faint">{t("addons.empty")}</p>}
      {filter === "all"
        ? categories.map((category) => {
            const items = shown.filter((a) => a.category === category);
            if (items.length === 0) return null;
            return (
              <section key={category} aria-labelledby={`addons-${category}`} className="mt-6">
                <h3 id={`addons-${category}`} className="text-[11.5px] font-medium uppercase tracking-wide text-faint">
                  {t(`addons.categories.${category}`)}
                </h3>
                {items.map(card)}
              </section>
            );
          })
        : shown.map(card)}
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
    <article aria-labelledby={`addon-${id}`} className="mt-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h4 id={`addon-${id}`} className="text-[13px] font-medium text-fg">
            {t(`addons.items.${id}.title`)}
            {status.state === "ready" && <span className="ml-2 text-[12px] font-normal text-muted">{t("addons.ready")}</span>}
          </h4>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">{t(`addons.items.${id}.body`)}</p>
          <p className="mt-1 text-[11.5px] text-muted">
            <a href={addon.source} target="_blank" rel="noreferrer" className="hover:text-fg hover:underline">
              {t("addons.from", { engine: addon.engine, version: addon.version, publisher: addon.publisher, licence: addon.licence, size })}
            </a>
          </p>
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
          <span className="text-[12px] text-muted">{t(status.from ? "addons.updating" : "addons.downloading", { percent })}</span>
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
      {status.state === "failed" && status.from && <p className="mt-1 text-[12px] text-muted">{t("addons.updateLater")}</p>}
    </article>
  );
}
