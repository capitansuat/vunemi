import {OperationJournal} from '../../src/operation-journal.js';
import {Helper} from '../../src/helper.js';
const binary=process.argv[2]!,path=process.argv[3]!,mode=process.argv[4]!;
const target={bundleId:'com.apple.TextEdit',pid:123,processStartedAt:100,windowId:9};
const h=new Helper(binary,{operationJournalPath:path});
let effects=0;
(h as unknown as {transport:()=>Promise<unknown>}).transport=async()=>{
 effects++;
 if(mode==='hold'){
  process.stdout.write(JSON.stringify({ready:true,record:new OperationJournal(path).unresolved()[0]})+'\n');
  await new Promise<void>(resolve=>process.stdin.once('data',()=>resolve()));
 }
 return {status:'verified',operationId:'synthetic-native'};
};
try{const result=await h.call('background_press',{app:'123'},{ownerRunId:`owner-${process.pid}`,target});process.stdout.write(JSON.stringify({done:true,effects,result})+'\n');}
catch(e){const x=e as {reasonCode?:string;noInputSent?:boolean};process.stdout.write(JSON.stringify({done:true,effects,reasonCode:x.reasonCode,noInputSent:x.noInputSent})+'\n');}
