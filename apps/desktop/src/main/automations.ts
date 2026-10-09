/**
 * Tasks the user scheduled: "every morning at nine, summarise my calendar".
 * They run while Vunemi is open, one at a time, when nothing else is running.
 *
 * The slot is written down before a run starts, so a restart, a crash or a
 * Mac waking from sleep never runs the same slot twice. A slot missed by more
 * than a few hours (Vunemi was closed) is recorded as missed, not run late.
 * What a run may do is decided elsewhere (RunOptions.unattended): no plan
 * card, local changes follow the policy, and tools that send, delete or pay
 * are not loaded at all. A task with a scope gets only those connections.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeModelSpec, type ToolDef } from "@vunemi/agent-core";
import { formatDate, t } from "@vunemi/i18n";

export type Schedule =
  /** Once, at a local date and time "YYYY-MM-DDTHH:MM". */
  | { kind: "once"; at: string }
  /** Every day at "HH:MM" local time; `days` limits it to weekdays (0 = Sunday). */
  | { kind: "daily"; time: string; days?: number[] }
  /** Every `every` hours (1–24), counted from when it was set up. */
  | { kind: "hourly"; every: number };

export type AutomationStatus = "done" | "stopped" | "error" | "missed" | "noModel";

export interface Automation {
  id: string;
  title: string;
  /** What to do, in the user's words, as they approved it. */
  task: string;
  /**
   * Connection sources the task may use ("calendar", "apps:notes"); absent,
   * every connection that is on. Either way it never sends, deletes or pays.
   */
  scope?: string[];
  schedule: Schedule;
  enabled: boolean;
  createdAt: number;
  /** The last slot that was started or given up on. Never started twice. */
  lastSlot?: number;
  lastRunAt?: number;
  lastStatus?: AutomationStatus;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A slot older than this when Vunemi notices it is recorded as missed. */
export const CATCH_UP_MS = 12 * HOUR;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

const SOURCE = /^[a-z_]+(?::[a-z_]+)?$/;

/** A scope from a recipe or the summary screen; throws a plain reason. */
export function validScope(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 16 || !raw.every((s) => typeof s === "string" && SOURCE.test(s))) {
    throw new Error('scope must be a list of connection names such as "calendar" or "apps:notes".');
  }
  return [...new Set(raw as string[])];
}

/** Checks a schedule from the model or the UI; throws a plain reason. */
export function validSchedule(raw: unknown): Schedule {
  const s = raw as Partial<Schedule> & Record<string, unknown>;
  if (s?.kind === "once") {
    // Seconds of zero are how models write a time; nothing else is changed.
    const at = String(s.at ?? "").replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):00$/, "$1");
    if (!LOCAL.test(at) || Number.isNaN(localTime(at))) throw new Error('once needs at as local "YYYY-MM-DDTHH:MM".');
    return { kind: "once", at };
  }
  // "weekly" with days is how a model writes "every Friday": the same as daily on those days.
  if (s?.kind === "daily" || (s?.kind as string) === "weekly") {
    if ((s.kind as string) === "weekly" && !Array.isArray(s.days)) throw new Error("weekly needs days, weekday numbers 0 (Sunday) to 6.");
    const time = String(s.time ?? "");
    if (!TIME.test(time)) throw new Error('daily needs time as "HH:MM" (24-hour).');
    const days = s.days === undefined ? undefined : Array.isArray(s.days) ? [...new Set(s.days.map(Number))].sort() : null;
    if (days === null || days?.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || days?.length === 0) {
      throw new Error("days must be weekday numbers 0 (Sunday) to 6.");
    }
    return days && days.length < 7 ? { kind: "daily", time, days } : { kind: "daily", time };
  }
  if (s?.kind === "hourly") {
    const every = Number(s.every);
    if (!Number.isInteger(every) || every < 1 || every > 24) throw new Error("hourly needs every as a whole number of hours, 1 to 24.");
    return { kind: "hourly", every };
  }
  throw new Error('schedule.kind must be "once", "daily" or "hourly".');
}

