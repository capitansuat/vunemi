import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@vunemi/i18n";
import { AutomationStore, CATCH_UP_MS, createAutomationTools, describeSchedule, latestSlot, nextSlot, scheduledGoal, Scheduler, suggestion, summaryLine, validSchedule, validScope, AUTOMATION_INSTRUCTIONS, type AutomationStatus } from "../../src/main/automations.js";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const HOUR = 3_600_000;

describe("schedules", () => {
  it("accepts only well-formed schedules, at most hourly", () => {
    expect(validSchedule({ kind: "daily", time: "09:00" })).toEqual({ kind: "daily", time: "09:00" });
    expect(validSchedule({ kind: "once", at: "2026-09-27T10:00:00" })).toEqual({ kind: "once", at: "2026-09-27T10:00" });
    expect(validSchedule({ kind: "daily", time: "09:00", days: [5, 1, 1] })).toEqual({ kind: "daily", time: "09:00", days: [1, 5] });
    expect(validSchedule({ kind: "daily", time: "09:00", days: [0, 1, 2, 3, 4, 5, 6] })).toEqual({ kind: "daily", time: "09:00" });
    // Gemma 4 E2B, live, for "every Friday at 17:00".
    expect(validSchedule({ kind: "weekly", days: [5], time: "17:00" })).toEqual({ kind: "daily", time: "17:00", days: [5] });
    expect(() => validSchedule({ kind: "weekly", time: "17:00" })).toThrow(/weekly needs days/);
    for (const bad of [{ kind: "daily", time: "9:00" }, { kind: "daily", time: "24:00" }, { kind: "daily", time: "09:00", days: [7] }, { kind: "hourly", every: 0 }, { kind: "hourly", every: 0.5 }, { kind: "once", at: "tomorrow" }, { kind: "cron", expr: "* * * * *" }]) {
      expect(() => validSchedule(bad)).toThrow();
    }
  });

  it("finds the latest daily slot, skipping days not chosen", () => {
    const created = at(2026, 9, 20, 12);
    // Friday 25 Sep 2026, 10:00; weekdays only Mon (1) and Wed (3).
    expect(latestSlot({ kind: "daily", time: "09:00" }, created, at(2026, 9, 25, 10))).toBe(at(2026, 9, 25, 9));
    expect(latestSlot({ kind: "daily", time: "09:00" }, created, at(2026, 9, 25, 8))).toBe(at(2026, 9, 24, 9));
    expect(latestSlot({ kind: "daily", time: "09:00", days: [1, 3] }, created, at(2026, 9, 25, 10))).toBe(at(2026, 9, 23, 9));
    expect(latestSlot({ kind: "daily", time: "09:00" }, at(2026, 9, 25, 9, 30), at(2026, 9, 25, 10))).toBeNull();
    expect(nextSlot({ kind: "daily", time: "09:00", days: [1] }, created, at(2026, 9, 25, 10))).toBe(at(2026, 9, 28, 9));
  });

  it("counts hourly slots from when it was set up, and a one-off only once", () => {
    const created = at(2026, 9, 25, 8, 15);
    expect(latestSlot({ kind: "hourly", every: 2 }, created, created + HOUR)).toBeNull();
    expect(latestSlot({ kind: "hourly", every: 2 }, created, created + 5 * HOUR)).toBe(created + 4 * HOUR);
    const once = { kind: "once" as const, at: "2026-09-25T09:00" };
    expect(latestSlot(once, created, at(2026, 9, 25, 9, 1))).toBe(at(2026, 9, 25, 9));
    expect(latestSlot(once, at(2026, 9, 25, 9), at(2026, 9, 25, 10))).toBeNull();
  });
});

