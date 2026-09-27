import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, ChevronRight, HardDrive, RefreshCw } from "lucide-react";
import { useStore } from "../store.js";
import { PROVIDER_LABEL, shortModelName } from "../lib/labels.js";
import { contextChoices } from "../lib/format.js";
import { t } from "@vunemi/i18n";

export function ModelPicker() {
  const { providers, model, running, setModel, refreshProviders, engine } = useStore();
  const provider = model?.slice(0, model.indexOf(":"));
  const noneReachable = providers !== null && providers.every((p) => !p.reachable);
  const selectedAvailable = !!model && providers?.some((p) => p.reachable && p.models.includes(model));
  // The built-in engine's context length can be changed here as well as in Settings.
  const installed = engine?.installed.find((m) => `vunemi:${m.id}` === model);

  return (
    <Menu.Root onOpenChange={(open) => open && void refreshProviders()}>
      <Menu.Trigger
        disabled={running}
        className="no-drag flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors hover:bg-surface-2 disabled:opacity-60 data-[state=open]:bg-surface-2"
      >
        <span
          className={`size-1.5 rounded-full ${noneReachable ? "bg-danger" : selectedAvailable ? "bg-ok" : "bg-faint"}`}
          aria-hidden
        />
        <span className="font-medium text-fg">{model ? shortModelName(model) : t("model.pick")}</span>
        {provider && (
          <span className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-px text-[11px] text-muted">
            <HardDrive size={10} /> {t("model.local")} · {PROVIDER_LABEL[provider] ?? provider}
          </span>
        )}
        <ChevronDown size={13} className="text-faint" />
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Content
          align="start"
          sideOffset={6}
          className="z-50 max-h-[70vh] w-[340px] overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-2xl scroll-thin"
        >
          {providers === null && <div className="px-3 py-2 text-[12.5px] text-faint">{t("model.searching")}</div>}
          {providers?.map((p) => (
            <Menu.Group key={p.kind} className="py-1">
              <Menu.Label className="flex items-center justify-between px-2.5 pt-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
                {PROVIDER_LABEL[p.kind] ?? p.kind}
                <span className={`normal-case tracking-normal ${p.reachable ? "text-ok" : "text-faint"}`}>
                  {p.kind === "vunemi" && engine
                    ? t(`engine.state.${engine.engine.state}`)
                    : p.reachable ? t("model.count", { count: p.models.length }) : t("model.notRunning")}
                </span>
              </Menu.Label>
              {!p.reachable && (
                <p className="px-2.5 pb-1.5 text-[12px] leading-snug text-faint">
                  {p.kind === "lmstudio" ? (
                    <>
                      {t("model.startWith")} <code className="font-mono text-muted">lms server start</code>
                    </>
                  ) : p.kind === "ollama" ? (
                    <>
                      {t("model.startWith")} <code className="font-mono text-muted">ollama serve</code>
                    </>
                  ) : <>{t("model.startWith")} <code className="font-mono text-muted">llama-server</code></>}
                </p>
              )}
              {p.models.map((spec) => (
                <Menu.Item
                  key={spec}
                  onSelect={() => setModel(spec)}
                  className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 outline-none data-[highlighted]:bg-surface-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-fg">{shortModelName(spec)}</div>
                    <div className="truncate font-mono text-[10.5px] text-faint">{spec.slice(spec.indexOf(":") + 1)}</div>
                  </div>
                  {spec === model && <Check size={14} className="shrink-0 text-ember" />}
                </Menu.Item>
              ))}
            </Menu.Group>
          ))}
          <Menu.Separator className="my-1 h-px bg-line" />
          {installed && (
            <Menu.Sub>
              <Menu.SubTrigger className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] text-muted outline-none data-[highlighted]:bg-surface-2 data-[state=open]:bg-surface-2">
                <span className="flex-1">{t("engine.installed.context")}</span>
                <span className="font-mono text-[11.5px] text-faint">{`${Math.round(installed.context / 1024)}K`}</span>
                <ChevronRight size={12} className="text-faint" />
              </Menu.SubTrigger>
              <Menu.Portal>
                <Menu.SubContent sideOffset={6} className="z-50 w-[220px] rounded-xl border border-line bg-surface p-1.5 shadow-2xl">
                  <Menu.RadioGroup
                    value={String(installed.context)}
                    onValueChange={(v) => void window.vunemi.engineSetContext(installed.id, Number(v)).catch((e: unknown) => console.error(e))}
                  >
                    {contextChoices(installed.context, installed.maxContext).map((n) => (
                      <Menu.RadioItem
                        key={n}
                        value={String(n)}
                        className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] text-fg outline-none data-[highlighted]:bg-surface-2"
                      >
                        <span className="flex-1 font-mono">{`${Math.round(n / 1024)}K`}</span>
                        <Menu.ItemIndicator><Check size={13} className="text-ember" /></Menu.ItemIndicator>
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                  <p className="px-2.5 pb-1 pt-1.5 text-[11px] leading-snug text-faint">{t("engine.installed.contextHint")}</p>
                </Menu.SubContent>
              </Menu.Portal>
            </Menu.Sub>
          )}
          <Menu.Item
            onSelect={(e) => {
              e.preventDefault();
              void refreshProviders();
            }}
            className="flex cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] text-muted outline-none data-[highlighted]:bg-surface-2"
          >
            <RefreshCw size={12} /> {t("model.refresh")}
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
