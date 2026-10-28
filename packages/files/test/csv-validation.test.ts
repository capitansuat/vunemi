import {expect,it} from 'vitest';
import {csvIssue} from '../src/csv.js';
it('rejects unquoted decimal commas without rejecting quoted fields or escaped quotes',()=>{
 expect(csvIssue('a,b\n1,33,33\n')).toMatch(/row 2/i);
 expect(csvIssue('a,b\n1,"33,33"\n')).toBeNull();
 expect(csvIssue('a,b\n1,"a""b\nc"\n')).toBeNull();
 expect(csvIssue('a,b\n1,"broken\n')).toMatch(/quote/i);
});
