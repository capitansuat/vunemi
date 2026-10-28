import { Eye } from 'lucide-react';
import { t } from '@vunemi/i18n';
import type { BackgroundCapabilityView,ObservedBackgroundAction } from '../lib/background-capabilities.js';
import { useStore } from '../store.js';

const actionLabel=(action:ObservedBackgroundAction)=>{
  switch(action){
    case 'press':return t('backgroundCapabilities.actions.press');
    case 'set-value':return t('backgroundCapabilities.actions.setValue');
    case 'scroll-position':return t('backgroundCapabilities.actions.scrollPosition');
    case 'menu-open':return t('backgroundCapabilities.actions.menuOpen');
    case 'menu-select':return t('backgroundCapabilities.actions.menuSelect');
    default:return t(`backgroundCapabilities.actions.${action}`);
  }
};

/** Historical observation, not an input surface or a claim of completed work. */
export function BackgroundCapabilitiesCard({ capabilities }: { capabilities: BackgroundCapabilityView }) {
  useStore(s => s.locale);
  const target=[...new Set([capabilities.app ?? capabilities.bundleId,capabilities.windowTitle].filter(Boolean))].join(' · ');
  return <section data-background-capabilities className="rounded-lg border border-line bg-surface px-3 py-3" aria-label={t('backgroundCapabilities.title')}>
    <h3 className="flex items-center gap-1.5 text-[12.5px] font-medium text-fg"><Eye size={14} aria-hidden="true" />{t('backgroundCapabilities.title')}</h3>
    {capabilities.backend && <p className="mt-1 text-[11.5px] text-muted">{t(capabilities.backend==='native-ax'?'backgroundCapabilities.backend.native':capabilities.backend==='managed-browser'?'backgroundCapabilities.backend.browser':'backgroundCapabilities.backend.webContent')}</p>}
    <p className="selectable mt-2 break-words text-[12px] text-muted">{t('chatTask.target')} · {target} · {t('chatTask.mode.background')}</p>
    <p className="mt-2 text-[12px] leading-relaxed text-fg">{capabilities.actionAvailability==='per-action' ? t('backgroundCapabilities.perAction') : capabilities.observedActions.length ? <>{t('backgroundCapabilities.available')}: {capabilities.observedActions.map(action=>action==='drag'&&capabilities.backend==='native-ax'?t('backgroundCapabilities.actions.sliderDrag'):actionLabel(action)).join(' · ')}</> : t('backgroundCapabilities.none')}</p>
    {capabilities.unsupportedActions.length>0 && <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{t(capabilities.backend ? 'backgroundCapabilities.notObserved' : 'backgroundCapabilities.notProvided')}: {capabilities.unsupportedActions.map(actionLabel).join(' · ')}</p>}
    <p className="mt-2 text-[11.5px] leading-relaxed text-muted">{t('backgroundCapabilities.observationOnly')}</p>
  </section>;
}
