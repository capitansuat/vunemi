import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { tasksFromEvents, type AgentEvent } from "@vunemi/agent-core";
import { setLocale } from "@vunemi/i18n";
import { useStore } from "../../src/renderer/src/store.js";
import { Turn } from "../../src/renderer/src/components/Turn.js";
import { foldEvent, type RunView } from "../../src/renderer/src/lib/fold.js";
import { TaskSummary } from "../../src/renderer/src/components/TaskSummary.js";
vi.hoisted(() => { vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} }); });
const events: AgentEvent[] = [
  { type: "run.started", runId: "r", goal: "Rapor hazırla", model: "local", at: 1 },
  { type: "plan.proposed", runId: "r", steps: ["Verileri oku", "Raporu yaz"], at: 2 },
  { type: "plan.resolved", runId: "r", decision: { kind: "go", steps: ["Verileri oku", "Raporu yaz"] } },
  { type: "tool.proposed", runId: "r", stepId: "s", callId: "c", tool: "file_read", actionClass: "read", args: {} },
];
beforeEach(() => { setLocale("tr"); useStore.setState({ runs: [], running: false, sessions: { current: "s_one", sessions: [], projects: [] } }); });

it("projects live task state independently of streamed text", () => {
  for (const event of events) useStore.getState().ingest(event);
  expect(useStore.getState().tasks?.[0]?.steps.map(s => s.title)).toEqual(["Verileri oku", "Raporu yaz"]);
  const tasks = useStore.getState().tasks;
  useStore.getState().ingest({ type: "message.delta", runId: "r", stepId: "s", text: "Bakıyorum" });
  expect(useStore.getState().tasks).toBe(tasks);
  useStore.getState().ingest({ type: "approval.required", runId: "r", stepId: "s", callId: "c", tool: "file_read", actionClass: "read", args: {}, reason: "İzin" });
  expect(useStore.getState().tasks?.[0]?.status).toBe("waiting_approval");
});
it("reconstructs tasks when reopening a legacy session without a tasks snapshot", async () => {
  vi.stubGlobal("window", { vunemi: { openSession: async () => ({ current: "s_two", sessions: [], projects: [], events }) } });
  await useStore.getState().openSession("s_two");
  expect(useStore.getState().tasks?.[0]?.goal).toBe("Rapor hazırla");
  expect(useStore.getState().tasks?.[0]?.steps).toHaveLength(2);
  vi.unstubAllGlobals();
});
it("clears the previous task when a different conversation becomes current", () => {
  for (const event of events) useStore.getState().ingest(event);
  useStore.getState().setSessions({ current: "s_other", sessions: [], projects: [] });
  expect(useStore.getState().tasks).toEqual([]);
});
it("renders waiting state and remaining steps instead of a false completion claim", () => {
  const task = tasksFromEvents([...events, { type: "approval.required", runId: "r", stepId: "s", callId: "c", tool: "file_read", actionClass: "read", args: {}, reason: "İzin" }])[0]!;
  const html = renderToStaticMarkup(<TaskSummary task={task} artefacts={[]} />);
  expect(html).toContain("Onay bekliyor"); expect(html).toContain("Verileri oku"); expect(html).toContain("Raporu yaz");
  expect(html).not.toContain("Adımlar tamamlandı");
});
it("shows produced files with registered actions and disables missing-file opening", () => {
  const task = tasksFromEvents([...events, { type: "tool.finished", runId: "r", callId: "c", ok: true, output: "saved", produced: [{ kind: "file", path: "/tmp/rapor.docx" }], durationMs: 1 }])[0]!;
  const html = renderToStaticMarkup(<TaskSummary task={task} artefacts={[{ id: "c:0", at: 1, goal: task.goal, item: task.outputs[0]!, missing: true, canOpen: false, canReveal: false, canPreview: false, canUndo: false }]} />);
  expect(html).toContain("rapor.docx"); expect(html).toContain("Dosya bulunamadı");
  expect(html).not.toContain("/tmp/rapor.docx"); expect(html).not.toContain(">Aç<");
});

it("shows a produced file once in the task summary instead of repeating it on the tool row", () => {
  const full: AgentEvent[] = [...events.slice(0, 3), { type: "step.started", runId: "r", stepId: "s", index: 0, at: 3 }, events[3]!, { type: "tool.finished", runId: "r", callId: "c", ok: true, output: "Saved", produced: [{ kind: "file", path: "/tmp/rapor.docx" }], durationMs: 1 }, { type: "run.finished", runId: "r", status: "done", detail: "Done", at: 4 }];
  const run = full.reduce(foldEvent, [] as RunView[])[0]!;
  const html = renderToStaticMarkup(<Turn run={run} task={tasksFromEvents(full)[0]!} />);
  expect(html.match(/>rapor\.docx</g)).toHaveLength(1);
});

it("does not present a working animation while the task is blocked on approval", () => {
  const task = tasksFromEvents([...events, { type: "task.progress", runId: "r", step: 1, status: "working", evidenceCallIds: [], at: 3 }, { type: "approval.required", runId: "r", stepId: "s", callId: "c", tool: "file_read", actionClass: "read", args: {}, reason: "İzin" }])[0]!;
  const html = renderToStaticMarkup(<TaskSummary task={task} artefacts={[]} />);
  expect(html).toContain("Onay bekliyor");
  expect(html).not.toContain('aria-label="Çalışıyor"');
});