describe("the scheduler", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vunemi-auto-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const setup = (now: { t: number }, canStart = () => true) => {
    const file = join(dir, "automations.json");
    const store = new AutomationStore(file);
    const runs: string[] = [];
    let finish: (s: AutomationStatus) => void = () => {};
    const scheduler = new Scheduler({
      store, now: () => now.t, canStart,
      run: (item) => { runs.push(item.id); return new Promise((resolve) => { finish = resolve; }); },
    });
    return { store, runs, scheduler, file, finish: (s: AutomationStatus) => finish(s) };
  };

  it("runs a due slot once, even across a restart", async () => {
    const now = { t: at(2026, 9, 25, 8) };
    const a = setup(now);
    const item = a.store.add({ title: "Özet", task: "Takvimimi özetle", schedule: { kind: "daily", time: "09:00" } }, now.t);
    a.scheduler.tick();
    expect(a.runs).toEqual([]);
    now.t = at(2026, 9, 25, 9, 0, ) + 20_000;
    a.scheduler.tick();
    a.scheduler.tick();
    expect(a.runs).toEqual([item.id]);
    a.finish("done");
    await new Promise((r) => setTimeout(r, 0));
    expect(new AutomationStore(a.file).get(item.id)).toMatchObject({ lastSlot: at(2026, 9, 25, 9), lastStatus: "done" });
    // Vunemi restarts a minute later: the slot is spent.
    const b = setup(now);
    now.t += 60_000;
    b.scheduler.tick();
    expect(b.runs).toEqual([]);
  });

  it("waits while Vunemi is busy or locked, then runs the slot once", () => {
    const now = { t: at(2026, 9, 25, 8) };
    let free = false;
    const a = setup(now, () => free);
    a.store.add({ title: "x", task: "y", schedule: { kind: "daily", time: "09:00" } }, now.t);
    now.t = at(2026, 9, 25, 9, 5);
    a.scheduler.tick();
    expect(a.runs).toHaveLength(0);
    free = true;
    now.t = at(2026, 9, 25, 9, 30);
    a.scheduler.tick();
    expect(a.runs).toHaveLength(1);
  });

  it("records a slot missed long ago instead of running it late", () => {
    const now = { t: at(2026, 9, 24, 8) };
    const a = setup(now);
    const item = a.store.add({ title: "x", task: "y", schedule: { kind: "once", at: "2026-09-24T09:00" } }, now.t);
    now.t = at(2026, 9, 24, 9) + CATCH_UP_MS + 60_000;
    a.scheduler.tick();
    expect(a.runs).toEqual([]);
    expect(a.store.get(item.id)).toMatchObject({ lastStatus: "missed", enabled: false });
  });

  it("does not run a switched-off task, and runs one at a time", () => {
    const now = { t: at(2026, 9, 25, 8) };
    const a = setup(now);
    const off = a.store.add({ title: "off", task: "y", schedule: { kind: "daily", time: "09:00" } }, now.t);
    a.store.update(off.id, { enabled: false });
    const one = a.store.add({ title: "one", task: "y", schedule: { kind: "daily", time: "09:00" } }, now.t);
    const two = a.store.add({ title: "two", task: "y", schedule: { kind: "daily", time: "09:00" } }, now.t);
    now.t = at(2026, 9, 25, 9, 1);
    a.scheduler.tick();
    a.scheduler.tick();
    expect(a.runs).toEqual([one.id]);
    expect(a.scheduler.runNow(two.id)).toBe(false);
  });
});

describe("describing schedules", () => {
  afterEach(() => setLocale("en"));

  it("reads naturally in the user's language", () => {
    setLocale("en");
    expect(describeSchedule({ kind: "daily", time: "09:00" })).toBe("every day at 09:00");
    expect(describeSchedule({ kind: "hourly", every: 1 })).toBe("every hour");
    expect(describeSchedule({ kind: "hourly", every: 3 })).toBe("every 3 hours");
    expect(describeSchedule({ kind: "daily", time: "09:00", days: [1, 5] })).toBe("Mon, Fri at 09:00");
    setLocale("tr");
    expect(describeSchedule({ kind: "daily", time: "09:00" })).not.toBe("every day at 09:00");
  });
});

