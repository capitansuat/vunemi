import {it,expect} from 'vitest';
import {unsupportedYear} from '../src/output-grounding.js';
it('rejects a report year that exists only in a filesystem path or system date',()=>{
 expect(unsupportedYear('# Rapor (Ocak - Haziran 2026)','/research/2026-10-13/files','Ay,Gelir\nOcak,12000')).toBe('2026');
 expect(unsupportedYear('Ocak-Haziran 2026 döneminde gelir arttı.','Analiz yap','Ocak,12000')).toBe('2026');
 expect(unsupportedYear('# Rapor (Ocak - Haziran 2026)','2026 yılı raporu','')).toBeNull();
 expect(unsupportedYear('# Rapor (Ocak - Haziran 2026)','Rapor','2026 yılı satış verileri')).toBeNull();
 expect(unsupportedYear('| Ocak | 2000 |\nHedef farkı 2000 TL','Rapor','')).toBeNull();
});
