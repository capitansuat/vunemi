/**
 * Shortcuts that Vunemi builds: a short list of steps, each from a fixed
 * menu of blocks, compiled here into a Shortcuts file.
 *
 * Nobody writes the file but this code, and it knows only the blocks below:
 * asking and taking text, changing text, dates, reading and adding calendar
 * events and reminders, writing notes, and showing a result. There is no
 * block that sends a message or mail, runs a script, fetches from a URL,
 * deletes anything or changes a system setting, so a shortcut made here
 * cannot do those, whatever asked for it: a recipe, or a model reading a
 * page that tells it to.
 *
 * The file format is Apple's and not documented; each block is one action
 * identifier with the parameters observed to work. A macOS release can
 * change them, which is why what a shortcut does is checked by running it
 * (docs/CANLI-TEST) and not by reading it back.
 */

import { t } from "@vunemi/i18n";

export type ShortcutStep =
  /** Asks the person running it for a line of text. */
  | { block: "ask"; prompt: string }
  /** The text the shortcut was given (from the Share menu, another shortcut, or `shortcuts run`). */
  | { block: "input" }
  | { block: "today" }
  | { block: "case"; of: number; to: "upper" | "lower" | "title" }
  /** Text with earlier results in it: "{1} on {3}". */
  | { block: "combine"; text: string }
  | { block: "replace"; of: number; find: string; with: string }
  | { block: "addToDate"; of: number; amount: number; unit: "hours" | "days" | "weeks" }
  | { block: "formatDate"; of: number; style: "short" | "medium" | "long" }
  | { block: "events"; day: "today" | "tomorrow" }
  | { block: "addEvent"; title: string; start: number; minutes: number }
  | { block: "reminders" }
  | { block: "addReminder"; title: string }
  | { block: "createNote"; text: string }
  /** Adds to the note with this name. */
  | { block: "appendNote"; note: string; text: string }
  | { block: "show"; text: string }
  | { block: "notify"; text: string }
  | { block: "copy"; text: string }
  | { block: "speak"; text: string }
  /** What the shortcut hands back to whatever ran it. */
  | { block: "result"; text: string };

export type ShortcutBlock = ShortcutStep["block"];

export interface ShortcutDraft {
  name: string;
  steps: ShortcutStep[];
}

export const SHORTCUT_MAX_STEPS = 12;
const MAX_TEXT = 300;
const MAX_NAME = 60;

/** What each block takes, and nothing else: a step with any other key is refused. */
const SHAPES: Record<ShortcutBlock, Record<string, "text" | "any" | "template" | "step" | "date" | "count" | readonly string[]>> = {
  ask: { prompt: "text" },
  input: {},
  today: {},
  case: { of: "step", to: ["upper", "lower", "title"] },
  combine: { text: "template" },
  // "any": what is found may be replaced by a space, or by nothing.
  replace: { of: "step", find: "text", with: "any" },
  addToDate: { of: "date", amount: "count", unit: ["hours", "days", "weeks"] },
  formatDate: { of: "date", style: ["short", "medium", "long"] },
  events: { day: ["today", "tomorrow"] },
  addEvent: { title: "template", start: "date", minutes: "count" },
  reminders: {},
  addReminder: { title: "template" },
  createNote: { text: "template" },
  appendNote: { note: "text", text: "template" },
  show: { text: "template" },
  notify: { text: "template" },
  copy: { text: "template" },
  speak: { text: "template" },
  result: { text: "template" },
};

/** Blocks whose result is a date; the date blocks take only these. */
const DATES: readonly ShortcutBlock[] = ["today", "addToDate"];
/** Blocks with nothing for a later step to use. */
const NO_RESULT: readonly ShortcutBlock[] = ["show", "notify", "copy", "speak", "result", "addEvent", "addReminder", "createNote", "appendNote"];

const REFERENCE = /\{(\d{1,2})\}/g;

export class ShortcutRefused extends Error {}

const refuse = (why: string): never => {
  throw new ShortcutRefused(why);
};