describe("the automation tools", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vunemi-auto-tools-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const tools = (t = at(2026, 9, 25, 8)) => {
    const store = new AutomationStore(join(dir, "automations.json"));
    const [create, list] = createAutomationTools(store, () => t);
    return { store, create: create!, list: list! };
  };
  const ctx = {} as never;

  it("always asks before setting one up, and shows what will run", async () => {
    const { create, list } = tools();
    expect(create.actionClass).toBe("write-local");
    expect(create.alwaysAsk).toBe(true);
    expect(list.actionClass).toBe("read");
    const preview = await create.preview!({ title: "Morning", task: "Summarise my calendar", schedule: { kind: "daily", time: "09:00" } });
    expect(preview).toContain("Morning");
    expect(preview).toContain("every day at 09:00");
    expect(preview).toContain("Summarise my calendar");
    expect(await create.preview!({ title: "x", task: "y", schedule: { kind: "cron" } })).toContain("unreadable time");
  });

  it("rejects bad input and times already past", async () => {
    const { create, store } = tools();
    await expect(create.run({ title: "x", task: "y", schedule: { kind: "hourly", every: 0 } }, ctx)).rejects.toThrow();
    await expect(create.run({ title: "", task: "y", schedule: { kind: "hourly", every: 1 } }, ctx)).rejects.toThrow();
    await expect(create.run({ title: "x", task: "y", schedule: { kind: "once", at: "2026-09-24T09:00" } }, ctx)).rejects.toThrow(/passed/);
    expect(store.list()).toEqual([]);
  });

  it("stores an approved task and lists it", async () => {
    const { create, list, store } = tools();
    const result = await create.run({ title: "Morning", task: "Summarise my calendar", schedule: { kind: "once", at: "2026-09-25T09:00" } }, ctx);
    expect(result).toContain("Scheduled");
    expect(store.list()).toHaveLength(1);
    expect(await list.run({}, ctx)).toContain("Summarise my calendar");
  });

  it("with the library on, needs a scope a scheduled task may have, and saves the time the user chose", async () => {
    const store = new AutomationStore(join(dir, "automations.json"));
    const chosen: unknown[] = [];
    const [create] = createAutomationTools(store, () => at(2026, 9, 25, 8), () => ({
      refuse: (scope) => (scope.includes("mail:send") ? 'A scheduled task can\'t have "mail:send".' : null),
      schedule: (args, asked) => (chosen.push(args.title), { ...asked, time: "07:15" } as typeof asked),
    }));
    const call = { title: "Morning", task: "Summarise my calendar", schedule: { kind: "daily", time: "09:00" }, scope: ["calendar:read"] };
    expect((create!.parameters as { required: string[] }).required).toContain("scope");
    // Refused before the user is asked anything.
    expect(await create!.check!({ ...call, scope: undefined })).toMatch(/scope is needed/);
    expect(await create!.check!({ ...call, scope: ["mail:send"] })).toMatch(/mail:send/);
    expect(await create!.check!(call)).toBeNull();
    await expect(create!.run({ ...call, scope: ["mail:send"] }, {} as never)).rejects.toThrow(/mail:send/);
    expect(store.list()).toHaveLength(0);

    const said = await create!.run(call, {} as never) as string;
    expect(store.list()[0]).toMatchObject({ title: "Morning", scope: ["calendar:read"], schedule: { kind: "daily", time: "07:15" } });
    expect(said).toContain("07:15");
    expect(chosen).toEqual(["Morning"]);
  });

  it("without the library, asks for no scope and saves none", async () => {
    const { store, create } = tools();
    expect((create.parameters as { required: string[]; properties: object }).required).toEqual(["title", "task", "schedule"]);
    expect(Object.keys((create.parameters as { properties: object }).properties)).toEqual(["title", "task", "schedule"]);
    expect(await create.check!({ title: "Morning", task: "Summarise", schedule: { kind: "daily", time: "09:00" } })).toBeNull();
    await create.run({ title: "Morning", task: "Summarise my calendar", schedule: { kind: "daily", time: "09:00" }, scope: ["mail:send"] }, {} as never);
    expect(store.list()[0]!.scope).toBeUndefined();
  });

  it("switches one off and deletes one on a card, and undoes both", async () => {
    const store = new AutomationStore(join(dir, "automations.json"));
    const [, list, set, remove] = createAutomationTools(store, () => at(2026, 9, 25, 8));
    const item = store.add({ title: "Morning", task: "Summarise", schedule: { kind: "daily", time: "09:00" } }, at(2026, 9, 25, 7));
    let changes = 0;
    store.onChange = () => changes++;
    const undos: (() => unknown)[] = [];
    const ctx = { offerUndo: (_label: string, run: () => unknown) => undos.push(run) } as never;
    expect(set!.alwaysAsk && remove!.alwaysAsk).toBe(true);
    expect(await list!.run({}, ctx)).toContain(`id: ${item.id}`);
    expect(await set!.preview!({ id: item.id, enabled: false })).toContain("Morning");

    await set!.run({ id: item.id, enabled: false }, ctx);
    expect(store.get(item.id)!.enabled).toBe(false);
    await undos.pop()!();
    expect(store.get(item.id)!.enabled).toBe(true);

    await remove!.run({ id: item.id }, ctx);
    expect(store.list()).toEqual([]);
    await undos.pop()!();
    expect(store.get(item.id)).toMatchObject({ title: "Morning", enabled: true });
    expect(changes).toBe(4);
    await expect(remove!.run({ id: "nope" }, ctx)).rejects.toThrow(/Nothing was changed/);
  });
});

