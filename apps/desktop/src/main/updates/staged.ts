/**
 * A second look at the update Squirrel.Mac downloaded, before Vunemi quits
 * to install it: the staged app must verify, and its designated requirement
 * must be the running app's. Squirrel checks this too; this does not rely
 * on it alone.
 */
import { fileURLToPath } from "node:url";

export type Run = (cmd: string, args: string[]) => Promise<string>;

const requirement = (out: string): string | null => out.split("\n").find((line) => line.startsWith("designated =>"))?.trim() ?? null;

/** True: signed like us. False: it is not. Null: Squirrel's state could not be read, so this cannot tell. */
export async function stagedMatches(run: Run, stateFile: string, currentApp: string): Promise<boolean | null> {
  let staged: string;
  try {
    const state = JSON.parse(await run("plutil", ["-convert", "json", "-o", "-", stateFile])) as { updateBundleURL?: unknown };
    if (typeof state.updateBundleURL !== "string") return null;
    staged = fileURLToPath(state.updateBundleURL).replace(/\/$/, "");
  } catch {
    return null;
  }
  try {
    await run("codesign", ["--verify", "--deep", "--strict", staged]);
    const ours = requirement(await run("codesign", ["-d", "-r-", currentApp]));
    const theirs = requirement(await run("codesign", ["-d", "-r-", staged]));
    return ours !== null && ours === theirs;
  } catch {
    return false;
  }
}
