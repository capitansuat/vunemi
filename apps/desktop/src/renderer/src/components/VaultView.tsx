import { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, Plus, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import type { VaultStatus } from "../../../shared/ipc.js";
import { formatDate, t } from "@vunemi/i18n";

const EMPTY: VaultStatus = { available: true, secrets: [] };

/**
 * The Kasa. The user puts a secret in once; after that only its name is ever
 * shown again — here, in the activity log, and to the model.
 */
export function VaultView() {
  const [status, setStatus] = useState<VaultStatus>(EMPTY);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.vunemi.vaultStatus().then(setStatus);
  }, []);

  const run = async (fn: () => Promise<VaultStatus>) => {
    setError(null);
    try {
      setStatus(await fn());
      return true;
    } catch (err) {
      setError(String((err as Error).message ?? err).replace(/^.*Error: /, ""));
      return false;
    }
  };

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-6 pt-8 pb-10">
        <h1 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight text-fg">
          <KeyRound size={17} className="text-muted" /> {t("app.nav.vault")}
        </h1>
        <p className="mt-1 text-[13px] text-muted">
          {t("vault.intro")}
        </p>

        <div className="mt-3 flex items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2.5 text-[12.5px] text-muted">
          <ShieldCheck size={14} className="mt-0.5 shrink-0 text-ok" />
          <span>
            {t("vault.neverTypes")}
          </span>
        </div>

        {!status.available && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5 text-[12.5px] text-fg">
            <TriangleAlert size={14} className="mt-0.5 shrink-0 text-danger" />
            <span>
              {t("vault.unavailable")}
            </span>
          </div>
        )}

        {error && <p className="mt-3 text-[12.5px] text-danger">{error}</p>}

        {status.secrets.length === 0 ? (
          <p className="mt-8 text-[13px] text-faint">{t("vault.empty")}</p>
        ) : (
          <ul className="mt-5 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {status.secrets.map((s) => (
              <li key={s.name} className="flex items-start gap-3 px-3.5 py-3">
                <KeyRound size={13} className="mt-0.5 shrink-0 text-faint" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12.5px] text-fg">{s.name}</div>
                  <div className="truncate text-[11.5px] text-faint">
                    {s.note ?? t("vault.noNote")}
                    {" · "}
                    {s.lastUsedAt ? t("vault.lastUsed", { when: when(s.lastUsedAt) }) : t("vault.neverUsed")}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void run(() => window.vunemi.vaultDelete(s.name))}
                  title={t("vault.deleteLabel", { name: s.name })}
                  aria-label={t("vault.deleteLabel", { name: s.name })}
                  className="shrink-0 rounded-md p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-danger"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {adding ? (
          <AddForm
            onCancel={() => setAdding(false)}
            onSave={async (name, value, note) => {
              const ok = await run(() => window.vunemi.vaultSet(name, value, note));
              if (ok) setAdding(false);
            }}
          />
        ) : (
          <button
            type="button"
            disabled={!status.available}
            onClick={() => setAdding(true)}
            className="mt-4 flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-[12.5px] text-fg transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            <Plus size={13} /> {t("vault.add")}
          </button>
        )}
      </div>
    </div>
  );
}

function AddForm({
  onSave,
  onCancel,
}: {
  onSave: (name: string, value: string, note?: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  const ready = name.trim() !== "" && value !== "" && !busy;

  return (
    <form
      className="mt-4 space-y-2.5 rounded-xl border border-line bg-surface p-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        void onSave(name.trim(), value, note.trim() || undefined).finally(() => setBusy(false));
      }}
    >
      <Field label={t("vault.form.name")} hint={t("vault.form.nameHint")}>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="github-token"
          className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[12.5px] text-fg outline-none focus:border-line-strong"
        />
      </Field>

      <Field label={t("vault.form.value")} hint={t("vault.form.valueHint")}>
        <div className="flex gap-1.5">
          <input
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[12.5px] text-fg outline-none focus:border-line-strong"
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            aria-label={show ? t("vault.form.hide") : t("vault.form.show")}
            title={show ? t("vault.form.hide") : t("vault.form.show")}
            className="shrink-0 rounded-md border border-line px-2 text-muted transition-colors hover:text-fg"
          >
            {show ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        </div>
      </Field>

      <Field label={t("vault.form.note")} hint={t("vault.form.optional")}>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("vault.form.notePlaceholder")}
          className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[12.5px] text-fg outline-none focus:border-line-strong"
        />
      </Field>

      <div className="flex justify-end gap-2 pt-0.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:text-fg"
        >
          {t("common.cancel")}
        </button>
        <button
          type="submit"
          disabled={!ready}
          className="rounded-md bg-ember px-3 py-1.5 text-[12.5px] font-medium text-bg transition-opacity disabled:opacity-50"
        >
          {t("vault.form.save")}
        </button>
      </div>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] text-faint">
        {label} <span className="text-faint/70">· {hint}</span>
      </span>
      {children}
    </label>
  );
}

function when(at: number): string {
  return formatDate(new Date(at), { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}
