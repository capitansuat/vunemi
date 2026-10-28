import { expect, it } from 'vitest';
import {setLocale} from '@vunemi/i18n';
import {toolLabel} from '../../src/renderer/src/lib/labels.js';
it('dynamic engine and new desktop tools have readable labels rather than protocol names',()=>{setLocale('tr');for(const name of ['desktop_background_document','documents_engine_run','desktop_operation_status']){expect(toolLabel(name,'awaiting')).not.toBe(name);expect(toolLabel(name,'running')).not.toBe(name);expect(toolLabel(name,'ok')).not.toBe(name);}});
it('fallback successful labels do not promise independent verification',()=>{setLocale('en');expect(toolLabel('custom_engine_run','ok')).not.toMatch(/verified|checked|complete/i);});
it('semantic moves have localized labels without presenting them as drag',()=>{for(const locale of ['tr','en','de','es','fr','it','ja','ko','pt','ru','zh'] as const){setLocale(locale);for(const name of ['files_move','desktop_document_move','desktop_document_move_observe'])for(const phase of ['awaiting','running','ok'] as const){const label=toolLabel(name,phase);expect(label).not.toBe(name);expect(label).not.toMatch(/drag|sürükle/i)}}setLocale('en')});
