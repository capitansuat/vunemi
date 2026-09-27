import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeSession } from "./score.mjs";

describe("session token metrics", () => {
  it("flags a step over 16K while leaving success for independent review", () => {
    const [run] = summarizeSession({ events: [
      { type: "run.started", runId: "r1", model: "local", at: 100, goal: "private" },
      { type: "step.started", runId: "r1", stepId: "s1", index: 0 },
      { type: "usage", runId: "r1", stepId: "s1", promptTokens: 15_500, completionTokens: 600 },
      { type: "run.finished", runId: "r1", status: "done", at: 200, detail: "private" },
    ] });
    assert.equal(run.tokenRegression, true);
    assert.equal(run.steps[0].totalTokens, 16_100);
    assert.equal(run.durationMs, 100);
    assert.equal(run.success, null);
    assert.equal(JSON.stringify(run).includes("private"), false);
  });

  it("does not call missing provider usage a pass", () => {
    const [run] = summarizeSession({ events: [
      { type: "run.started", runId: "r2", at: 0 },
      { type: "step.started", runId: "r2", stepId: "s2", index: 0 },
      { type: "usage", runId: "r2", stepId: "s2", promptTokens: null, completionTokens: 100 },
    ] });
    assert.equal(run.tokenRegression, null);
    assert.equal(run.promptTokens, null);
    assert.equal(run.status, null);
  });

  it("does not report a run with no model step as under the token limit", () => {
    const [run] = summarizeSession({ events: [
      { type: "run.started", runId: "r3", at: 0 },
      { type: "run.finished", runId: "r3", status: "failed", at: 10 },
    ] });
    assert.equal(run.tokenRegression, null);
    assert.equal(run.stepCount, 0);
  });

  it("rejects input without an event stream", () => {
    assert.throws(() => summarizeSession({}), /events array/);
  });
});
