import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, ChoiceAnswer, ChoiceCard, RunResult } from "@vunemi/agent-core";

const card: ChoiceCard = { kind: "choice", question: "When?", options: ["Friday", "Saturday"], allowOther: true };
const replies: ChoiceAnswer[] = [];

vi.mock("@vunemi/agent-core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@vunemi/agent-core")>();
  return { ...real,
    createModel: (id: string) => ({ id, contextWindow: async () => 20_000 }),
    runAgent: async (opts: { goal: string; emit: (e: AgentEvent) => void; requestChoice: (req: { callId: string; card: ChoiceCard }) => Promise<ChoiceAnswer>; signal: AbortSignal }): Promise<RunResult> => {
      opts.emit({ type: "run.started", runId: "r", goal: opts.goal, model: "m", at: 0 });
      opts.emit({ type: "choice.asked", runId: "r", stepId: "s", callId: "c", card, at: 1 });
      const answer = await Promise.race([
        opts.requestChoice({ callId: "c", card }),
        new Promise<null>((resolve) => opts.signal.addEventListener("abort", () => resolve(null), { once: true })),
      ]);
      if (answer) replies.push(answer);
      if(answer&&opts.goal==='repeat choice'){
        const nextCard={...card,question:'Second question',options:['Monday','Tuesday']};
        opts.emit({type:'choice.asked',runId:'r',stepId:'second',callId:'c',card:nextCard,at:2});
        const next=await opts.requestChoice({callId:'c',card:nextCard});replies.push(next);
      }
      opts.emit({ type: "run.finished", runId: "r", status: answer ? "done" : "stopped", detail: "", at: 2 });
      return { runId: "r", status: answer ? "done" : "stopped", detail: "", messages: [], charsPerToken: 3 };
    },
  };
});

const { AgentSession } = await import("../../src/main/session.js");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function session() {
  const events: AgentEvent[] = [];
  return { events, session: new AgentSession({ tools: { list: () => [], get: () => undefined } as never, emit: (e) => events.push(e), authorize: async () => ({ kind: "allow" }), onUntrustedOutput: () => {}, grants: new Set() }) };
}

describe("session choice wait", () => {
  it("routes typed text into the pending choice and resolves only once", async () => {
    replies.length = 0;
    const { session: s,events } = session();
    const done = s.start("Find a time", "m");
    await tick();
    const event=events.find(e=>e.type==='choice.asked')! as Extract<AgentEvent,{type:'choice.asked'}>,owner={runId:event.runId,requestId:event.requestId!};
    expect(s.resolveChoice("old-run", "c", { text: "", index: 0 },owner)).toBe(false);
    expect(s.submit("Tuesday", "m")).toBeNull();
    expect(s.resolveChoice("r", "c", { text: "", index: 0 },owner)).toBe(false);
    expect(await done).toBe("done");
    expect(replies).toEqual([{ text: "Tuesday" }]);
    expect(s.queued).toEqual([]);
  });

  it("ignores a stale answer after Stop", async () => {
    const { session: s,events } = session();
    const done = s.start("Find a time", "m");
    await tick();
    const event=events.find(e=>e.type==='choice.asked')! as Extract<AgentEvent,{type:'choice.asked'}>,owner={runId:event.runId,requestId:event.requestId!};
    s.stop();
    expect(s.resolveChoice("r", "c", { text: "", index: 0 },owner)).toBe(false);
    expect(await done).toBe("stopped");
  });
  it('does not let a stale card answer a second choice in the same run with a reused call ID',async()=>{
    replies.length=0;const {session:s,events}=session(),done=s.start('repeat choice','m');await tick();
    const first=events.find(e=>e.type==='choice.asked')! as Extract<AgentEvent,{type:'choice.asked'}>,oldOwner={runId:first.runId,requestId:first.requestId!};
    expect(s.resolveChoice('r','c',{text:'',index:0},oldOwner)).toBe(true);await tick();
    const second=events.filter(e=>e.type==='choice.asked').at(-1)! as Extract<AgentEvent,{type:'choice.asked'}>,owner={runId:second.runId,requestId:second.requestId!};
    expect(owner.requestId).not.toBe(oldOwner.requestId);expect(s.resolveChoice('r','c',{text:'',index:0},oldOwner)).toBe(false);
    expect((s.resolveChoice as any)('r','c',{text:'',index:0})).toBe(false);
    expect(s.resolveChoice('r','c',{text:'',index:1},owner)).toBe(true);await done;expect(replies).toEqual([{text:'',index:0},{text:'',index:1}]);
  });
});
