import { useEffect, useState, type ComponentType } from "react";
import { Check } from "lucide-react";
import type { Autonomy, AutonomyPolicy } from "@vunemi/agent-core";
import { ACTION_CLASSES } from "@vunemi/agent-core";
import { LOCALES, t } from "@vunemi/i18n";
import type { LockState, PermissionSettings, PreferenceView } from "../../../shared/ipc.js";
import { ConnectionsView, Switch } from "./ConnectionsView.js";
import { ModelPicker } from "./ModelPicker.js";
import { ModelSources } from "./ModelSources.js";
import { EngineSetup } from "./EngineSetup.js";
import { AutomationsSection } from "./AutomationsSection.js";
import { ActivityView } from "./ActivityView.js";
import { OutboxView } from "./OutboxView.js";
import { VaultView } from "./VaultView.js";
import { useStore, type SettingsSection as Section } from "../store.js";

const SECTIONS: Section[] = ["permissions", "security", "connections", "vault", "outbox", "automations", "activity", "model", "language", "data"];

/** Sections that are whole views of their own, with their own scrolling. */
const WHOLE: Partial<Record<Section, ComponentType>> = { connections: ConnectionsView, vault: VaultView, outbox: OutboxView, activity: ActivityView };

const MODES: Autonomy[] = ["auto", "ask", "deny"];

type Preset = "observe" | "plan" | "confirm" | "autonomous";

const PRESETS: { id: Preset; policy: AutonomyPolicy; planBeforeRun: boolean }[] = [
  {
    id: "observe",
    policy: { read: "auto", "write-local": "deny", destructive: "deny", outbound: "deny", financial: "deny" },
    planBeforeRun: false,
  },
  {
    id: "plan",
    policy: { read: "auto", "write-local": "ask", destructive: "ask", outbound: "ask", financial: "deny" },
    planBeforeRun: true,
  },
  {
    id: "confirm",
    policy: { read: "auto", "write-local": "ask", destructive: "ask", outbound: "ask", financial: "deny" },
    planBeforeRun: false,
  },
  {
    id: "autonomous",
    policy: { read: "auto", "write-local": "auto", destructive: "ask", outbound: "ask", financial: "deny" },
    planBeforeRun: false,
  },
];

function samePolicy(a: AutonomyPolicy, b: AutonomyPolicy): boolean {
  return ACTION_CLASSES.every((action) => a[action] === b[action]);
}