/** A shortcut's name: one line that can be a file's name. */
function cleanName(value: unknown): string {
  const name = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!name || name.length > MAX_NAME) refuse(`name must be 1 to ${MAX_NAME} characters.`);
  if (/[\u0000-\u001f\u007f/:\\]/.test(name) || name.startsWith(".")) refuse("name can't contain / : \\ or start with a dot.");
  return name;
}

/**
 * A draft as the menu allows it, or a refusal that says which step is wrong
 * and why. Everything a draft holds passes through here before it is shown,
 * described or compiled: a block that is not on the menu never gets further.
 */
export function validShortcut(raw: unknown): ShortcutDraft {
  const draft = (raw ?? {}) as { name?: unknown; steps?: unknown };
  const name = cleanName(draft.name);
  if (!Array.isArray(draft.steps) || draft.steps.length === 0) refuse("steps must be a list with at least one step.");
  const list = draft.steps as unknown[];
  if (list.length > SHORTCUT_MAX_STEPS) refuse(`A shortcut made here has at most ${SHORTCUT_MAX_STEPS} steps.`);
  const steps: ShortcutStep[] = [];
  list.forEach((entry, index) => {
    const at = index + 1;
    const step = (entry ?? {}) as Record<string, unknown>;
    const block = String(step.block ?? "");
    if (!Object.hasOwn(SHAPES, block)) {
      refuse(`Step ${at}: "${block.slice(0, 40)}" is not a block. The blocks are: ${Object.keys(SHAPES).join(", ")}. Nothing else can be put in a shortcut here.`);
    }
    const shape = SHAPES[block as ShortcutBlock];
    for (const key of Object.keys(step)) if (key !== "block" && !Object.hasOwn(shape, key)) refuse(`Step ${at} (${block}) has no "${key.slice(0, 40)}".`);
    const earlier = (n: unknown, what: string): number => {
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n >= at) return refuse(`Step ${at} (${block}): ${what} must be the number of an earlier step.`);
      if (NO_RESULT.includes(steps[n - 1]!.block)) return refuse(`Step ${at} (${block}): step ${n} (${steps[n - 1]!.block}) has no result to use.`);
      return n;
    };
    const out: Record<string, unknown> = { block };
    for (const [key, kind] of Object.entries(shape)) {
      const value = step[key];
      if (kind === "step") out[key] = earlier(value, key);
      else if (kind === "date") {
        const n = earlier(value, key);
        if (!DATES.includes(steps[n - 1]!.block)) refuse(`Step ${at} (${block}): ${key} must be a step that gives a date (today or addToDate).`);
        out[key] = n;
      } else if (kind === "count") {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10_000) refuse(`Step ${at} (${block}): ${key} must be a whole number from 1 to 10000.`);
        out[key] = value;
      } else if (Array.isArray(kind)) {
        if (!kind.includes(String(value))) refuse(`Step ${at} (${block}): ${key} must be one of ${kind.join(", ")}.`);
        out[key] = value;
      } else {
        if (typeof value !== "string" || value.length > MAX_TEXT) refuse(`Step ${at} (${block}): ${key} must be text of at most ${MAX_TEXT} characters.`);
        const text = value as string;
        if (/[\u0000-\u0008\u000b-\u001f\u007f￼]/.test(text)) refuse(`Step ${at} (${block}): ${key} has a character that can't be in a shortcut.`);
        if (kind === "text" && !text.trim()) refuse(`Step ${at} (${block}): ${key} can't be empty.`);
        if (kind === "template") for (const ref of text.matchAll(REFERENCE)) earlier(Number(ref[1]), `{${ref[1]}}`);
        out[key] = text;
      }
    }
    steps.push(out as ShortcutStep);
  });
  return { name, steps };
}

// -- what it does, in the user's words --------------------------------------

