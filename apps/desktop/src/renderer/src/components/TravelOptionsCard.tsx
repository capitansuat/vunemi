import { useState } from "react";
import { ExternalLink, Plane, BedDouble } from "lucide-react";
import { getLocale } from "@vunemi/i18n";
import { useStore } from "../store.js";
import type { CallView } from "../lib/fold.js";
import { parseTravelOptions, travelSelectionMessage } from "../lib/travel-options.js";

export function TravelOptionsCard({ call }: { call: CallView }) {
  const results = parseTravelOptions(call);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!results) return null;
  const tr = getLocale() === "tr";
  const flight = results.source === "fli";
  const SourceIcon = flight ? Plane : BedDouble;
  const openSite = async (url: string) => {
    setError("");
    try {
      await window.vunemi.embeddedOpen(url);
      const store = useStore.getState();
      store.showPicture(null);
      if (store.preview) store.closePreview();
      store.setView("chat");
      store.setPaneOpen(true);
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; }
  };
  const choose = async (index: number) => {
    setBusy(true); setError("");
    try {
      const pageOpened = await openSite(results.options[index]!.url);
      await useStore.getState().send(travelSelectionMessage(results, index, tr, pageOpened));
      setSelected(index);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <div className="border-t border-line px-3 py-3">
    <div className="mb-2 flex items-center gap-2 text-[12px] text-muted">
      <SourceIcon size={14} /><span>{flight ? "Fli · Google Flights" : "Trivago"}</span>
      <span className="text-faint">· {results.resultCount > results.options.length
        ? (tr ? `${results.resultCount} sonuçtan ilk ${results.options.length}` : `First ${results.options.length} of ${results.resultCount} results`)
        : (tr ? `${results.options.length} seçenek` : `${results.options.length} options`)}</span>
      {results.searchedAt && <time className="ml-auto text-faint" dateTime={results.searchedAt}>{new Date(results.searchedAt).toLocaleTimeString(tr ? "tr-TR" : "en-GB", { hour: "2-digit", minute: "2-digit" })}</time>}
    </div>
    {results.summary && <p className="mb-2 text-[12px] text-muted">{results.summary}</p>}
    {results.options.length ? <div className="grid gap-2 sm:grid-cols-2">
      {results.options.map((option, index) => <div key={`${option.url}-${index}`} className="overflow-hidden rounded-xl border border-line-strong bg-surface-2 p-3">
        {option.image && <img src={option.image} alt="" loading="lazy" className="mb-2 h-28 w-full rounded-lg object-cover" />}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 text-[13px] font-medium text-fg">{index + 1}. {option.title}</div>
          <div className="shrink-0 text-[14px] font-semibold text-fg">{option.price}</div>
        </div>
        {option.detail && <p className="mt-1 text-[12px] leading-snug text-muted">{option.detail}</p>}
        {option.extra && <p className="mt-1 text-[12px] leading-snug text-muted">{option.extra}</p>}
        <div className="mt-3 flex items-center gap-2">
          <button type="button" disabled={busy || selected !== null} onClick={() => void choose(index)} className="rounded-lg bg-fg px-3 py-1.5 text-[12px] font-medium text-bg disabled:opacity-50">{selected === index ? (tr ? "Seçildi" : "Selected") : (tr ? "Seç" : "Choose")}</button>
          <button type="button" onClick={() => void openSite(option.url)} className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-[12px] text-fg hover:bg-surface"><ExternalLink size={12} />{tr ? "Teklifi aç" : "Open offer"}</button>
        </div>
      </div>)}
    </div> : <p className="text-[12px] text-muted">{tr ? "Gösterilecek seçenek bulunamadı." : "No options to show."}</p>}
    {results.searchUrl && <button type="button" onClick={() => void openSite(results.searchUrl!)} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface-2 px-3 py-2 text-[12px] font-medium text-fg hover:bg-surface"><ExternalLink size={13} />{tr ? "Sitede daha fazlasını gör" : "See more on the site"}</button>}
    {results.warning && <p className="mt-2 text-[11px] text-faint">{results.warning}</p>}
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
  </div>;
}
