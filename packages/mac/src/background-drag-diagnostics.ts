/** Stable native diagnostic codes only; never persist raw errors, labels, paths or values. */
export const DRAG_REASON_CODES=['stopped','drag-expired','session-unavailable','target-identity-changed','target-label-changed','slider-value-unavailable','slider-progress-changed','environment-changed','point-unavailable','event-creation-failed','guard-or-post-failed','post-observation-unavailable','foreground-changed','cursor-changed','drag-delivery-unverified'] as const;
export const DRAG_PHASES=['preflight','down','move','up','readback'] as const;
export type DragReasonCode=typeof DRAG_REASON_CODES[number];
export type DragPhase=typeof DRAG_PHASES[number];
export const dragReasonCode=(x:unknown):x is DragReasonCode=>typeof x==='string'&&(DRAG_REASON_CODES as readonly string[]).includes(x);
export const dragPhase=(x:unknown):x is DragPhase=>typeof x==='string'&&(DRAG_PHASES as readonly string[]).includes(x);
export function nativeDragDiagnostics(value:Record<string,unknown>):{reasonCode?:DragReasonCode;phase?:DragPhase}{return {...(dragReasonCode(value.reasonCode)?{reasonCode:value.reasonCode}:{}),...(dragPhase(value.phase)?{phase:value.phase}:{})};}

export function dragFailureMessage(value:Record<string,unknown>):string {
 const d=nativeDragDiagnostics(value),dispatch=typeof value.dispatchId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.dispatchId)?value.dispatchId:undefined;
 return 'Slider delivery/result is uncertain; inspect before any retry.'+(d.reasonCode?` Reason: ${d.reasonCode}.`:'')+(d.phase?` Phase: ${d.phase}.`:'')+(dispatch?` Dispatch ID: ${dispatch}. Query desktop_operation_status; never replay uncertain input.`:'');
}
