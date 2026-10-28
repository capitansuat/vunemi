import {singleBackgroundPress} from './background-intent.js';
import type {TaskOperation} from './tasks.js';
/** Model generation constraint only; parameters and native authorization remain real. */
export function initialBackgroundRead(goal:string, operations:readonly TaskOperation[]):string|undefined {
  if (!singleBackgroundPress(goal) || !/calculator|hesap\s+makinesi/iu.test(goal)) return;
  if (operations.some(op=>op.tool==='desktop_background_describe'&&op.status==='completed')) return;
  return 'desktop_background_describe';
}