/** Each step in one plain line, as the summary lists them. */
export function describeSteps(draft: ShortcutDraft): string[] {
  // A line break in a text is shown as a mark: each step stays one line.
  const shown = (text: string): string => text.trim().replace(/\s*\n+\s*/g, " ↵ ").replace(REFERENCE, (_, n: string) => t("shortcutBuilder.ref", { n }));
  return draft.steps.map((step) => {
    switch (step.block) {
      case "ask": return t("shortcutBuilder.step.ask", { prompt: step.prompt });
      case "input": return t("shortcutBuilder.step.input");
      case "today": return t("shortcutBuilder.step.today");
      case "case": return t(`shortcutBuilder.step.case.${step.to}`, { n: step.of });
      case "combine": return t("shortcutBuilder.step.combine", { text: shown(step.text) });
      case "replace": return t("shortcutBuilder.step.replace", { n: step.of, find: step.find, with: step.with });
      case "addToDate": return t("shortcutBuilder.step.addToDate", { n: step.of, amount: t(`shortcutBuilder.unit.${step.unit}`, { count: step.amount }) });
      case "formatDate": return t("shortcutBuilder.step.formatDate", { n: step.of });
      case "events": return t(`shortcutBuilder.step.events.${step.day}`);
      case "addEvent": return t("shortcutBuilder.step.addEvent", { title: shown(step.title), n: step.start, minutes: step.minutes });
      case "reminders": return t("shortcutBuilder.step.reminders");
      case "addReminder": return t("shortcutBuilder.step.addReminder", { title: shown(step.title) });
      case "createNote": return t("shortcutBuilder.step.createNote", { text: shown(step.text) });
      case "appendNote": return t("shortcutBuilder.step.appendNote", { note: step.note, text: shown(step.text) });
      case "show": return t("shortcutBuilder.step.show", { text: shown(step.text) });
      case "notify": return t("shortcutBuilder.step.notify", { text: shown(step.text) });
      case "copy": return t("shortcutBuilder.step.copy", { text: shown(step.text) });
      case "speak": return t("shortcutBuilder.step.speak", { text: shown(step.text) });
      case "result": return t("shortcutBuilder.step.result", { text: shown(step.text) });
    }
  });
}

export interface ShortcutSummary {
  /** Apps it reads from and apps it adds to, by their names in the user's language. */
  reads: string[];
  adds: string[];
}

/** Which of the user's apps a shortcut touches, from its blocks. */
export function summarizeShortcut(draft: ShortcutDraft): ShortcutSummary {
  const has = (...blocks: ShortcutBlock[]): boolean => draft.steps.some((step) => blocks.includes(step.block));
  return {
    reads: [...(has("events") ? [t("connectors.calendar.label")] : []), ...(has("reminders") ? [t("connectors.reminders.label")] : [])],
    adds: [
      ...(has("addEvent") ? [t("connectors.calendar.label")] : []),
      ...(has("addReminder") ? [t("connectors.reminders.label")] : []),
      ...(has("createNote", "appendNote") ? [t("connectors.apps.notes.label")] : []),
    ],
  };
}

// -- the file ----------------------------------------------------------------

export type Plist = string | number | boolean | Plist[] | { [key: string]: Plist };

/** Where a result goes in a text: Shortcuts marks the place with this character. */
const PLACE = "￼";

/** What Shortcuts calls each block's result; shown in its editor. */
const RESULT_NAME: Partial<Record<ShortcutBlock, string>> = {
  ask: "Provided Input",
  today: "Date",
  case: "Updated Text",
  combine: "Text",
  replace: "Updated Text",
  addToDate: "Adjusted Date",
  formatDate: "Formatted Date",
  events: "Upcoming Events",
  reminders: "Upcoming Reminders",
};

const CASES = { upper: "UPPERCASE", lower: "lowercase", title: "Capitalize Every Word" } as const;
const UNITS = { hours: "hr", days: "days", weeks: "weeks" } as const;
const STYLES = { short: "Short", medium: "Medium", long: "Long" } as const;
const DAYS = { today: "Today", tomorrow: "Tomorrow" } as const;

/**
 * The Shortcuts file of a draft, as the property list it is. The draft goes
 * through validShortcut first, here too: nothing reaches a file unchecked.
 * `uuid` names each step's result; tests give their own.
 */
