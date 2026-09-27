/**
 * The calendar channel. What is worth testing here is not EventKit — that is
 * Apple's — but the three things this side decides: that a missing permission
 * is reported instead of looking like an empty calendar, that every write can
 * be undone, and that a date the model wrote turns into the hour a person meant.
 */
import type { Produced, ToolContext, ToolDef } from "@vunemi/agent-core";
import { beforeEach, describe, expect, it } from "vitest";
import { createCalendarTools, Helper } from "../src/index.js";

const undos: { label: string; run: () => Promise<void> | void }[] = [];

const made: Produced[] = [];

const ctx = (): ToolContext => ({
  signal: new AbortController().signal,
  handoff: async () => true,
  offerUndo: (label, run) => undos.push({ label, run }),
  attach: () => {},
  produced: (item) => made.push(item),
});

/** Answers like the helper does, and remembers what it was asked. */
class FakeHelper extends Helper {
  calls: { op: string; args: Record<string, unknown> }[] = [];
  calendars = true;
  reminders = true;
  granted = false;
  events: Record<string, unknown>[] = [];
  items: Record<string, unknown>[] = [];
  eventsError: Error | null = null;

  constructor() {
    super("/does/not/exist");
  }

  override get installed(): boolean {
    return true;
  }

  override async permissions() {
    return { accessibility: true, screenRecording: false, calendars: this.calendars, reminders: this.reminders };
  }

  override async call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ op, args });
    switch (op) {
      case "request_calendar":
        return { granted: this.granted };
      case "events":
        if (this.eventsError) throw this.eventsError;
        return { events: this.events };
      case "event_get":
      case "event_delete": {
        const found = this.events.find((e) => e.id === args.id);
        if (!found) throw new Error("O etkinlik yok ya da silinmiş.");
        return found;
      }
      case "event_update": {
        const found = this.events.find((e) => e.id === args.id);
        if (!found) throw new Error("O etkinlik yok ya da silinmiş.");
        const before = { ...found };
        const { id: _id, ...fields } = args;
        for (const [key, value] of Object.entries(fields)) {
          if (value === "") delete found[key];
          else found[key] = value;
        }
        return { before, after: { ...found } };
      }
      case "reminder_get":
      case "reminder_delete": {
        const found = this.items.find((e) => e.id === args.id);
        if (!found) throw new Error("O anımsatıcı yok ya da silinmiş.");
        if (op === "reminder_delete") this.items = this.items.filter((e) => e !== found);
        return found;
      }
      case "reminder_update": {
        const found = this.items.find((e) => e.id === args.id)!;
        const before = { ...found };
        const { id: _id, ...fields } = args;
        for (const [key, value] of Object.entries(fields)) {
          if (value === "") delete found[key];
          else found[key] = value;
        }
        return { before, after: { ...found } };
      }
      case "reminders":
        return { reminders: this.items };
      case "event_create":
        return { id: "EV-1", title: args.title, start: args.start, end: args.end, allDay: false, calendar: "İş" };
      case "reminder_create":
        return { id: "RE-1", title: args.title, completed: false, list: "Anımsatıcılar", due: args.due };
      case "reminder_complete":
        return { id: args.id, title: "Süt al", completed: args.completed };
      default:
        return {};
    }
  }
}

