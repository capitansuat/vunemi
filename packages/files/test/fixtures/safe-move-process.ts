import {linkSync,unlinkSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {SafeMoveController} from '../../src/safe-move.js';
import {Roots} from '../../src/roots.js';
import {withJournalAdmission} from '../../../mac/src/journal-coordinator.js';
const [binary,dir,mode,name='first']=process.argv.slice(2) as [string,string,string,string];
const journalPath=join(dir,'journal.json');let effects=0,backups=0;
const source=join(dir,`${name}.txt`),destination=join(dir,'to',`${name}.txt`);
const send=(value:unknown)=>process.send?.(value);
const controller=()=>new SafeMoveController({roots:new Roots([dir]),journalPath,withAdmission:(body,signal)=>withJournalAdmission(binary,journalPath,body,signal),adapter:{move:async request=>{
 effects++;send({event:'effect',operationId:request.operationId});
 if(mode==='hold')await new Promise<void>(resolve=>process.once('message',()=>resolve()));
 if(mode==='recover')return{status:'not-moved',reasonCode:'synthetic-refusal'};
 linkSync(request.source,request.destination);unlinkSync(request.source);return{status:'moved'};
}}});
async function main(){
 const c=controller();
 if(mode==='observe'){const before=readFileSync(journalPath,'utf8');controller();send({event:'done',unchanged:before===readFileSync(journalPath,'utf8'),rows:JSON.parse(before).rows,effects,backups});return;}
 const p=c.prepare({source,destination,ownerId:name});
 try{await c.run(p,{ownerId:name,beforeEffect:()=>{backups++;}});send({event:'done',status:'verified',effects,backups,operationId:p.operationId});}
 catch(error){const e=error as {reasonCode?:string;deliveryUnknown?:boolean};
  if(mode==='recover'){let blocked=false;try{c.prepare({source:join(dir,'first.txt'),destination:join(dir,'to','first.txt'),ownerId:'no-replay'});}catch{blocked=true;}send({event:'done',reason:e.reasonCode,effects,backups,blocked,rows:JSON.parse(readFileSync(journalPath,'utf8')).rows});}
  else send({event:'done',reason:e.reasonCode,deliveryUnknown:e.deliveryUnknown,effects,backups});
 }
}
main().catch(error=>{send({event:'fatal',message:String(error)});process.exitCode=1;}).finally(()=>process.disconnect?.());
