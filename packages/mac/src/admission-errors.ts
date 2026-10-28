import {t} from '@vunemi/i18n';
const messages={
 'helper-busy':'mac.guard.busy',
 'target-busy':'mac.guard.targetBusy',
 'owner-closed':'mac.guard.closed',
 'stopped':'mac.guard.closed',
 'delivery-blocked':'mac.guard.uncertain',
 'invalid-owner':'mac.guard.identity',
 'invalid-target':'mac.guard.identity',
 'lease-capacity':'mac.guard.capacity',
 'journal-unavailable':'mac.guard.journal',
 'helper-unavailable':'mac.helper.missing',
} as const;
export function admissionErrorText(reasonCode:string,fallback:string):string {
 const key=Object.hasOwn(messages,reasonCode)?messages[reasonCode as keyof typeof messages]:undefined;return key?t(key):fallback;
}