function localTime(at: string): number {
  const m = LOCAL.exec(at);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
}

function dailyAt(day: Date, time: string): number {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
}

/** The most recent slot at or before `now` that is after `since`; null if none. */
export function latestSlot(schedule: Schedule, since: number, now: number): number | null {
  if (schedule.kind === "once") {
    const at = localTime(schedule.at);
    return at > since && at <= now ? at : null;
  }
  if (schedule.kind === "hourly") {
    const step = schedule.every * HOUR;
    const k = Math.floor((now - since) / step);
    return k >= 1 ? since + k * step : null;
  }
  for (let back = 0; back < 8; back++) {
    const day = new Date(now - back * DAY);
    const at = dailyAt(day, schedule.time);
    if (at > now || (schedule.days && !schedule.days.includes(day.getDay()))) continue;
    return at > since ? at : null;
  }
  return null;
}

/** The next slot after `now`, for showing; null when there is none. */
export function nextSlot(schedule: Schedule, since: number, now: number): number | null {
  if (schedule.kind === "once") {
    const at = localTime(schedule.at);
    return at > now && at > since ? at : null;
  }
  if (schedule.kind === "hourly") {
    const step = schedule.every * HOUR;
    return since + (Math.floor(Math.max(0, now - since) / step) + 1) * step;
  }
  for (let ahead = 0; ahead < 8; ahead++) {
    const day = new Date(now + ahead * DAY);
    const at = dailyAt(day, schedule.time);
    if (at <= now || (schedule.days && !schedule.days.includes(day.getDay()))) continue;
    return at;
  }
  return null;
}

export class AutomationStore {
  private items: Automation[];
  /** The model of the user's latest task; scheduled tasks run with it. */
  private lastModel: string | null;

  constructor(private readonly file: string) {
    const stored = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { items?: Automation[]; model?: string }) : {};
    this.items = Array.isArray(stored.items) ? stored.items : [];
    this.lastModel = typeof stored.model === "string" ? normalizeModelSpec(stored.model) : null;
  }

  get model(): string | null {
    return this.lastModel;
  }

  setModel(spec: string): void {
    if (spec === this.lastModel) return;
    this.lastModel = spec;
    this.save();
  }

  list(): Automation[] {
    return this.items.map((a) => ({ ...a }));
  }

  get(id: string): Automation | undefined {
    const found = this.items.find((a) => a.id === id);
    return found && { ...found };
  }

  add(input: { title: string; task: string; schedule: Schedule; scope?: string[] }, now: number): Automation {
    const scope = validScope(input.scope);
    const item: Automation = { id: randomUUID(), title: input.title, task: input.task, ...(scope && { scope }), schedule: input.schedule, enabled: true, createdAt: now };
    this.items.push(item);
    this.save();
    return { ...item };
  }

  update(id: string, change: Partial<Pick<Automation, "enabled" | "lastSlot" | "lastRunAt" | "lastStatus">>): void {
    const item = this.items.find((a) => a.id === id);
    if (!item) return;
    Object.assign(item, change);
    this.save();
  }

  remove(id: string): void {
    this.items = this.items.filter((a) => a.id !== id);
    this.save();
  }

  /** Undo of a removal: the same task, same id and history, back in its place. */
  restore(item: Automation): void {
    if (this.items.some((a) => a.id === item.id)) return;
    this.items.push({ ...item });
    this.items.sort((a, b) => a.createdAt - b.createdAt);
    this.save();
  }

  /** Told after every write, whoever made it: Settings, the scheduler or a tool. */
  onChange?: () => void;

  /** Written whole to a new file, then renamed over the old: a crash leaves one or the other. */
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ items: this.items, ...(this.lastModel && { model: this.lastModel }) }, null, 2));
    renameSync(tmp, this.file);
    this.onChange?.();
  }
}

export interface SchedulerDeps {
  store: AutomationStore;
  now(): number;
  /** Unlocked, nothing running, nothing queued, a model chosen. */
  canStart(): boolean;
  /** Starts the run; resolves with how it ended. */
  run(item: Automation): Promise<AutomationStatus>;
  onChange?(): void;
}