export function compileShortcut(raw: unknown, uuid: () => string): { name: string; plist: Plist } {
  const draft = validShortcut(raw);
  const ids = draft.steps.map(() => uuid().toUpperCase());

  /** The result of step `n`, as something a parameter can hold. */
  const result = (n: number): Plist => {
    const step = draft.steps[n - 1]!;
    return step.block === "input" ? { Type: "ExtensionInput" } : { Type: "ActionOutput", OutputUUID: ids[n - 1]!, OutputName: RESULT_NAME[step.block] ?? "Result" };
  };
  /** A text with results in it. Places are counted in UTF-16 units, as Shortcuts counts them. */
  const text = (template: string): Plist => {
    const places: { [range: string]: Plist } = {};
    let out = "";
    let last = 0;
    for (const ref of template.matchAll(REFERENCE)) {
      out += template.slice(last, ref.index);
      places[`{${out.length}, 1}`] = result(Number(ref[1]));
      out += PLACE;
      last = ref.index + ref[0].length;
    }
    out += template.slice(last);
    return Object.keys(places).length === 0 ? out : { Value: { string: out, attachmentsByRange: places }, WFSerializationType: "WFTextTokenString" };
  };
  const action = (identifier: string, parameters: { [key: string]: Plist }): Plist => ({ WFWorkflowActionIdentifier: identifier, WFWorkflowActionParameters: parameters });

  const actions: Plist[] = [];
  draft.steps.forEach((step, index) => {
    const UUID = ids[index]!;
    switch (step.block) {
      case "input":
        break;
      case "ask":
        actions.push(action("is.workflow.actions.ask", { UUID, WFAskActionPrompt: step.prompt, WFInputType: "Text" }));
        break;
      case "today":
        actions.push(action("is.workflow.actions.date", { UUID, WFDateActionMode: "Current Date" }));
        break;
      case "case":
        actions.push(action("is.workflow.actions.text.changecase", { UUID, WFCaseType: CASES[step.to], text: text(`{${step.of}}`) }));
        break;
      case "combine":
        actions.push(action("is.workflow.actions.gettext", { UUID, WFTextActionText: text(step.text) }));
        break;
      case "replace":
        actions.push(action("is.workflow.actions.text.replace", { UUID, WFInput: text(`{${step.of}}`), WFReplaceTextFind: step.find, WFReplaceTextReplace: step.with, WFReplaceTextCaseSensitive: true, WFReplaceTextRegularExpression: false }));
        break;
      case "addToDate":
        actions.push(action("is.workflow.actions.adjustdate", {
          UUID, WFDate: text(`{${step.of}}`), WFAdjustOperation: "Add",
          WFDuration: { Value: { Unit: UNITS[step.unit], Magnitude: String(step.amount) }, WFSerializationType: "WFQuantityFieldValue" },
        }));
        break;
      case "formatDate":
        actions.push(action("is.workflow.actions.format.date", { UUID, WFDate: text(`{${step.of}}`), WFDateFormatStyle: STYLES[step.style], WFTimeFormatStyle: "None" }));
        break;
      case "events":
        actions.push(action("is.workflow.actions.getupcomingevents", { UUID, WFGetUpcomingItemCount: 20, WFDateSpecifier: DAYS[step.day] }));
        break;
      case "addEvent": {
        // The end is the start plus its length: a step of the file's own, between the user's.
        const end = uuid().toUpperCase();
        actions.push(action("is.workflow.actions.adjustdate", {
          UUID: end, WFDate: text(`{${step.start}}`), WFAdjustOperation: "Add",
          WFDuration: { Value: { Unit: "min", Magnitude: String(step.minutes) }, WFSerializationType: "WFQuantityFieldValue" },
        }));
        actions.push(action("is.workflow.actions.addnewevent", {
          UUID, ShowWhenRun: false, WFCalendarItemTitle: text(step.title), WFCalendarItemStartDate: text(`{${step.start}}`),
          WFCalendarItemEndDate: { Value: { string: PLACE, attachmentsByRange: { "{0, 1}": { Type: "ActionOutput", OutputUUID: end, OutputName: "Adjusted Date" } } }, WFSerializationType: "WFTextTokenString" },
        }));
        break;
      }
      case "reminders":
        actions.push(action("is.workflow.actions.getupcomingreminders", { UUID, WFGetUpcomingItemCount: 20 }));
        break;
      case "addReminder":
        actions.push(action("is.workflow.actions.addnewreminder", { UUID, WFCalendarItemTitle: text(step.title) }));
        break;
      case "createNote":
        // Notes renamed this action's fields in macOS 27 (contents, OpenWhenRun); an older Shortcuts reads the first pair, a newer one the second.
        actions.push(action("com.apple.mobilenotes.SharingExtension", { UUID, ShowWhenRun: false, WFCreateNoteInput: text(step.text), OpenWhenRun: false, contents: text(step.text) }));
        break;
      case "appendNote": {
        // The note is looked up by its name: the first one with exactly that name.
        const found = uuid().toUpperCase();
        actions.push(action("is.workflow.actions.filter.notes", {
          UUID: found, WFContentItemLimitEnabled: true, WFContentItemLimitNumber: 1,
          WFContentItemFilter: {
            Value: { WFActionParameterFilterPrefix: 1, WFContentPredicateBoundedDate: false, WFActionParameterFilterTemplates: [{ Operator: 4, Property: "Name", Removable: true, Values: { String: step.note, Unit: 4 } }] },
            WFSerializationType: "WFContentPredicateTableTemplate",
          },
        }));
        actions.push(action("is.workflow.actions.appendnote", { UUID, WFInput: text(step.text), WFNote: { Value: { Type: "ActionOutput", OutputUUID: found, OutputName: "Notes" }, WFSerializationType: "WFTextTokenAttachment" } }));
        break;
      }
      case "show":
        actions.push(action("is.workflow.actions.showresult", { UUID, Text: text(step.text) }));
        break;
      case "notify":
        actions.push(action("is.workflow.actions.notification", { UUID, WFNotificationActionTitle: draft.name, WFNotificationActionBody: text(step.text), WFNotificationActionSound: false }));
        break;
      case "copy":
        actions.push(action("is.workflow.actions.setclipboard", { UUID, WFInput: text(step.text) }));
        break;
      case "speak":
        actions.push(action("is.workflow.actions.speaktext", { UUID, WFText: text(step.text) }));
        break;
      case "result":
        actions.push(action("is.workflow.actions.output", { UUID, WFOutput: text(step.text) }));
        break;
    }
  });

  const takesInput = draft.steps.some((step) => step.block === "input");
  const givesResult = draft.steps.some((step) => step.block === "result");
  return {
    name: draft.name,
    plist: {
      WFWorkflowClientVersion: "2607.0.2",
      WFWorkflowMinimumClientVersion: 900,
      WFWorkflowMinimumClientVersionString: "900",
      // One of Shortcuts' own icon colours and glyphs; the same for every shortcut made here.
      WFWorkflowIcon: { WFWorkflowIconStartColor: 4_271_458_815, WFWorkflowIconGlyphNumber: 59_511 },
      WFWorkflowImportQuestions: [],
      WFWorkflowTypes: [],
      WFWorkflowHasShortcutInputVariables: takesInput,
      WFWorkflowInputContentItemClasses: takesInput ? ["WFStringContentItem"] : [],
      WFWorkflowOutputContentItemClasses: givesResult ? ["WFStringContentItem"] : [],
      WFWorkflowHasOutputFallback: false,
      WFWorkflowActions: actions,
    },
  };
}

/** A property list as XML. `plutil` turns it into the binary form Shortcuts signs. */
export function plistXml(root: Plist): string {
  const escape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const write = (value: Plist): string => {
    if (typeof value === "string") return `<string>${escape(value)}</string>`;
    if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
    if (typeof value === "number") return Number.isInteger(value) ? `<integer>${value}</integer>` : `<real>${value}</real>`;
    if (Array.isArray(value)) return `<array>${value.map(write).join("")}</array>`;
    return `<dict>${Object.entries(value).map(([key, v]) => `<key>${escape(key)}</key>${write(v)}`).join("")}</dict>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${write(root)}</plist>\n`;
}
