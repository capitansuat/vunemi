import type { AgentEvent } from "@vunemi/agent-core";
type Delta = Extract<AgentEvent, { type: "message.delta" | "thought.delta" }>;
const isDelta = (e: AgentEvent): e is Delta => e.type === "message.delta" || e.type === "thought.delta";

/** Presentation only: main still persists the full ordered stream. Controls never wait for a frame. */
export function createEventBatcher(deliver: (event: AgentEvent) => void, schedule: (callback: () => void) => () => void) {
  let pending: Delta[] = [];
  let cancel: (() => void) | undefined;
  let closed = false;
  let size = 0;
  const flush = () => {
    cancel?.(); cancel = undefined;
    const events = pending; pending = []; size = 0;
    for (const event of events) deliver(event);
  };
  return {
    push(event: AgentEvent) {
      if (closed) return;
      if (!isDelta(event)) { flush(); deliver(event); return; }
      const last = pending.at(-1);
      if (last?.type === event.type && last.runId === event.runId && last.stepId === event.stepId) last.text += event.text;
      else pending.push({ ...event });
      size += event.text.length;
      if (size >= 16_384 || pending.length >= 64) { flush(); return; }
      cancel ??= schedule(() => { cancel = undefined; flush(); });
    },
    flush,
    dispose() { closed = true; flush(); },
  };
}

/** RAF may pause in a hidden window; the timer keeps voice and status presentation moving. */
export function schedulePresentation(callback: () => void): () => void {
  let done = false;
  const run = () => { if (!done) { done = true; cancelAnimationFrame(frame); clearTimeout(timer); callback(); } };
  const frame = requestAnimationFrame(run);
  const timer = setTimeout(run, 32);
  return () => { done = true; cancelAnimationFrame(frame); clearTimeout(timer); };
}
