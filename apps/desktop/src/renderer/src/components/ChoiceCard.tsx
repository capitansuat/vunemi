import { useState } from "react";
import { Check, ExternalLink, MapPin, TriangleAlert } from "lucide-react";
import { t } from "@vunemi/i18n";
import type { OptionCard, VerifiedFact } from "@vunemi/agent-core";
import type { ChoiceView } from "../lib/fold.js";
import { useStore } from "../store.js";

/** All content is React text. A card never interprets model output as markup. */
export function ChoiceCard({ choice }: { choice: ChoiceView }) {
  const [busy, setBusy] = useState(false);
  const [compared, setCompared] = useState<number[]>([]);
  const [error, setError] = useState("");
  const setPaneOpen = useStore((s) => s.setPaneOpen);
  const live = choice.status === "awaiting";

  const answer = (index: number) => {
    if (!live || busy) return;
    setBusy(true);
    setError("");
    void window.vunemi.resolveChoice(choice.runId, choice.callId, { text: "", index }).then((ok) => {
      if (!ok) setBusy(false);
    }).catch((e: unknown) => {
      setError(String(e));
      setBusy(false);
    });
  };
  const openSource = (url: string) => {
    setError("");
    void window.vunemi.openChoiceSource(url).then(() => setPaneOpen(true)).catch((e: unknown) => setError(String(e)));
  };

  if (choice.card.kind === "choice") return (
    <div className="rounded-xl border border-line bg-surface p-3.5">
      <p className="text-[13px] font-medium text-fg">{choice.card.question}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {choice.card.options.map((option, index) => (
          <button key={index} type="button" disabled={!live || busy} onClick={() => answer(index)}
            className="rounded-lg border border-line-strong bg-surface-2 px-3 py-1.5 text-[13px] text-fg hover:border-ember hover:bg-ember/10 disabled:cursor-default disabled:opacity-60">
            {option}
          </button>
        ))}
      </div>
      {live && choice.card.allowOther && <p className="mt-2 text-[11.5px] text-muted">{t("choice.typeInstead")}</p>}
      <ChoiceState choice={choice} />
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  );

  const items = choice.card.items;
  const labels = [...new Set(compared.flatMap((i) => items[i]?.facts.map((fact) => fact.label) ?? []))];
  const compare = (index: number) => setCompared((current) => current.includes(index) ? current.filter((i) => i !== index) : [...current, index]);
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5">
      {choice.card.intro && <p className="mb-3 text-[13px] text-fg">{choice.card.intro}</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {items.map((item, index) => (
          <div key={index} className="flex min-w-0 flex-col rounded-xl border border-line bg-surface-2 p-3">
            <div className="flex items-start justify-between gap-2">
              <h3 className="min-w-0 break-words text-[13.5px] font-semibold text-fg">{item.title}</h3>
              {item.price && <span className="shrink-0 text-[13px] font-medium text-ember">{item.price.value}</span>}
            </div>
            {item.price && <FactMark fact={item.price} />}
            <dl className="mt-2 space-y-1.5">
              {item.facts.map((fact, factIndex) => <div key={factIndex} className="flex items-start justify-between gap-3 text-[12px]">
                <dt className="min-w-0 text-muted">{fact.label}</dt>
                <dd className="min-w-0 break-words text-right text-fg">{fact.value}<FactMark fact={fact} /></dd>
              </div>)}
            </dl>
            {item.view && <p className="mt-2 border-t border-line pt-2 text-[12px] text-muted"><span className="font-medium text-fg">{t("choice.view")}: </span>{item.view}</p>}
            {item.facts.every((fact) => fact.status === "unverified") && (!item.price || item.price.status === "unverified") &&
              <p className="mt-2 flex items-center gap-1 text-[11px] text-warn"><TriangleAlert size={12} />{t("choice.noMatches")}</p>}
            <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
              {item.sourceUrl ? <button type="button" onClick={() => openSource(item.sourceUrl!)} className="inline-flex items-center gap-1 text-[12px] text-ember hover:underline"><ExternalLink size={12} />{t("choice.source")}</button>
                : <span className="text-[11px] text-faint">{t("choice.noSource")}</span>}
              <label className="ml-auto inline-flex items-center gap-1 text-[12px] text-muted">
                <input type="checkbox" checked={compared.includes(index)} onChange={() => compare(index)} className="accent-ember" />{t("choice.compare")}
              </label>
              <button type="button" disabled={!live || busy} onClick={() => answer(index)}
                className="rounded-lg bg-ember px-2.5 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:cursor-default disabled:opacity-50">{t("choice.choose")}</button>
            </div>
          </div>
        ))}
      </div>
      {compared.length > 1 && <Comparison items={items} indices={compared} labels={labels} />}
      <ChoiceState choice={choice} />
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </div>
  );
}

function FactMark({ fact, compact = false }: { fact: VerifiedFact; compact?: boolean }) {
  const icon = fact.status === "page" ? <Check size={11} /> : fact.status === "local" ? <MapPin size={11} /> : <span className="font-bold">?</span>;
  const label = t(fact.status === "page" ? "choice.pageMatch" : fact.status === "local" ? "choice.localMatch" : "choice.notFound");
  return <span title={label} aria-label={label} className={`ml-1 inline-flex items-center gap-0.5 align-middle text-[10.5px] ${fact.status === "unverified" ? "text-warn" : "text-ok"}`}>{icon}{fact.status === "unverified" && !compact ? <span>{label}</span> : <span className="sr-only">{label}</span>}</span>;
}

function Comparison({ items, indices, labels }: { items: OptionCard[]; indices: number[]; labels: string[] }) {
  return <div className="scroll-thin mt-3 overflow-x-auto rounded-lg border border-line">
    <table className="w-full min-w-[420px] border-collapse text-[12px]">
      <thead className="bg-surface-2"><tr><th className="px-2 py-1.5 text-left">{t("choice.compare")}</th>{indices.map((i) => <th key={i} className="px-2 py-1.5 text-left">{items[i]?.title}</th>)}</tr></thead>
      <tbody>
        <tr className="border-t border-line"><th className="px-2 py-1.5 text-left text-muted">{t("choice.price")}</th>{indices.map((i) => <td key={i} className="px-2 py-1.5">{items[i]?.price?.value ?? "—"}{items[i]?.price && <FactMark fact={items[i]!.price!} compact />}</td>)}</tr>
        {labels.map((label) => <tr key={label} className="border-t border-line"><th className="px-2 py-1.5 text-left text-muted">{label}</th>{indices.map((i) => {
          const fact = items[i]?.facts.find((entry) => entry.label === label);
          return <td key={i} className="px-2 py-1.5">{fact?.value ?? "—"}{fact && <FactMark fact={fact} compact />}</td>;
        })}</tr>)}
      </tbody>
    </table>
  </div>;
}

function ChoiceState({ choice }: { choice: ChoiceView }) {
  if (choice.status === "awaiting") return null;
  if (choice.status === "expired") return <p className="mt-2 text-[11.5px] text-faint">{t("choice.expired")}</p>;
  return <div className="mt-3 flex justify-end"><div className="max-w-[80%] rounded-2xl rounded-br-md bg-surface-3 px-3 py-1.5 text-[13px] text-fg">{choice.answer}</div></div>;
}
