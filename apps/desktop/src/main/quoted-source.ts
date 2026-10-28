import {createHash} from 'node:crypto';
import {copyQuotedSource,type QuotedSource,type AgentEvent} from '@vunemi/agent-core';
/** Validate against this conversation's actual assistant text, never renderer prose. */
export function validateQuotedSource(value:unknown,currentSessionId:string,events:readonly AgentEvent[]):QuotedSource {
 const source=copyQuotedSource(value);
 if(source.sessionId!==currentSessionId)throw Error('Quoted source belongs to another conversation.');
 const starts=events.filter(e=>e.type==='run.started'&&e.runId===source.runId);
 const finishes=events.filter(e=>e.type==='run.finished'&&e.runId===source.runId);
 if(starts.length!==1||finishes.length!==1||finishes[0]?.type!=='run.finished'||!['done','max_steps'].includes(finishes[0].status))throw Error('Quoted source run is unfinished or not eligible.');
 const start=events.indexOf(starts[0]!),finish=events.indexOf(finishes[0]!);
 const stepStarts=events.filter(e=>e.type==='step.started'&&e.stepId===source.stepId);
 if(stepStarts.length!==1||stepStarts[0]?.runId!==source.runId||events.indexOf(stepStarts[0]!)<=start||events.indexOf(stepStarts[0]!)>=finish||events.some(e=>e.type==='step.superseded'&&e.runId===source.runId&&e.stepId===source.stepId))throw Error('Quoted source step is not owned or eligible.');
 const finalStep=events.findLast(e=>e.type==='step.started'&&e.runId===source.runId);
 if(finalStep?.type!=='step.started'||finalStep.stepId!==source.stepId)throw Error('Quoted source must be the final assistant step.');
 if(finishes[0].status==='max_steps'&&events.some(e=>(e.type==='tool.proposed'||e.type==='choice.asked')&&e.runId===source.runId&&e.stepId===source.stepId))throw Error('Quoted source step is not a completed answer.');
 const stepAt=events.indexOf(stepStarts[0]!);
 let text='';for(let i=0;i<events.length;i++){const e=events[i]!;if(e.type==='message.delta'&&e.runId===source.runId&&e.stepId===source.stepId){if(i<=stepAt||i>=finish)throw Error('Quoted source step drifted.');text+=e.text;}}
 if(!text.includes(source.text)||createHash('sha256').update(JSON.stringify(text)).digest('hex')!==source.sourceHash)throw Error('Quoted source text drifted or is not a literal selection.');
 return source;
}
