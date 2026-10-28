import {parseBoundBrowserCapabilities} from './bound-browser-capabilities.js';
import {nativeV2Projection,type NativeAction} from './native-capabilities-v2.js';
import type { CallView } from './fold.js';
export type ObservedBackgroundAction = NativeAction | 'menu' | 'scroll';
export interface BackgroundCapabilityView {
  app: string | null;
  bundleId: string;
  windowId: number;
  windowTitle: string | null;
  observedActions: ObservedBackgroundAction[];
  unsupportedActions: ObservedBackgroundAction[];
  backend?: 'native-ax' | 'managed-browser' | 'owned-web-content';
  actionAvailability?: 'per-action';
  targetKind?: 'window' | 'page';
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, i) => value === b[i]);

/** Display only. No model prose, partial JSON, unrelated tool or snapshot can grant control. */
export function parseBackgroundCapabilities(call: Pick<CallView, 'tool' | 'status' | 'output'>): BackgroundCapabilityView | null {
  if(call.tool==='page_target_observe')return parseBoundBrowserCapabilities(call);
  if (call.tool !== 'desktop_background_describe' || call.status !== 'ok' || !call.output || call.output.length > 200_000) return null;
  let raw = call.output.trim();
  const fence = /^<untrusted_content source="desktop_background_describe">\n([\s\S]*)\n<\/untrusted_content>$/.exec(raw);
  if (fence) raw = fence[1]!;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!object(value) || value.controlMode !== 'backgroundStrict' || typeof value.snapshotId !== 'string' || !value.snapshotId.trim() || value.snapshotId.length > 200 || !Number.isSafeInteger(value.windowId) || Number(value.windowId) <= 0 || typeof value.bundleId !== 'string' || !value.bundleId || value.bundleId.length > 200 || !Array.isArray(value.targets) || value.targets.length > 4096) return null;
  if (value.windowTitle !== undefined && (typeof value.windowTitle !== 'string' || value.windowTitle.length > 2000)) return null;
  if (value.app !== undefined && (typeof value.app !== 'string' || value.app.length > 500)) return null;
  const summary = value.capabilities;

  const observed = new Set<ObservedBackgroundAction>(), refs = new Set<number>();
  for (const target of value.targets) {
    if (!object(target) || !Number.isSafeInteger(target.ref) || Number(target.ref) <= 0 || refs.has(Number(target.ref)) || typeof target.role !== 'string' || typeof target.label !== 'string' || !Array.isArray(target.backgroundActions) || target.backgroundActions.some(action => action !== 'press' && action !== 'set-value') || (target.subrole !== undefined && typeof target.subrole !== 'string') || (target.enabled !== undefined && typeof target.enabled !== 'boolean')) return null;
    refs.add(Number(target.ref));
    if (target.enabled === false || target.subrole) continue;
    if (value.bundleId === 'com.apple.calculator' && target.role === 'AXButton' && target.backgroundActions.includes('press')) observed.add('press');
    if (value.bundleId === 'com.apple.TextEdit' && target.role === 'AXTextArea' && target.backgroundActions.includes('set-value')) observed.add('set-value');
  }
  const actions = (['press', 'set-value'] as const).filter(action => observed.has(action));
  if(value.capabilitiesV2!==undefined){
    const projection=nativeV2Projection(value,actions);if(!projection)return null;
    return {app:typeof value.app==='string'&&value.app.trim()?value.app.trim():null,bundleId:value.bundleId,windowId:Number(value.windowId),windowTitle:typeof value.windowTitle==='string'&&value.windowTitle?value.windowTitle:null,...projection};
  }
  if (!object(summary) || summary.version !== 1 || summary.controlMode !== 'backgroundStrict' || !Array.isArray(summary.observedActions) || !Array.isArray(summary.unsupportedActions) || !same(summary.unsupportedActions, ['menu', 'scroll', 'drag'])) return null;
  if (!same(summary.observedActions, actions) || summary.status !== (actions.length ? 'observed' : 'no-actions-observed') || summary.reasonCode !== (actions.length ? 'eligible-targets-observed' : 'no-eligible-targets-observed')) return null;
  return { app: typeof value.app === 'string' && value.app.trim() ? value.app.trim() : null, bundleId: value.bundleId, windowId: Number(value.windowId), windowTitle: typeof value.windowTitle === 'string' && value.windowTitle ? value.windowTitle : null, observedActions: actions, unsupportedActions: ['menu', 'scroll', 'drag'] };
}
