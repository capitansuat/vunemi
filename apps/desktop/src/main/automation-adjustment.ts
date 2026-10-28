/** An edited setup is inert until its exact waiting request accepts approval. */
export class AutomationAdjustment {
 private pending:{key:string;when:unknown;callId:string;owner:{runId:string;requestId:string};approved:boolean}|null=null;
 set(key:string,when:unknown,callId:string,owner:{runId:string;requestId:string}):void{this.pending={key,when,callId,owner:{...owner},approved:false};}
 settle(callId:string,owner:{runId:string;requestId:string},approved:boolean):void{
  const p=this.pending;if(!p||p.callId!==callId||p.owner.runId!==owner.runId||p.owner.requestId!==owner.requestId)return;
  if(approved)p.approved=true;else this.pending=null;
 }
 take(key:string,runId?:string,callId?:string):unknown{
  const p=this.pending;this.pending=null;
  return p?.approved&&p.key===key&&p.owner.runId===runId&&p.callId===callId?p.when:undefined;
 }
}
