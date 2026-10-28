import {it,expect} from 'vitest';
import {explicitWriteTargets} from '../src/file-target.js';
it('recognizes an explicit output without mistaking a read input for it',()=>{
 expect(explicitWriteTargets('Read /tmp/source.csv and write the result to /tmp/report.md')).toEqual(['/tmp/report.md']);
 expect(explicitWriteTargets('/tmp/test.txt dosyasına tam olarak “test” yaz.')).toEqual(['/tmp/test.txt']);
 expect(explicitWriteTargets('Read /tmp/source.csv and explain it.')).toEqual([]);
 expect(explicitWriteTargets('Write /tmp/report.md and summary.txt')).toEqual([]);
 expect(explicitWriteTargets('Write relative/report.md')).toEqual([]);
});
