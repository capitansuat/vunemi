/**
 * Intent preview: before a task with several steps starts, the model sketches
 * what it means to do, and the user says go, edits it, or calls it off.
 *
 * Deliberately one cheap, tool-free model call that must answer in a fixed
 * shape — a small local model plans far better when it isn't also choosing
 * tools. A one-step or chatty request gets no plan and no card.
 */

import { chatWithinBudget, type Budget } from "./budget.js";
import type { ChatMessage, ChatModel } from "./provider.js";

export const PLAN_PROMPT = `You turn a user's request into a short plan they can check before you start.

Rules:
- Write at most 6 steps, one line each, numbered "1." to "6.".
- Each step is a short action in the user's own language, e.g. "Hepsiburada'da kulaklık ara".
- Plan only what the request asks for. Never add steps that send, buy, delete or publish anything unless the user asked.
- If the request is a single step, a question you can answer from knowledge, or small talk, reply with exactly: NONE
Reply with the plan or NONE, nothing else.`;

export const MAX_PLAN_STEPS = 6;

/** Words that join two things to do, in the language the user writes in. */
const JOINS = /(?:^|\s)(?:ve|sonra|ardından|sonrasında|önce|then|and)(?:\s|$)/i;

/**
 * Whether to spend a model call on planning at all.
 *
 * The plan call is tool-free, but a local reasoning model can still spend
 * several seconds on it. Length alone is not evidence of multiple actions:
 * a flight search with dates and passenger details is still one request.
 * Only an explicit separator or joining word earns an extra plan call.
 */
export function worthPlanning(goal: string): boolean {
  const text = goal.trim();
  if (text.includes(",") || text.includes(";") || text.includes("\n")) return true;
  if (JOINS.test(text)) return true;
  return false;
}

/**
 * How much a plan may cost before it's given up. A healthy plan is a few
 * hundred tokens of thinking and six short lines. See budget.ts for why the
 * clock starts at the first token.
 */
export const PLAN_BUDGET: Budget = { ms: 90_000, chars: 20_000, firstMs: 180_000 };

export type PlanBudget = Budget;

/**
 * The steps; null when the task doesn't warrant a plan; "overrun" when the
 * model went past its budget before producing one.
 */
export async function proposePlan(
  model: ChatModel,
  goal: string,
  opts: { signal: AbortSignal; context?: ChatMessage[]; allowSingle?: boolean; budget?: PlanBudget },
): Promise<string[] | null | "overrun"> {
  const text = await chatWithinBudget(
    model,
    [
      { role: "system", content: opts.allowSingle
        ? PLAN_PROMPT.replace("a single step, a question", "a question") + "\nIn this mode, a single action needs a one-step preview."
        : PLAN_PROMPT },
      ...(opts.context ?? []),
      { role: "user", content: goal },
    ],
    opts.signal,
    opts.budget ?? PLAN_BUDGET,
  );
  return text === "overrun" ? "overrun" : parsePlan(text, opts.allowSingle);
}

export function parsePlan(text: string, allowSingle = false): string[] | null {
  const steps: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^none\b/i.test(line)) return null;
    const m = /^(\d{1,2})[.)]\s+(.*\S)/.exec(line);
    if (m) steps.push(m[2]!.replace(/\s+/g, " ").slice(0, 160));
  }
  // One step is just the task restated; not worth a card.
  return steps.length > (allowSingle ? 0 : 1) ? steps.slice(0, MAX_PLAN_STEPS) : null;
}

/** How the agreed plan reaches the model, alongside the goal. */
export function planNote(steps: readonly string[]): string {
  return `The user agreed to this plan. Follow it, adapting if a step turns out to be impossible:\n${steps
    .map((s, i) => `${i + 1}. ${s}`)
    .join("\n")}`;
}