export class Scheduler {
  private running: string | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

  get busy(): boolean {
    return this.running !== null;
  }

  /** Called every half minute and on wake: starts at most one due task. */
  tick(): void {
    const now = this.deps.now();
    for (const item of this.deps.store.list()) {
      if (!item.enabled) continue;
      const slot = latestSlot(item.schedule, Math.max(item.createdAt, item.lastSlot ?? 0), now);
      if (slot === null) continue;
      if (now - slot > CATCH_UP_MS) {
        this.deps.store.update(item.id, { lastSlot: slot, lastStatus: "missed", ...(item.schedule.kind === "once" && { enabled: false }) });
        this.deps.onChange?.();
        continue;
      }
      if (this.running || !this.deps.canStart()) return;
      this.start(item, slot);
      return;
    }
  }

  /** "Run now" from the list; the schedule itself is untouched. */
  runNow(id: string): boolean {
    const item = this.deps.store.get(id);
    if (!item || this.running || !this.deps.canStart()) return false;
    this.start(item, null);
    return true;
  }

  private start(item: Automation, slot: number | null): void {
    this.running = item.id;
    const now = this.deps.now();
    // Written before the run starts: whatever happens next, this slot is spent.
    this.deps.store.update(item.id, { ...(slot !== null && { lastSlot: slot }), lastRunAt: now });
    this.deps.onChange?.();
    void this.deps
      .run(item)
      .catch((): AutomationStatus => "error")
      .then((status) => {
        this.deps.store.update(item.id, { lastStatus: status });
        // A task that was due once is finished once it has run.
        if (item.schedule.kind === "once" && slot !== null) this.deps.store.update(item.id, { enabled: false });
        this.running = null;
        this.deps.onChange?.();
      });
  }
}

/** A schedule in the user's language, for the card and the list. */
export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === "once") {
    const at = localTime(schedule.at);
    return t("automations.when.once", { at: formatDate(at, { dateStyle: "medium", timeStyle: "short" }) });
  }
  if (schedule.kind === "hourly") return t("automations.when.hourly", { count: schedule.every });
  if (!schedule.days) return t("automations.when.daily", { time: schedule.time });
  // 4–10 Jan 2021 is a Monday-to-Sunday week; 3 Jan is the Sunday before.
  const days = schedule.days.map((d) => formatDate(new Date(2021, 0, 3 + d), { weekday: "short" })).join(", ");
  return t("automations.when.days", { days, time: schedule.time });
}

/**
 * Tasks Vunemi offers in Settings, in its own words: the window names one,
 * it can't supply a task. Both only read.
 */
export const SUGGESTIONS = {
  "awaiting-reply": { key: "awaiting", time: "08:30" },
  "morning-brief": { key: "morning", time: "08:00" },
} as const;
export type SuggestionId = keyof typeof SUGGESTIONS;

export function suggestion(id: string): { title: string; task: string; schedule: Schedule } {
  if (!Object.hasOwn(SUGGESTIONS, id)) throw new Error(t("automations.suggest.unknown"));
  const { key, time } = SUGGESTIONS[id as SuggestionId];
  return { title: t(`automations.suggest.${key}.title`), task: t(`automations.suggest.${key}.task`), schedule: { kind: "daily", time } };
}

