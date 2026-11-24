/**
 * What "approve all in this task" reaches in an app. Approving is per app, since
 * what a click does depends on where it lands. Apps where a click can send or
 * spend are never covered, whatever the user pressed.
 */

import { soundsLikeSendOrDelete, type ApproveAllCover } from "@vunemi/agent-core";
import type { MacApp } from "./helper.js";
import { notScheduledReason } from "./policy.js";
import { installedBundle, type AppLookup } from "./scheduled-apps.js";

/** The words are shared with the browser (agent-core approve-all.ts). */
export { soundsLikeSendOrDelete };

/** `word` is the label of the control or the key combination this step would use. */
export async function inputCover(app: Pick<MacApp, "name" | "bundleId">, word?: string, look: Pick<AppLookup, "folders" | "withId"> = {}): Promise<ApproveAllCover | undefined> {
  if (word !== undefined && soundsLikeSendOrDelete(word)) return undefined;
  if (notScheduledReason(app)) return undefined;
  // Its category decides too (finance, social networking): an app whose bundle
  // can't be read keeps its card rather than pass for an ordinary one.
  const bundle = await installedBundle(app, look).catch(() => undefined);
  if (!bundle || notScheduledReason({ ...app, ...(bundle.category && { category: bundle.category }) })) return undefined;
  return { key: `app:${app.bundleId}`, app: app.name };
}