export function SettingsView() {
  const section = useStore((state) => state.settingsSection);
  const setSection = useStore((state) => state.openSettings);
  const Whole = WHOLE[section];
  const [permission, setPermission] = useState<PermissionSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);

  useEffect(() => {
    void window.vunemi.getPolicy().then(setPermission).catch((err: unknown) => setError(String(err)));
  }, []);

  async function save(next: PermissionSettings) {
    setSaving(true);
    setError(null);
    try {
      setPermission(await window.vunemi.setPolicy(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      <nav aria-label={t("settings.sectionsLabel")} className="w-[185px] shrink-0 border-r border-line bg-surface px-2.5 py-6">
        <h1 className="px-2.5 pb-3 text-[16px] font-semibold text-fg">{t("app.nav.settings")}</h1>
        {SECTIONS.map((id) => (
          <button key={id} type="button" aria-current={section === id ? "page" : undefined}
            onClick={() => setSection(id)}
            className={`mb-1 w-full rounded-lg px-2.5 py-2 text-left text-[12.5px] ${section === id ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2"}`}>
            {t(`settings.sections.${id}`)}
          </button>
        ))}
      </nav>
      {Whole ? <div className="flex min-w-0 flex-1 flex-col"><Whole /></div> : (
      <div className="scroll-thin min-w-0 flex-1 overflow-y-auto px-6 py-7">
        {section === "permissions" && (
          <div className="mx-auto max-w-[620px]">
            <h2 className="text-[17px] font-semibold text-fg">{t("settings.sections.permissions")}</h2>
            <p className="mt-1 text-[13px] text-muted">{t("settings.permissions.intro")}</p>
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              {PRESETS.map((preset) => {
                const on = !!permission && samePolicy(permission.policy, preset.policy) && permission.planBeforeRun === preset.planBeforeRun;
                return (
                  <button key={preset.id} type="button" disabled={saving || !permission} onClick={() => void save({ policy: preset.policy, planBeforeRun: preset.planBeforeRun })}
                    aria-pressed={on}
                    className={`rounded-xl border p-3 text-left disabled:opacity-50 ${on ? "border-ember bg-ember-soft" : "border-line bg-surface hover:border-line-strong"}`}>
                    <strong className="block text-[13px] text-fg">{t(`settings.presets.${preset.id}.label`)}</strong>
                    <span className="mt-1 block text-[11.5px] text-muted">{t(`settings.presets.${preset.id}.description`)}</span>
                  </button>
                );
              })}
            </div>
            <div className="mt-6 overflow-hidden rounded-xl border border-line bg-surface">
              {ACTION_CLASSES.map((action) => action === "financial" ? (
                // Not a setting: the Sentinel refuses payments whatever this
                // says, so offering a choice here would be a lie.
                <div key={action} className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3.5 py-3 last:border-b-0">
                  <span className="text-[12.5px] text-fg">{t(`settings.actions.${action}`)}</span>
                  <span className="text-[12px] text-muted">{t("settings.permissions.moneyLocked")}</span>
                </div>
              ) : (
                <label key={action} className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3.5 py-3 last:border-b-0">
                  <span className="text-[12.5px] text-fg">{t(`settings.actions.${action}`)}</span>
                  <select aria-label={t("settings.permissions.selectLabel", { action: t(`settings.actions.${action}`) })} value={permission?.policy[action] ?? "deny"} disabled={saving || !permission}
                    onChange={(event) => permission && void save({ ...permission, policy: { ...permission.policy, [action]: event.target.value as Autonomy } })}
                    className="rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] text-fg">
                    {MODES.map((mode) => <option key={mode} value={mode}>{t(`settings.modes.${mode}`)}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <p className="mt-3 text-[11.5px] text-faint">{t("settings.permissions.handedOver")}</p>
            {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
          </div>
        )}
        {section === "security" && <SecuritySection />}
        {section === "automations" && <AutomationsSection />}
        {section === "model" && (
          <div className="mx-auto max-w-[620px]">
            <h2 className="text-[17px] font-semibold text-fg">{t("settings.sections.model")}</h2>
            <p className="mb-5 mt-1 text-[13px] text-muted">{t("settings.model.intro")}</p>
            <ModelPicker />
            <div className="my-5">
              <EngineSetup showInstalled />
            </div>
            <ModelSources />
          </div>
        )}
        {section === "language" && <LanguageSection />}
        {section === "data" && (
          <div className="mx-auto max-w-[620px]">
            <h2 className="text-[17px] font-semibold text-fg">{t("settings.sections.data")}</h2>
            <p className="mt-1 text-[13px] text-muted">{t("settings.data.intro")}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <button type="button" onClick={() => void useStore.getState().forgetSession()} className="rounded-lg border border-line px-3 py-2 text-[12px] text-fg">{t("settings.data.forgetSession")}</button>
              <button type="button" onClick={() => setSection("activity")} className="rounded-lg border border-line px-3 py-2 text-[12px] text-fg">{t("app.nav.activity")}</button>
              <button type="button" onClick={() => setSection("vault")} className="rounded-lg border border-line px-3 py-2 text-[12px] text-fg">{t("settings.data.openVault")}</button>
            </div>
            <PreferencesSection />
            <div className="mt-8 rounded-xl border border-danger/40 bg-danger/5 p-4">
              <h3 className="text-[13px] font-medium text-fg">{t("settings.data.forgetAll")}</h3>
              <p className="mt-1 text-[12px] text-muted">{t("settings.data.forgetAllBody")}</p>
              {confirmForget ? (
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={() => {
                    setError(null);
                    void window.vunemi.forgetEverything().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
                  }} className="rounded-lg bg-danger px-3 py-2 text-[12px] text-white">{t("settings.data.forgetConfirm")}</button>
                  <button type="button" onClick={() => setConfirmForget(false)} className="px-2 text-[12px] text-muted">{t("common.cancel")}</button>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirmForget(true)} className="mt-3 rounded-lg border border-danger/40 px-3 py-2 text-[12px] text-danger">{t("settings.data.forgetAll")}…</button>
              )}
              {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

function PreferencesSection() {
  const [items, setItems] = useState<PreferenceView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void window.vunemi.listPreferences().then(setItems).catch((err: unknown) => setError(String(err)));
  }, []);

  async function remove(id: string) {
    setBusy(id);
    setError(null);
    try {
      setItems(await window.vunemi.deletePreference(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-8 rounded-xl border border-line bg-surface p-4">
      <h3 className="text-[13px] font-medium text-fg">{t("preferences.title")}</h3>
      <p className="mt-1 text-[12px] text-muted">{t("preferences.description")}</p>
      {items.length === 0 ? <p className="mt-3 text-[12px] text-muted">{t("preferences.empty")}</p> : (
        <ul className="mt-3 divide-y divide-line">
          {items.map((item) => <li key={item.id} className="flex items-start justify-between gap-3 py-2 text-[12px]">
            <span className="min-w-0 break-words text-fg">{item.text}</span>
            <button type="button" disabled={busy !== null} onClick={() => void remove(item.id)}
              aria-label={t("preferences.removeLabel", { text: item.text })}
              className="shrink-0 text-danger disabled:opacity-50">{t("common.delete")}</button>
          </li>)}
        </ul>
      )}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    </section>
  );
}

/**
 * The optional app lock. Switching it either way shows macOS's own dialog
 * first — main won't change the setting without the owner's yes.
 */
function SecuritySection() {
  const [lock, setLock] = useState<LockState | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.vunemi.getLock().then(setLock).catch(() => undefined);
    return window.vunemi.onLock(setLock);
  }, []);

  async function change(on: boolean) {
    setAsking(true);
    setError(null);
    try {
      const attempt = await window.vunemi.setAppLock(on);
      setLock(attempt.state);
      if (!attempt.ok && attempt.message) setError(attempt.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="mx-auto max-w-[620px]">
      <h2 className="text-[17px] font-semibold text-fg">{t("settings.sections.security")}</h2>
      <p className="mt-1 text-[13px] text-muted">{t("settings.lock.intro")}</p>
      <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3.5 py-3">
        <span className="text-[12.5px] text-fg">{t("settings.lock.label")}</span>
        <Switch on={lock?.enabled ?? false} label={t("settings.lock.label")} disabled={!lock || asking} onChange={(next) => void change(next)} />
      </div>
      {asking && <p className="mt-3 text-[12px] text-muted">{t("settings.lock.asking")}</p>}
      <p className="mt-3 text-[11.5px] text-faint">{t("settings.lock.note")}</p>
      {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
    </div>
  );
}

/**
 * Each language is listed in itself, so whoever opened this in a language
 * they cannot read can still find their own.
 */
function LanguageSection() {
  const locale = useStore((s) => s.locale);
  const setLocale = useStore((s) => s.setLocale);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-[620px]">
      <h2 className="text-[17px] font-semibold text-fg">{t("settings.sections.language")}</h2>
      <p className="mt-1 text-[13px] text-muted">{t("settings.language.intro")}</p>
      <ul role="radiogroup" aria-label={t("settings.sections.language")} className="mt-5 grid gap-1.5 sm:grid-cols-2">
        {LOCALES.map((l) => {
          const on = l.code === locale;
          return (
            <li key={l.code}>
              <button
                type="button"
                role="radio"
                aria-checked={on}
                lang={l.code}
                onClick={() => {
                  setError(null);
                  void setLocale(l.code).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
                }}
                className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-[13px] ${
                  on ? "border-ember bg-ember-soft text-fg" : "border-line bg-surface text-fg hover:border-line-strong"
                }`}
              >
                <span>
                  {l.name}
                  {l.name !== l.english && <span className="ml-2 text-[11.5px] text-faint">{l.english}</span>}
                </span>
                {on && <Check size={14} className="text-ember" />}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[11.5px] text-faint">{t("settings.language.note")}</p>
      {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
