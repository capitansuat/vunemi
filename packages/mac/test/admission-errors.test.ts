import {it,expect,afterEach} from 'vitest';
import {setLocale} from '@vunemi/i18n';
import {admissionErrorText} from '../src/admission-errors.js';
afterEach(()=>setLocale('en'));
it('shows a Turkish no-input message for a busy target and keeps uncertainty distinct',()=>{
 setLocale('tr');expect(admissionErrorText('target-busy','fallback')).toBe('Bu pencereyi başka bir görev kullanıyor. Yeni giriş gönderilmedi.');
 expect(admissionErrorText('delivery-blocked','fallback')).toContain('belirsiz');
});
it('returns the original diagnostic for unknown or prototype-shaped reason codes',()=>{
 for(const code of ['future-code','__proto__','constructor','toString'])expect(admissionErrorText(code,'original diagnostic')).toBe('original diagnostic');
});
