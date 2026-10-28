import {it,expect} from 'vitest';
import {nativeSetupInput,nativeApproveRequest,nativePrepareRequest,nativeRevokeRequest} from '../../src/main/native-recipes/ipc.js';
it('rejects renderer authority and extra fields',()=>{
 expect(()=>nativeApproveRequest({setupSessionId:'s',setupCallId:'c',offerId:'o',offerRevision:1,binding:{}})).toThrow();
 expect(()=>nativePrepareRequest({setupSessionId:'s',setupCallId:'c',readOfferId:'o',readOfferRevision:1,decision:'approve_always'})).toThrow();
 expect(()=>nativeRevokeRequest({automationId:'a',expectedRevision:NaN})).toThrow();
});
it('normalizes exact inputs without sharing renderer objects',()=>{
 const req={recipeId:'textedit.append-save.v1',target:{path:'/fixture/a.txt',pid:1,windowId:2},literal:'\nhello',timeZone:'Europe/London',slots:[{local:'2026-10-21T10:00'}]};
 const out=nativeSetupInput(req);req.target.pid=9;expect(out.target.pid).toBe(1);expect(out.literal).toBe('\nhello');expect(()=>nativeSetupInput({...req,target:{...req.target,handle:'private'}})).toThrow();
});