describe("suggested tasks", () => {
  it("are Vunemi's own wording, daily, and nothing else can be named", () => {
    setLocale("en");
    expect(suggestion("morning-brief")).toMatchObject({ title: "Morning summary", schedule: { kind: "daily", time: "08:00" } });
    expect(suggestion("morning-brief").task).toMatch(/Only read/);
    expect(suggestion("awaiting-reply").schedule).toEqual({ kind: "daily", time: "08:30" });
    for (const bad of ["toString", "__proto__", "send-all", ""]) expect(() => suggestion(bad)).toThrow();
  });

  it("finish with their first line, short and plain", () => {
    expect(summaryLine("\n\n## **3 emails** are waiting for your reply.\n- Ada: invoice")).toBe("3 emails are waiting for your reply.");
    expect(summaryLine("")).toBe("");
    const long = summaryLine("x".repeat(500));
    expect(long).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("inside a scheduled run", () => {
  it("offers none of the scheduling tools, so the task is done rather than scheduled again", () => {
    // Gemma 4 E2B, live: running "summarise my calendar", it scheduled it again.
    const goal = scheduledGoal({ title: "Günlük Takvim Özeti", task: "Takvimimi özetle.", createdAt: 0 });
    const tools = createAutomationTools(new AutomationStore(join(mkdtempSync(join(tmpdir(), "vunemi-auto-")), "a.json")));
    expect(tools.length).toBe(4);
    for (const tool of tools) expect(tool.avoidFor?.test(goal)).toBe(true);
    // Asked by the user in chat: offered as usual.
    for (const tool of tools) expect(tool.avoidFor?.test("Her gün 09:00'da takvimimi özetle.")).toBe(false);
  });
});

describe("scope and limits", () => {
  it("keeps a task's scope, and checks it", () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-"));
    try {
      const file = join(dir, "scoped.json");
      const item = new AutomationStore(file).add({ title: "t", task: "x", schedule: { kind: "daily", time: "08:00" }, scope: ["calendar", "apps:notes"] }, 0);
      expect(new AutomationStore(file).get(item.id)!.scope).toEqual(["calendar", "apps:notes"]);
      expect(validScope(undefined)).toBeUndefined();
      expect(validScope(["mail", "mail"])).toEqual(["mail"]);
      expect(() => validScope([])).toThrow();
      expect(() => validScope(["mail send"])).toThrow();
      expect(() => validScope("mail")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the setup card says the task won't send, delete or pay", async () => {
    // Gemma 4 E2B, live: "every morning at 9 text Ayşe good morning" came to the card anyway.
    const dir = mkdtempSync(join(tmpdir(), "card-"));
    try {
      const create = createAutomationTools(new AutomationStore(join(dir, "a.json"))).find((x) => x.name === "automation_create")!;
      const card = await create.preview!({ title: "Günaydın", task: "Ayşe'ye günaydın mesajı at", schedule: { kind: "daily", time: "09:00" } });
      expect(card).toMatch(/won't send, delete or pay/);
      const dotted = await create.preview!({ title: "t", task: "Count today's events.", schedule: { kind: "daily", time: "09:00" } });
      expect(dotted).toContain("“Count today's events”. It won't");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tells the model a scheduled task can't send, delete or pay", () => {
    expect(AUTOMATION_INSTRUCTIONS).toMatch(/can't send, delete or pay/);
    expect(AUTOMATION_INSTRUCTIONS).not.toMatch(/wait for the user's approval/);
  });
});
