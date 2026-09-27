/**
 * One tool-free model call that is allowed to give up. Plans and summaries
 * are optional work; a reasoning model that loops can think for minutes, and
 * the user would sit waiting on something they never asked for.
 *
 * The clock for the answer starts at the first streamed token: a slow local
 * model reading a long conversation first is not an answer running long, and
 * gets its own, wider limit (`firstMs`) so a stuck server still ends.
 */

import type { ChatMessage, ChatModel, ToolSpec } from "./provider.js";

export type Budget = { ms: number; chars: number; firstMs?: number };

/**
 * The answer's text, or "overrun" past either limit. The caller's own abort
 * still throws. `tools` are offered only so the request matches one the
 * server has cached; any call the model makes with them is ignored.
 */
export async function chatWithinBudget(
  model: ChatModel,
  messages: ChatMessage[],
  signal: AbortSignal,
  budget: Budget,
  tools: ToolSpec[] = [],
): Promise<string | "overrun"> {
  const overrun = new AbortController();
  let timer = setTimeout(() => overrun.abort(), budget.firstMs ?? budget.ms);
  let started = false;
  let streamed = 0;
  try {
    const result = await model.chat(
      { messages, tools, signal: AbortSignal.any([signal, overrun.signal]) },
      (chunk) => {
        if (!started) {
          started = true;
          clearTimeout(timer);
          timer = setTimeout(() => overrun.abort(), budget.ms);
        }
        streamed += chunk.text.length;
        if (streamed > budget.chars) overrun.abort();
      },
    );
    return overrun.signal.aborted ? "overrun" : result.text;
  } catch (err) {
    // Over budget is not a failure of the task; the caller's stop still is.
    if (overrun.signal.aborted && !signal.aborted) return "overrun";
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
