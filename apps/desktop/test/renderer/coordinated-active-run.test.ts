import {it,expect,vi} from 'vitest';
import {useStore} from '../../src/renderer/src/store.js';
vi.hoisted(()=>vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{}}));
it('does not promote restored pending content when a live start races an awaited session switch',async()=>{
 let finish!:(v:unknown)=>void;vi.stubGlobal('window',{vunemi:{openSession:()=>new Promise(resolve=>{finish=resolve;})}});useStore.setState({model:null,running:false,runs:[],sessions:{current:'a',sessions:[],projects:[]}});
 const loading=useStore.getState().openSession('b');useStore.getState().ingest({type:'run.started',runId:'actual-live',goal:'new',model:'local',at:1});
 expect(useStore.getState().activeRun).toEqual({runId:'actual-live',sessionId:'a'});
 finish({current:'b',sessions:[],projects:[],events:[{type:'run.started',runId:'old-restored',goal:'old',model:'local',at:1},{type:'plan.proposed',runId:'old-restored',steps:['Old plan'],at:2}]});await loading;
 expect(useStore.getState().runs.at(-1)?.plan?.status).toBe('awaiting');expect(useStore.getState().activeRun).toBe(null);
});
it('only matching live run finish clears the active event identity',()=>{useStore.setState({model:null,running:false,runs:[],sessions:{current:'a',sessions:[],projects:[]}});useStore.getState().ingest({type:'run.started',runId:'live',goal:'new',model:'local',at:1});useStore.getState().ingest({type:'run.finished',runId:'stale',status:'done',detail:'old',at:2});expect(useStore.getState().activeRun?.runId).toBe('live');expect(useStore.getState().running).toBe(true);useStore.getState().ingest({type:'run.finished',runId:'live',status:'stopped',detail:'Stopped',at:3});expect(useStore.getState().activeRun).toBe(null);});
