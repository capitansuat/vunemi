import { t } from "@vunemi/i18n";

/**
 * A Resume or Dismiss on the recovery card names the session it was shown in.
 * Main acts only when that is the session open now, so a card captured in
 * another session cannot resume or clear this one.
 */
export function recoveryOwner(raw: unknown, currentId: string): string {
  if (typeof raw !== "string" || raw === "" || raw !== currentId) throw new Error(t("mac.guard.closed"));
  return raw;
}

/**
 * A run's promise settles only when the run ends, but a resume that cannot
 * begin (a task that may not be resumed, a run already going) is refused at
 * once. That refusal is thrown so the card shows it; a later failure belongs
 * to the run's own events and is only logged.
 */
export async function refusedBeforeStart(run: Promise<unknown>, log: (err: unknown) => void = (err) => console.error("[vunemi] resume failed:", err)): Promise<void> {
  run.catch(log);
  await Promise.race([run.then(() => undefined), new Promise<void>((resolve) => setImmediate(resolve))]);
}