/** The first thing a finished task said, short enough for a notification. */
export function summaryLine(answer: string, max = 200): string {
  const line = answer.split("\n").map((l) => l.replace(/^[#>*\-\s]+|[*_`]+/g, "").trim()).find((l) => l.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export const AUTOMATION_INSTRUCTIONS = `Scheduled tasks:
- Only when the user asks for something to happen later or repeatedly ("every morning", "tomorrow at 9"), call automation_create with a short title, the task in the user's words, and the schedule. Never set one up on your own initiative. The user approves it on a card.
- Times are the user's local time. A task runs while Vunemi is open. A scheduled task can't send, delete or pay: if what the user wants needs that (mail someone, delete old files), say it can't be scheduled and why, and don't call automation_create.
- automation_list shows what is scheduled, with ids. automation_set switches one off or on; automation_delete deletes one. Both are approved on a card and can be undone. Changing a task's text or time is done by the user in Settings › Scheduled tasks.`;

/** How a scheduled run's goal begins; the scheduling tools stand aside for it. */
export const SCHEDULED_RUN = "Scheduled task running now:";

/** The goal a scheduled run is started with. */
export function scheduledGoal(item: Pick<Automation, "title" | "task" | "createdAt">): string {
  return `${SCHEDULED_RUN} "${item.title}", set up by the user on ${new Date(item.createdAt).toDateString()}. Do the task itself now; it is already scheduled, so don't schedule anything:\n${item.task}`;
}

/**
 * Inside a scheduled run the scheduling tools aren't offered: told "Scheduled
 * task … Do it now: summarise my calendar", Gemma 4 E2B scheduled it again
 * instead of summarising.
 */
const IN_SCHEDULED_RUN = new RegExp(`^${SCHEDULED_RUN}`);

/**
 * What setting a task up from chat needs once the automation library is on:
 * the task names the connection parts its runs may use, and code decides
 * whether a scheduled task may have them.
 */
export interface AutomationSetup {
  /** Why a scheduled task can't have this scope, in words for the model; null when it can. */
  refuse(scope: string[]): string | null;
  /** The schedule to save: the one asked for, or with the time and days the user chose on the summary. */
  schedule(args: Record<string, unknown>, asked: Schedule): Schedule;
}

/** With `setup`, a task is set up with a scope and the user approves it on a summary made from that scope. */
export function createAutomationTools(store: AutomationStore, now: () => number = Date.now, setup?: () => AutomationSetup): ToolDef[] {
  /** The scope a call names; it has to name one when the library is on. */
  const scopeOf = (a: Record<string, unknown>): string[] | undefined => {
    if (!setup) return undefined;
    const scope = validScope(a.scope);
    if (!scope) throw new Error('scope is needed: the connection parts the task uses, e.g. ["calendar:read"].');
    const refused = setup().refuse(scope);
    if (refused) throw new Error(refused);
    return scope;
  };
  return [
    {
      name: "automation_create",
      avoidFor: IN_SCHEDULED_RUN,
      description: "Schedule a task the user asked for, to run later or repeatedly while Vunemi is open. The user approves it first.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "A few words, e.g. \"Morning calendar summary\"" },
          task: { type: "string", description: "What to do each time, in the user's words" },
          schedule: {
            type: "object",
            description: 'One of {"kind":"once","at":"2026-09-26T09:00"}, {"kind":"daily","time":"09:00","days":[1,2,3,4,5]} (0 = Sunday, days optional), {"kind":"hourly","every":3}',
          },
          ...(setup && {
            scope: {
              type: "array",
              items: { type: "string" },
              description: 'The connection parts each run may use, and no more, e.g. ["calendar:read","mail:read"]. Parts: calendar:read, reminders:read, mail:read, apps:notes, files:read, files:write, browser:read.',
            },
            explanation: { type: "string", description: "One or two plain sentences for the user, in their language: what it does each time and what it touches." },
          }),
        },
        required: ["title", "task", "schedule", ...(setup ? ["scope"] : [])],
      },
      actionClass: "write-local",
      alwaysAsk: true,
      // A scope a scheduled task may not have is refused before the user is asked anything.
      check: (a) => {
        try {
          scopeOf(a);
          return null;
        } catch (e) {
          return (e as Error).message;
        }
      },
      preview: async (a) => {
        let when: string;
        try {
          when = describeSchedule(validSchedule(a.schedule));
        } catch {
          // The run will refuse it; the card says so rather than hide it behind "?".
          when = t("automations.badSchedule");
        }
        return t("automations.preview", { title: String(a.title ?? "").slice(0, 80), when, task: String(a.task ?? "").slice(0, 400).replace(/[.。]+\s*$/, "") });
      },
      async run(a) {
        const title = String(a.title ?? "").trim();
        const task = String(a.task ?? "").trim();
        if (!title || title.length > 80) throw new Error("title must be 1 to 80 characters.");
        if (!task || task.length > 2000) throw new Error("task must be 1 to 2000 characters.");
        // Checked again here: the summary shows the scope, it does not decide.
        const scope = scopeOf(a);
        const asked = validSchedule(a.schedule);
        const schedule = setup ? setup().schedule(a, asked) : asked;
        const created = now();
        const next = nextSlot(schedule, created, created);
        if (next === null) throw new Error("That time has already passed; give a time in the future.");
        const item = store.add({ title, task, schedule, ...(scope && { scope }) }, created);
        return `Scheduled "${item.title}" (${JSON.stringify(schedule)}). Next run: ${new Date(next).toString()}. It runs while Vunemi is open and can't send, delete or pay; if the task needs that, tell the user that part won't be done.`;
      },
    },
    {
      name: "automation_list",
      avoidFor: IN_SCHEDULED_RUN,
      description: "List the scheduled tasks: title, when, on or off, last result.",
      parameters: { type: "object", properties: {} },
      actionClass: "read",
      async run() {
        const items = store.list();
        if (items.length === 0) return "No scheduled tasks.";
        const at = now();
        return items
          .map((item) => {
            const next = item.enabled ? nextSlot(item.schedule, Math.max(item.createdAt, item.lastSlot ?? 0), at) : null;
            return `- ${item.title}: ${JSON.stringify(item.schedule)}; ${item.enabled ? "on" : "off"}${next ? `; next ${new Date(next).toString()}` : ""}${item.lastStatus ? `; last ${item.lastStatus}` : ""}\n  Task: ${item.task}\n  id: ${item.id}`;
          })
          .join("\n");
      },
    },
    {
      name: "automation_set",
      avoidFor: IN_SCHEDULED_RUN,
      description: "Switch one scheduled task off or back on, by the id automation_list shows. The user approves it on a card and can undo it.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The task's id, from automation_list." },
          enabled: { type: "boolean", description: "false to switch it off, true to switch it on." },
        },
        required: ["id", "enabled"],
      },
      actionClass: "write-local",
      alwaysAsk: true,
      preview: async (a) => {
        const item = store.get(String(a.id));
        return t(a.enabled === false ? "automations.previewOff" : "automations.previewOn", { title: item?.title ?? "?" });
      },
      async run(a, ctx) {
        const item = known(String(a.id));
        const enabled = a.enabled !== false;
        if (item.enabled === enabled) return `"${item.title}" is already ${enabled ? "on" : "off"}. Nothing was changed.`;
        store.update(item.id, { enabled });
        ctx.offerUndo(t(enabled ? "automations.undoOn" : "automations.undoOff", { title: item.title }), async () => {
          store.update(item.id, { enabled: !enabled });
        });
        return `"${item.title}" switched ${enabled ? "on" : "off"}. The user can undo it from the activity log.`;
      },
    },
    {
      name: "automation_delete",
      avoidFor: IN_SCHEDULED_RUN,
      description: "Delete one scheduled task, by the id automation_list shows. The user approves it on a card and can put it back.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "The task's id, from automation_list." } },
        required: ["id"],
      },
      actionClass: "write-local",
      alwaysAsk: true,
      preview: async (a) => {
        const item = store.get(String(a.id));
        return t("automations.previewDelete", { title: item?.title ?? "?", when: item ? describeSchedule(item.schedule) : "?" });
      },
      async run(a, ctx) {
        const item = known(String(a.id));
        store.remove(item.id);
        ctx.offerUndo(t("automations.undoDelete", { title: item.title }), async () => store.restore(item));
        return `Deleted the scheduled task "${item.title}". The user can put it back from the activity log.`;
      },
    },
  ];

  function known(id: string): Automation {
    const item = store.get(id);
    if (!item) throw new Error("No scheduled task has that id; automation_list shows them. Nothing was changed.");
    return item;
  }
}

