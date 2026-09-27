import { useEffect, useState } from "react";
import type { LocalModelSettings, ModelCheckResult } from "../../../shared/ipc.js";
import { useStore } from "../store.js";
import { t } from "@vunemi/i18n";

const SOURCES = [
  { id: "lmstudio", label: "LM Studio", hint: "http://127.0.0.1:1234/v1" },
  { id: "ollama", label: "Ollama", hint: "http://127.0.0.1:11434" },
  { id: "llamacpp", label: "llama.cpp", hint: "http://127.0.0.1:8080/v1" },
] as const;

export function ModelSources() {
  const [settings, setSettings] = useState<LocalModelSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<ModelCheckResult | null>(null);
  const model = useStore((state) => state.model);
  const providers = useStore((state) => state.providers);
  const refreshProviders = useStore((state) => state.refreshProviders);

  useEffect(() => {
    void window.vunemi.getModelSettings().then(setSettings).catch((err: unknown) => setError(String(err)));
  }, []);

  useEffect(() => setCheck(null), [model]);

  async function save() {
    if (!settings) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      setSettings(await window.vunemi.setModelSettings(settings));
      await refreshProviders();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function checkSelected() {
    if (!model) return;
    const selected = model;
    setChecking(true);
    setCheck(null);
    setError(null);
    try {
      const result = await window.vunemi.checkModel(selected);
      if (useStore.getState().model === selected) setCheck(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="mt-6 space-y-3 rounded-xl border border-line bg-surface p-4">
      <div>
        <h3 className="text-[13px] font-medium text-fg">{t("model.sources.title")}</h3>
        <p className="mt-1 text-[11.5px] text-muted">{t("model.sources.body")}</p>
      </div>
      {SOURCES.map((source) => {
        const status = providers?.find((item) => item.kind === source.id);
        return (
          <label key={source.id} className="block">
            <span className="mb-1 flex justify-between text-[12px] text-fg">
              <span>{source.label}</span>
              <span className={status?.reachable ? "text-ok" : "text-faint"}>{status?.reachable ? t("model.count", { count: status.models.length }) : t("model.sources.notConnected")}</span>
            </span>
            <input aria-label={t("model.sources.address", { name: source.label })} value={settings?.endpoints[source.id] ?? ""} placeholder={source.hint}
              onChange={(event) => setSettings((current) => current && ({ ...current, endpoints: { ...current.endpoints, [source.id]: event.target.value } }))}
              disabled={!settings || busy || checking}
              className="w-full rounded-md border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[11.5px] text-fg disabled:opacity-50" />
          </label>
        );
      })}
      <label className="block text-[12px] text-fg">
        {t("model.sources.ollamaContext")}
        <input aria-label={t("model.sources.ollamaContext")} type="number" min="2048" max="131072" step="1024"
          value={settings?.ollamaContextLength ?? ""}
          onChange={(event) => setSettings((current) => current && ({ ...current, ollamaContextLength: Number(event.target.value) }))}
          disabled={!settings || busy || checking}
          className="mt-1 block w-36 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] text-fg disabled:opacity-50" />
      </label>
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={!settings || busy || checking}
          className="rounded-md bg-ember px-3 py-1.5 text-[12px] text-white disabled:opacity-50">{t("model.sources.save")}</button>
        {saved && <span className="text-[11.5px] text-ok">{t("model.sources.saved")}</span>}
      </div>
      <div className="border-t border-line pt-3">
        <p className="text-[11.5px] text-muted">{t("model.check.selected", { model: model ?? t("model.check.none") })}</p>
        <button type="button" disabled={!model || checking || busy} onClick={() => void checkSelected()}
          className="mt-2 rounded-md border border-line px-3 py-1.5 text-[12px] text-fg disabled:opacity-50">
          {checking ? t("model.check.running") : t("model.check.run")}
        </button>
        {check && <p role="status" className={`mt-2 text-[11.5px] ${check.toolCalled ? "text-ok" : "text-muted"}`}>
          {check.toolCalled ? t("model.check.ok") : t("model.check.failed")}
          {` (${t("time.seconds", { n: (check.durationMs / 1000).toFixed(1) })})`}
        </p>}
      </div>
      {error && <p role="alert" className="text-[11.5px] text-danger">{error}</p>}
    </div>
  );
}
