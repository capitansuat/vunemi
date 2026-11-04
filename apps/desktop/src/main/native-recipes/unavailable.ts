import { randomUUID } from "node:crypto";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "../../shared/ipc.js";
import type { NativeRecipesSnapshot } from "../../shared/native-recipes.js";

/**
 * Where background recipes are not offered (Linux, for now): the window's
 * calls are answered, with nothing listed and every setup refused in words
 * the user can read, rather than left without a handler. Nothing reads the
 * Swift helper, which is not there.
 */
export function installNativeRecipesUnavailable(handle: (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) => void, refusal: () => string): void {
  const empty: NativeRecipesSnapshot = { streamId: randomUUID(), revision: 0, recipes: [] };
  const refuse = (): never => {
    throw new Error(refusal());
  };
  handle(CH.nativeRecipeTargets, () => []);
  handle(CH.listNativeRecipes, () => ({ ...empty, recipes: [] }));
  handle(CH.beginNativeRecipeSetup, refuse);
  handle(CH.prepareNativeRecipe, refuse);
  handle(CH.approveNativeRecipe, refuse);
  handle(CH.cancelNativeRecipeSetup, () => undefined);
  handle(CH.revokeNativeRecipe, refuse);
}
