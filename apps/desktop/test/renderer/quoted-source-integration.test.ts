import {beforeEach,it,expect,vi} from 'vitest';
vi.hoisted(()=>vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{}}));
import {useStore} from '../../src/renderer/src/store.js';
import {foldEvent} from '../../src/renderer/src/lib/fold.js';
const quote={version:1 as const,sessionId:'s',runId:'source',stepId:'step',text:'Synthetic quote',sourceHash:'a'.repeat(64)};
beforeEach(()=>{useStore.setState({model:'test',running:false,pendingStart:null,sessions:{current:'s',sessions:[],projects:[]}});vi.stubGlobal('window',{vunemi:{startRun:vi.fn(async()=>{}),steerRun:vi.fn(async()=>{})}});});
it('send and steer preserve source metadata beside the explicit question and attachments',async()=>{
 await useStore.getState().send(' Question ',['/tmp/synthetic'],[],quote);
 expect(window.vunemi.startRun).toHaveBeenCalledExactlyOnceWith({goal:'Question',model:'test',attachments:['/tmp/synthetic'],quotedSource:quote});
 await useStore.getState().steer(' Follow-up ',[],[],quote);
 expect(window.vunemi.steerRun).toHaveBeenCalledExactlyOnceWith({goal:'Follow-up',model:'test',quotedSource:quote});
});
it('source without an explicit question never invokes either dispatch channel',async()=>{
 await useStore.getState().send(' ',[],[],quote);await useStore.getState().steer('',[],[],quote);
 expect(window.vunemi.startRun).not.toHaveBeenCalled();expect(window.vunemi.steerRun).not.toHaveBeenCalled();
});
it('transcript reconstruction retains the exact quote, separate from the user goal',()=>{
 const runs=foldEvent([],{type:'run.started',runId:'new',goal:'Question',model:'test',at:1,quotedSource:quote});
 expect(runs[0]?.quotedSource).toEqual(quote);expect(runs[0]?.goal).toBe('Question');
});