describe("calendar tools", () => {
  let helper: FakeHelper;
  let tools: Map<string, ToolDef>;

  beforeEach(() => {
    undos.length = 0;
    made.length = 0;
    helper = new FakeHelper();
    tools = new Map(createCalendarTools({ helper }).map((t) => [t.name, t]));
  });

  const call = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.run(args as never, ctx());

  it("looks at the day before adding: refuses a twin, reports a clash, rejects an end before the start", async () => {
    helper.events = [
      { id: "E1", title: "Dişçi", start: "2026-10-02T10:00:00+03:00", end: "2026-10-02T11:00:00+03:00", allDay: false, calendar: "Ev" },
      { id: "E2", title: "Toplantı", start: "2026-10-02T14:30:00+03:00", end: "2026-10-02T15:30:00+03:00", allDay: false, calendar: "İş" },
    ];
    await expect(call("calendar_create", { title: "dişçi ", start: "2026-10-02T10:00:00+03:00" })).rejects.toThrow(/Dişçi/);
    expect(await call("calendar_create", { title: "Kahve", start: "2026-10-02T14:00:00+03:00" })).toMatch(/overlaps with:[\s\S]*Toplantı/);
    await expect(call("calendar_create", { title: "Ters", start: "2026-10-02T14:00:00+03:00", end: "2026-10-02T13:00:00+03:00" })).rejects.toThrow();
    expect(helper.calls.filter((c) => c.op === "event_create")).toHaveLength(1);
  });

  it("leaves out what ended as the range began, like yesterday's all-day event", async () => {
    helper.events = [
      { id: "Y", title: "Dünkü", start: "2026-09-25T00:00:00+01:00", end: "2026-09-26T00:00:00+01:00", allDay: true, calendar: "Ev" },
      { id: "T", title: "Bugünkü", start: "2026-09-26T10:00:00+01:00", end: "2026-09-26T11:00:00+01:00", allDay: false, calendar: "Ev" },
    ];
    const out = await call("calendar_events", { start: "2026-09-26T00:00:00+01:00", end: "2026-09-27T00:00:00+01:00" });
    expect(out).toContain("Bugünkü");
    expect(out).not.toContain("Dünkü");
    expect(out).toMatch(/1 events/);
  });

  it("reads a start alone as that day, not the week after it", async () => {
    await call("calendar_events", { start: "2026-09-27T10:00:00" });
    const asked = helper.calls.filter((c) => c.op === "events").at(-1)!.args as { start: string; end: string };
    expect(new Date(asked.end).getTime()).toBe(new Date(2026, 8, 28).getTime());
  });

  it("deletes one plain event on a card, and can put it back", async () => {
    helper.events = [{ id: "D", title: "Dişçi", start: "2026-09-27T10:00:00+01:00", end: "2026-09-27T11:00:00+01:00", allDay: false, calendar: "Ev", notes: "2. kat" }];
    const undos: { undo: () => Promise<void> }[] = [];
    const out = await tools.get("calendar_delete")!.run({ id: "D" } as never, { ...ctx(), offerUndo: (_label: string, undo: () => Promise<void>) => undos.push({ undo }) } as never);
    expect(out).toMatch(/^Deleted: .*Dişçi/);
    expect(helper.calls.filter((c) => c.op === "event_delete")).toHaveLength(1);
    expect(tools.get("calendar_delete")!.alwaysAsk).toBe(true);
    await undos[0]!.undo();
    expect(helper.calls.at(-1)).toMatchObject({ op: "event_create", args: { title: "Dişçi", start: "2026-09-27T10:00:00+01:00", calendar: "Ev", notes: "2. kat" } });
  });

  it("won't delete a meeting, a repeating event, or one in a calendar that can't change", async () => {
    for (const [event, why] of [
      [{ id: "M", title: "Toplantı", allDay: false, calendar: "İş", attendees: ["Ayşe"] }, /iptal/],
      [{ id: "R", title: "Spor", allDay: false, calendar: "Ev", recurring: true }, /tekrarlayan/],
      [{ id: "H", title: "Bayram", allDay: true, calendar: "Tatiller", writable: false }, /değiştirilemeyen/],
    ] as const) {
      helper.events = [event as never];
      await expect(call("calendar_delete", { id: event.id })).rejects.toThrow(why);
    }
    expect(helper.calls.some((c) => c.op === "event_delete")).toBe(false);
  });

  it("moves an event on a card, keeping its length, and can move it back", async () => {
    helper.events = [{ id: "D", title: "Dişçi", start: "2026-09-27T10:00:00+01:00", end: "2026-09-27T11:00:00+01:00", allDay: false, calendar: "Ev", location: "Kadıköy" }];
    const update = tools.get("calendar_update")!;
    expect(update.alwaysAsk).toBe(true);
    const card = await update.preview!({ id: "D", start: "2026-09-27T15:00:00+01:00", location: "" } as never);
    expect(card).toMatch(/Dişçi/);
    expect(card).toMatch(/\(boş\)/);
    const out = await call("calendar_update", { id: "D", start: "2026-09-27T15:00:00+01:00", location: "" });
    expect(out).toMatch(/^Changed: /);
    const sent = helper.calls.find((c) => c.op === "event_update")!.args as Record<string, string>;
    expect(new Date(sent.end!).getTime() - new Date(sent.start!).getTime()).toBe(60 * 60 * 1000);
    expect(sent.location).toBe("");
    expect(sent).not.toHaveProperty("title");
    await undos.at(-1)!.run();
    expect(helper.events[0]).toMatchObject({ start: "2026-09-27T10:00:00+01:00", end: "2026-09-27T11:00:00+01:00", location: "Kadıköy" });
  });

  it("won't change a meeting or a repeating event, or change nothing", async () => {
    helper.events = [
      { id: "M", title: "Toplantı", allDay: false, calendar: "İş", attendees: ["Ayşe"] },
      { id: "R", title: "Spor", allDay: false, calendar: "Ev", recurring: true },
      { id: "S", title: "Aynı", start: "2026-09-27T10:00:00+01:00", end: "2026-09-27T11:00:00+01:00", allDay: false, calendar: "Ev" },
    ];
    await expect(call("calendar_update", { id: "M", title: "x" })).rejects.toThrow(/bildirim/);
    await expect(call("calendar_update", { id: "R", title: "x" })).rejects.toThrow(/tekrarlayan/);
    await expect(call("calendar_update", { id: "S", title: "Aynı" })).rejects.toThrow(/Hiçbir şey değişmedi/);
    await expect(call("calendar_update", { id: "S", end: "2026-09-27T09:00:00+01:00" })).rejects.toThrow();
    expect(helper.calls.some((c) => c.op === "event_update")).toBe(false);
  });

  it("changes and deletes a reminder on a card, and undoes both", async () => {
    helper.items = [{ id: "R1", title: "Süt al", completed: false, list: "Market", due: "2026-09-27T09:00:00+01:00" }];
    expect(await tools.get("reminder_update")!.preview!({ id: "R1", title: "Süt ve ekmek al" } as never)).toMatch(/Süt al/);
    await call("reminder_update", { id: "R1", title: "Süt ve ekmek al", due: "" });
    expect(helper.items[0]).toMatchObject({ title: "Süt ve ekmek al" });
    expect(helper.items[0]).not.toHaveProperty("due");
    await undos.at(-1)!.run();
    expect(helper.items[0]).toMatchObject({ title: "Süt al", due: "2026-09-27T09:00:00+01:00" });

    helper.items = [{ id: "R2", title: "Fatura", completed: true, list: "Ev" }];
    expect(tools.get("reminder_delete")!.alwaysAsk).toBe(true);
    expect(await call("reminder_delete", { id: "R2" })).toMatch(/^Deleted: /);
    expect(helper.items).toHaveLength(0);
    await undos.at(-1)!.run();
    expect(helper.calls.at(-2)).toMatchObject({ op: "reminder_create", args: { title: "Fatura", list: "Ev" } });
    expect(helper.calls.at(-1)).toMatchObject({ op: "reminder_complete", args: { completed: true } });
  });

  it("gives an all-day event that runs into today both its days", async () => {
    helper.events = [
      { id: "M", title: "Tatil", start: "2026-09-25T00:00:00", end: "2026-09-27T00:00:00", allDay: true, calendar: "Ev" },
      { id: "O", title: "Tek gün", start: "2026-09-26T00:00:00", end: "2026-09-26T23:59:59", allDay: true, calendar: "Ev" },
    ];
    const out = await call("calendar_events", { start: "2026-09-26T00:00:00", end: "2026-09-27T00:00:00" });
    expect(out).toMatch(/25 September 2026 – [^\n]*26 September 2026 \(all day\) — Tatil/);
    expect(out).toMatch(/Saturday, 26 September 2026 \(all day\) — Tek gün/);
  });

  it("warns on the card about a date in the past", async () => {
    const card = await tools.get("calendar_create")!.preview!({ title: "Eski", start: "2020-01-01T09:00" } as never);
    expect(card).toMatch(/⚠/);
    expect(await tools.get("calendar_create")!.preview!({ title: "Yeni", start: "2099-01-01T09:00" } as never)).not.toMatch(/⚠/);
  });

  it("refuses a second open reminder with the same title, and names the one a card completes", async () => {
    helper.items = [{ id: "R9", title: "Süt al", completed: false, list: "Market" }];
    await expect(call("reminder_create", { title: "süt al" })).rejects.toThrow(/Market/);
    await expect(call("reminder_create", { title: "x", due: "yarın" })).rejects.toThrow();
    expect(helper.calls.some((c) => c.op === "reminder_create")).toBe(false);
    await call("reminders_list", {});
    expect(await tools.get("reminder_done")!.preview!({ id: "R9" } as never)).toContain("Süt al");
    expect(await call("reminder_create", { title: "Ekmek al" })).toMatch(/^Added: /);
  });

  it("says the permission is missing rather than reporting an empty calendar", async () => {
    helper.calendars = false;
    helper.granted = false;
    await expect(call("calendar_events", { days: 7 })).rejects.toThrow(/System Settings.*Calendars/s);
    // It asked once, and it never pretended to read anything.
    expect(helper.calls.filter((c) => c.op === "request_calendar")).toHaveLength(1);
    expect(helper.calls.some((c) => c.op === "events")).toBe(false);
  });

  it("carries on when the user grants the permission at the prompt", async () => {
    helper.calendars = false;
    helper.granted = true;
    await expect(call("calendar_events", { days: 1 })).resolves.toContain("no events");
    expect(helper.calls.some((c) => c.op === "events")).toBe(true);
  });

  it("reads only today for days zero and preserves a helper failure", async () => {
    const today = new Date();
    await call("calendar_events", { days: 0 });
    const sent = helper.calls.find((c) => c.op === "events")!.args;
    const start = new Date(String(sent.start));
    const end = new Date(String(sent.end));
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours()]).toEqual([
      today.getFullYear(), today.getMonth(), today.getDate(), 0,
    ]);
    expect(end.getTime()).toBe(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime());

    helper.eventsError = new Error("Başlangıç okunabilir bir tarih değil");
    await expect(call("calendar_events", { days: 0 })).rejects.toThrow(/Başlangıç okunabilir/);
  });

  it("asks for the calendar and the reminders separately", async () => {
    helper.reminders = false;
    helper.granted = false;
    await expect(call("reminders_list")).rejects.toThrow(/Anımsatıcılar/);
    expect(helper.calls.find((c) => c.op === "request_calendar")?.args).toEqual({ kind: "reminder" });
  });

  it("treats what an event says as someone else's writing", () => {
    expect(tools.get("calendar_events")!.untrustedOutput).toBe(true);
    expect(tools.get("reminders_list")!.untrustedOutput).toBe(true);
    expect(tools.get("calendar_events")!.actionClass).toBe("read");
  });

  it("calls creating an event a local write, because it can reach nobody", () => {
    for (const name of ["calendar_create", "reminder_create", "reminder_done"]) {
      expect(tools.get(name)!.actionClass).toBe("write-local");
    }
  });

  it("sends the local hour the user meant, not a UTC instant", async () => {
    await call("calendar_create", { title: "Diş hekimi", start: "2026-09-25T14:00" });
    const sent = helper.calls.find((c) => c.op === "event_create")!.args;
    // 14:00 local, whatever this machine's zone is — the offset says which.
    expect(sent.start).toMatch(/^2026-09-25T14:00:00[+-]\d\d:\d\d$/);
    // An event with no end lasts an hour.
    expect(sent.end).toMatch(/^2026-09-25T15:00:00[+-]\d\d:\d\d$/);
  });

  it("announces what it created, as EventKit stored it", async () => {
    await call("calendar_create", { title: "Diş hekimi", start: "2026-09-25T14:00" });
    await call("reminder_create", { title: "Süt al" });
    // Completing a reminder changes one; it does not make one.
    await call("reminder_done", { id: "RE-1" });
    expect(made).toEqual([
      { kind: "event", title: "Diş hekimi", start: expect.stringMatching(/^2026-09-25T14:00:00/), calendar: "İş" },
      { kind: "reminder", title: "Süt al", list: "Anımsatıcılar" },
    ]);
  });

  it("offers to take back everything it writes", async () => {
    await call("calendar_create", { title: "Diş hekimi", start: "2026-09-25T14:00" });
    await call("reminder_create", { title: "Süt al" });
    await call("reminder_done", { id: "RE-1" });
    expect(undos.map((u) => u.label)).toEqual([
      expect.stringContaining("takvimden silinsin"),
      expect.stringContaining("anımsatıcısı silinsin"),
      expect.stringContaining("yeniden açılsın"),
    ]);

    for (const undo of undos) await undo.run();
    const after = helper.calls.slice(-3).map((c) => [c.op, c.args]);
    expect(after).toEqual([
      ["event_remove", { id: "EV-1" }],
      ["reminder_remove", { id: "RE-1" }],
      // Undoing a completion reopens it; it does not delete the reminder.
      ["reminder_complete", { id: "RE-1", completed: false }],
    ]);
  });

  it("refuses a date it cannot read instead of inventing one", async () => {
    await expect(call("calendar_create", { title: "x", start: "önümüzdeki salı" })).rejects.toThrow(/okunabilir bir tarih değil/);
    await expect(call("calendar_events", { start: "yarın" })).rejects.toThrow(/okunabilir bir tarih değil/);
  });

  it("looks backwards when asked for negative days, and never past the clamp", async () => {
    await call("calendar_events", { days: -3 });
    const back = helper.calls.find((c) => c.op === "events")!.args;
    expect(new Date(String(back.end)).getTime()).toBeGreaterThan(new Date(String(back.start)).getTime());
    expect(new Date(String(back.start)).getTime()).toBeLessThan(Date.now());

    helper.calls.length = 0;
    await call("calendar_events", { days: 99_999 });
    const far = helper.calls.find((c) => c.op === "events")!.args;
    const span = (new Date(String(far.end)).getTime() - new Date(String(far.start)).getTime()) / 86_400_000;
    expect(span).toBeLessThanOrEqual(370);
  });

  it("gives the model today's date, so it stops guessing what 'tomorrow' is", async () => {
    const out = await call("calendar_events", { days: 2 });
    expect(out).toMatch(/^Today is /);
  });

  it("shows an event with its id, so a later call can name it", async () => {
    helper.events = [
      {
        id: "EV-9",
        title: "Sprint planlama",
        start: "2026-09-25T09:00:00+03:00",
        end: "2026-09-25T10:00:00+03:00",
        allDay: false,
        calendar: "İş",
        attendees: ["Ayşe", "Mehmet"],
      },
    ];
    const out = await call("calendar_events", { start: "2026-09-25T00:00:00+03:00", end: "2026-09-26T00:00:00+03:00" });
    expect(out).toContain("Sprint planlama");
    expect(out).toContain("id: EV-9");
    expect(out).toContain("Ayşe");
  });
});
