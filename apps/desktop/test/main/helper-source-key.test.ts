import {it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,renameSync,symlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {helperSourceKey} from '../../../../scripts/helper-source-key.mjs';
it('invalidates the helper cache for nested C sources, headers and source paths',()=>{
 const dir=mkdtempSync(join(tmpdir(),'helper-key-'));mkdirSync(join(dir,'Sources','VunemiHelper'),{recursive:true});writeFileSync(join(dir,'Sources','VunemiHelper','main.swift'),'main');mkdirSync(join(dir,'Sources','Signal','include'),{recursive:true});writeFileSync(join(dir,'Package.swift'),'package');const c=join(dir,'Sources','Signal','cancel.c'),h=join(dir,'Sources','Signal','include','cancel.h'),ent=join(dir,'entitlements');writeFileSync(c,'v1');writeFileSync(h,'header1');writeFileSync(ent,'permission1');
 const key=()=>helperSourceKey(dir,ent,'signer','0');const first=key();writeFileSync(c,'v2');expect(key()).not.toBe(first);const second=key();writeFileSync(h,'header2');expect(key()).not.toBe(second);const third=key();renameSync(h,join(dir,'Sources','Signal','include','other.h'));expect(key()).not.toBe(third);
});
it('keeps build output out of the key while binding signing and entitlements',()=>{
 const dir=mkdtempSync(join(tmpdir(),'helper-key-'));mkdirSync(join(dir,'Sources','VunemiHelper'),{recursive:true});writeFileSync(join(dir,'Sources','VunemiHelper','main.swift'),'main');writeFileSync(join(dir,'Package.swift'),'package');const ent=join(dir,'entitlements');writeFileSync(ent,'permission1');const key=()=>helperSourceKey(dir,ent,'signer','0'),first=key();mkdirSync(join(dir,'.build'));writeFileSync(join(dir,'.build','binary'),'build');expect(key()).toBe(first);expect(helperSourceKey(dir,ent,'other','0')).not.toBe(first);expect(helperSourceKey(dir,ent,'signer','1')).not.toBe(first);writeFileSync(ent,'permission2');expect(key()).not.toBe(first);
});
it('prints the key when the script is reached through a symlinked checkout',()=>{
 const dir=mkdtempSync(join(tmpdir(),'helper-key-'));mkdirSync(join(dir,'Sources','VunemiHelper'),{recursive:true});writeFileSync(join(dir,'Sources','VunemiHelper','main.swift'),'main');writeFileSync(join(dir,'Package.swift'),'package');const ent=join(dir,'entitlements');writeFileSync(ent,'permission1');
 const scripts=resolve(fileURLToPath(import.meta.url),'../../../../../scripts'),link=join(mkdtempSync(join(tmpdir(),'helper-link-')),'scripts');symlinkSync(scripts,link);
 const out=execFileSync(process.execPath,[join(link,'helper-source-key.mjs'),dir,ent,'signer','0'],{encoding:'utf8'}).trim();
 expect(out).toMatch(/^[0-9a-f]{16}$/);expect(out).toBe(helperSourceKey(dir,ent,'signer','0'));
});
