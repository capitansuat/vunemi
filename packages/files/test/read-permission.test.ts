import {it,expect,vi} from 'vitest';
import {mkdtempSync,writeFileSync,renameSync,mkdirSync,symlinkSync,rmSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Roots} from '../src/roots.js';
import {createFileReadPermission,assertPreparedFileRead} from '../src/read-permission.js';
const ctx={runId:'r',signal:new AbortController().signal,assertToolActive(){}};
it('prepares metadata without content reads and rejects replacements/mutated args',async()=>{const dir=realpathSync(mkdtempSync(join(tmpdir(),'vun13-')));try{const path=join(dir,'a.txt');writeFileSync(path,'one');const roots=new Roots([dir]),adapter=createFileReadPermission(roots),args={path};const descriptor=await adapter.prepare(args,ctx);expect(descriptor?.effect).toBe('file-read');expect(await adapter.revalidate(args,descriptor!,ctx)).toBe(true);writeFileSync(join(dir,'new.txt'),'two');renameSync(join(dir,'new.txt'),path);expect(await adapter.revalidate(args,descriptor!,ctx)).toBe(false);expect(()=>assertPreparedFileRead(args)).toThrow();}finally{rmSync(dir,{recursive:true,force:true});}});
it('keeps unsupported formats, symlinks, directories, and roots in single-call path',async()=>{const dir=realpathSync(mkdtempSync(join(tmpdir(),'vun13-')));try{const adapter=createFileReadPermission(new Roots([dir]));const file=join(dir,'a.txt');writeFileSync(file,'a');symlinkSync(file,join(dir,'link.txt'));mkdirSync(join(dir,'folder.txt'));writeFileSync(join(dir,'doc.docx'),'office');for(const path of [join(dir,'link.txt'),join(dir,'folder.txt'),join(dir,'doc.docx'),'/etc/hosts'])expect(await adapter.prepare({path},ctx)).toBeNull();}finally{rmSync(dir,{recursive:true,force:true});}});
