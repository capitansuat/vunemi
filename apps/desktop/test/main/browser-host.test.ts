import {it,expect,beforeEach,afterEach,vi} from 'vitest';
// Keep millisecond boundary cases deterministic under parallel test scheduling.
beforeEach(()=>vi.spyOn(Date,'now').mockReturnValue(1_792_080_000_000));
afterEach(()=>vi.restoreAllMocks());
import {browserHostObservation} from '../../src/main/browser-host.js';
const valid=()=>({version:1,observedAt:Date.now()/1000,verified:true,unlocked:true,foregroundPid:456,cursor:{x:10.5,y:-20}});
it('accepts a fresh verified native host observation without exposing extra fields',()=>{expect(browserHostObservation({...valid(),privateText:'not forwarded'})).toEqual({foregroundPid:456,cursor:{x:10.5,y:-20},unlocked:true});});
it.each(['locked','unverified','pid','cursor','nan','old','future','version'])('refuses %s host state before a bound browser action',mode=>{const v:any=valid();if(mode==='locked')v.unlocked=false;if(mode==='unverified')v.verified=false;if(mode==='pid')v.foregroundPid=null;if(mode==='cursor')v.cursor=null;if(mode==='nan')v.cursor.x=NaN;if(mode==='old')v.observedAt-=10.001;if(mode==='future')v.observedAt+=1.001;if(mode==='version')v.version=2;expect(()=>browserHostObservation(v)).toThrow();});
