/** Summarise already-recorded Vunemi runs without exporting chat or page content. */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const STEP_TOKEN_LIMIT = 16_000;

export function summarizeSession(session) {
  if (!session || !Array.isArray(session.events)) throw new Error("Expected a Vunemi session with an events array.");
  const runs = new Map();
  for (const event of session.events) {
    if (!event || typeof event !== "object" || typeof event.runId !== "string") continue;
    if (event.type === "run.started") {
      runs.set(event.runId, { runId: event.runId, model: event.model, startedAt: event.at, status: null, finishedAt: null, steps: new Map() });
    }
    const run = runs.get(event.runId);
    if (!run) continue;
    if (event.type === "step.started" && typeof event.stepId === "string") {
      run.steps.set(event.stepId, { stepId: event.stepId, index: event.index, promptTokens: null, completionTokens: null });
    }
    if (event.type === "usage" && typeof event.stepId === "string") {
      const step = run.steps.get(event.stepId);
      if (!step) continue;
      step.promptTokens = tokenCount(event.promptTokens);
      step.completionTokens = tokenCount(event.completionTokens);
    }
    if (event.type === "run.finished") {
      run.status = event.status;
      run.finishedAt = event.at;
    }
  }
  return [...runs.values()].map((run) => {
    const steps = [...run.steps.values()].sort((a, b) => a.index - b.index).map((step) => ({
      ...step,
      totalTokens: step.promptTokens === null || step.completionTokens === null
        ? null : step.promptTokens + step.completionTokens,
    }));
    const missingUsage = steps.length === 0 || steps.some((step) => step.totalTokens === null);
    const overLimit = steps.some((step) =>
      (step.promptTokens ?? 0) + (step.completionTokens ?? 0) > STEP_TOKEN_LIMIT);
    return {
      runId: run.runId,
      model: run.model,
      status: run.status,
      durationMs: Number.isFinite(run.startedAt) && Number.isFinite(run.finishedAt)
        ? run.finishedAt - run.startedAt : null,
      stepCount: steps.length,
      promptTokens: missingUsage ? null : steps.reduce((sum, step) => sum + step.promptTokens, 0),
      completionTokens: missingUsage ? null : steps.reduce((sum, step) => sum + step.completionTokens, 0),
      tokenRegression: overLimit ? true : missingUsage ? null : false,
      steps,
      // Success needs independent inspection of the final website state.
      success: null,
    };
  });
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write("Usage: node score.mjs /path/to/session.json\n");
    process.exit(2);
  }
  const runs = summarizeSession(JSON.parse(readFileSync(file, "utf8")));
  process.stdout.write(`${JSON.stringify({ limitPerStep: STEP_TOKEN_LIMIT, runs }, null, 2)}\n`);
}
