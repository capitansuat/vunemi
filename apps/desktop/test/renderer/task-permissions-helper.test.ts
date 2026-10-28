import {it,expect} from 'vitest';
import { currentPermissionOffer, acceptsPermissionSnapshot } from '../../src/renderer/src/lib/task-permissions.js';
const offer={offerId:'o',revision:1,callId:'c',sessionId:'s',taskId:'t',runId:'r',effect:'file-read',target:{kind:'file',path:'/a',name:'a'},maxUses:8} as const;
const call={callId:'c',tool:'files_read',actionClass:'read',status:'awaiting',taskPermissionOffer:offer};
const state={running:true,sessions:{current:'s'},activeRun:{sessionId:'s',runId:'r'},runs:[{runId:'r',status:'running',pendingAction:{kind:'approval',callId:'c'},steps:[{calls:[call]}]}]};
it('accepts only the exact current offer',()=>{expect(currentPermissionOffer(state as any,call as any)).toEqual(offer);expect(currentPermissionOffer({...state,running:false} as any,call as any)).toBeUndefined();expect(currentPermissionOffer(state as any,{...call,taskPermissionOffer:{...offer,revision:2}} as any)).toBeUndefined();});
it('rejects foreign and older list responses',()=>{const snapshot={revision:3,sessionId:'s',runId:'r',grants:[]};expect(acceptsPermissionSnapshot(state as any,snapshot,null)).toBe(true);expect(acceptsPermissionSnapshot(state as any,{...snapshot,sessionId:'other'},null)).toBe(false);expect(acceptsPermissionSnapshot(state as any,{...snapshot,revision:2},snapshot)).toBe(false);});
