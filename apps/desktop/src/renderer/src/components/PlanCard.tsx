import { useState } from "react";
import { Ban, ListChecks, Pencil, Play } from "lucide-react";
import {currentActionOwner,type PlanView} from "../lib/fold.js";
import {callStatusLabel} from '../lib/labels.js';
import { useStore } from "../store.js";
import { t } from "@vunemi/i18n";

/** Intent preview: what the agent means to do, before it starts. */
export function PlanCard({ plan, readOnly = false }: { plan: PlanView; readOnly?: boolean }) {
  const resolvePlan = useStore((s) => s.resolvePlan);
  const renderedOwner=currentActionOwner(useStore.getState(),'plan',plan);
  const current=()=>renderedOwner?currentActionOwner(useStore.getState(),'plan',plan,renderedOwner):undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(plan.steps.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error,setError]=useState<string|null>(null),[expired,setExpired]=useState(false);

  if (readOnly || plan.status !== "awaiting" || !plan.requestId) return <PlanSummary plan={plan} />;

  const steps = () => draft.split("\n").map((l) => l.replace(/^\s*\d{1,2}[.)]\s*/, "").trim()).filter(Boolean);

  let sending=false;
  const go = () => {
    const owner=current();if(!owner||busy||expired||sending)return;
    const s = editing ? steps() : plan.steps;
    if (s.length === 0) return;
    sending=true;
    setBusy(true);
    setError(null);
    void resolvePlan({ kind: "go", steps: s },owner).then(ok=>{if(!current())return;if(!ok){setExpired(true);setBusy(false);}}).catch(e=>{if(!current())return;setError(e instanceof Error?e.message:String(e));setBusy(false);});
  };

  return (
    <div className="rounded-xl border border-line-strong bg-surface p-3.5">
      <div className="flex items-center gap-2 text-[12px] font-medium text-muted">
        <ListChecks size={14} strokeWidth={2.2} />
        {editing ? t("plan.editTitle") : t("plan.approveTitle")}
      </div>

      {editing ? (
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.max(3, draft.split("\n").length)}
          aria-label={t("plan.stepsLabel")}
          className="selectable mt-2.5 w-full resize-none rounded-lg border border-line bg-bg px-3 py-2 text-[13.5px] leading-relaxed text-fg focus:border-ember focus:outline-none"
        />
      ) : (
        <ol className="mt-2.5 space-y-1.5">
          {plan.steps.map((s, i) => (
            <li key={`${i}-${s}`} className="selectable flex gap-2.5 text-[13.5px] leading-snug text-fg">
              <span className="w-4 shrink-0 text-right font-mono text-[12px] text-faint">{i + 1}</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy||expired}
          onClick={go}
          className="flex items-center gap-1.5 rounded-lg bg-fg px-3.5 py-1.5 text-[13px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Play size={11} fill="currentColor" /> {editing ? t("plan.goEdited") : t("plan.go")}
        </button>
        {!editing && (
          <button
            type="button"
            disabled={busy||expired}
            onClick={() => {if(current())setEditing(true);}}
            className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3.5 py-1.5 text-[13px] text-fg transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            <Pencil size={12} /> {t("plan.edit")}
          </button>
        )}
        <button
          type="button"
          disabled={busy||expired}
          onClick={() => {
            const owner=current();if(!owner||busy||expired||sending)return;
            sending=true;
            setBusy(true);
            setError(null);
            void resolvePlan({ kind: "cancel" },owner).then(ok=>{if(!current())return;if(!ok){setExpired(true);setBusy(false);}}).catch(e=>{if(!current())return;setError(e instanceof Error?e.message:String(e));setBusy(false);});
          }}
          className="flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
        >
          <Ban size={12} /> {t("common.cancel")}
        </button>
      </div>
      {error&&<p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
      {expired&&<p role="status" className="mt-2 text-[12px] text-muted">{callStatusLabel('cancelled')}</p>}
    </div>
  );
}

/** Once decided, the plan collapses to a line the user can open again. */
function PlanSummary({ plan }: { plan: PlanView }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[12.5px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-faint transition-colors hover:text-muted"
      >
        <ListChecks size={12} />
        {plan.status === "cancelled" ? t("plan.cancelled") : t("plan.summary", { count: plan.steps.length })}
      </button>
      {open && (
        <ol className="selectable mt-1.5 ml-[5px] space-y-1 border-l border-line pl-3.5 text-faint">
          {plan.steps.map((s, i) => (
            <li key={`${i}-${s}`}>
              {i + 1}. {s}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
