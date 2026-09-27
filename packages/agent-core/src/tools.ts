/**
 * Tool definitions. Every tool declares an action class at registration time;
 * the approval policy (and later the Sentinel) decides on classes, never on
 * tool names, so a new tool can't slip past the gate by being unfamiliar.
 */

export type ActionClass =
  /** Reads state; no side effects. */
  | "read"
  /** Changes local, recoverable state (a draft, a scratch file). */
  | "write-local"
  /** Changes state in a way that can't be trivially undone. */
  | "destructive"
  /** Sends data off the machine or to another person. */
  | "outbound"
  /** Moves money or commits to a purchase. */
  | "financial";

export const ACTION_CLASSES: readonly ActionClass[] = [
  "read",
  "write-local",
  "destructive",
  "outbound",
  "financial",
];

import type { Artifact, Produced } from "./events.js";

/** JSON Schema subset accepted by OpenAI-compatible tool calling. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolContext {
  signal: AbortSignal;
  /**
   * Pauses the run until the user has done something only they may do
   * (solve a CAPTCHA, log in). `reason` is shown to them, in their language.
   * Resolves true when they say they're done, false if they cancel.
   */
  handoff(reason: string): Promise<boolean>;
  /**
   * Offers a way to undo what this call just did, for the activity log.
   * `label` is shown to the user, in their language. Call it after the
   * change has been made, with everything needed to reverse it captured.
   */
  offerUndo(label: string, undo: () => Promise<void>): void;
  /**
   * Hands the UI something to show — a screenshot, say. The model never sees
   * it; this is for the person watching.
   */
  attach(artifact: Artifact): void;
  /**
   * Pictures for the person only, shown as small tiles on the call card:
   * photos a search found, say. Never given to the model, seeing or not.
   */
  gallery?(items: Artifact[]): void;
  /**
   * Announces something the call made that the user may want to find again
   * (see Produced). Call it once per thing. Dropped if the call then fails.
   */
  produced?(item: Produced): void;
  /**
   * Shows the model a group of on-demand tools (see ToolDef.onDemand) from
   * the next step on, for the rest of the conversation.
   */
  openTools?(group: string): void;
}

export interface ToolDef<Args = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JsonSchema;
  actionClass: ActionClass;
  /**
   * The class of this particular call, when it depends on the arguments
   * (e.g. an app command that may be "get" or "delete"). Falls back to
   * `actionClass`. A throw counts as `actionClass`.
   */
  classify?(args: Args): ActionClass;
  /**
   * Checked before any card: a reason here refuses the call outright, so
   * the user is never asked to approve something that can't be done (a
   * preference holding a secret, say). Null lets it through.
   */
  check?(args: Args): string | null | Promise<string | null>;
  /**
   * Ask the user before every call, even when the policy says "auto" or the
   * user chose "always" earlier. A policy of "deny" still refuses.
   */
  alwaysAsk?: boolean;
  /**
   * A grant key shared by matching calls in the current conversation only.
   * Use with alwaysAsk and allowSessionApproval to force the first ask even
   * under an automatic policy. The policy and taint checks run every call.
   */
  approvalScope?(args: Args): string | undefined;
  /** Show the existing "approve for this conversation" choice for this scope. */
  allowSessionApproval?: true;
  /**
   * The group this tool belongs to when it is shown only on request: its
   * definition reaches the model after a guide tool opens the group, which
   * keeps the request small while the tool is not needed.
   */
  onDemand?: string;
  /**
   * Words in a request that mean this on-demand tool is wanted, such as an
   * app's name or a file extension; the group opens without its guide.
   */
  wantedFor?: RegExp;
  /**
   * Words in a request that mean another tool's job, though this one sounds
   * like it: then this tool isn't offered for that request. Vunemi's own
   * browser tab list, asked for Chrome's tabs, told the user Chrome had none.
   */
  avoidFor?: RegExp;
  /**
   * True when the output contains content the user didn't write (web pages,
   * emails, files from elsewhere). Such output is fenced as untrusted before
   * it reaches the model.
   */
  untrustedOutput?: boolean;
  /**
   * Output describes a moment in time (a page snapshot). Only the latest such
   * output is kept verbatim in the conversation; older ones are replaced by a
   * short note, so long browsing sessions fit a small context window.
   */
  ephemeral?: boolean;
  /**
   * One line, in the user's language, saying what this call will do — shown
   * on approval cards instead of raw arguments ("Click: button 'Add to cart'").
   */
  preview?(args: Args): Promise<string>;
  run(args: Args, ctx: ToolContext): Promise<string>;
}

/**
 * Tools, grouped by where they came from.
 *
 * A tool belongs to a source — the browser, the files, a connected mail
 * account — and a source can be switched off. Off means gone: it is absent
 * from the list the model is given AND unreachable by name, so a model that
 * remembers a tool from earlier in the conversation cannot call it anyway.
 * That is what makes "default off" in the threat model a real position
 * rather than a UI preference.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, { tool: ToolDef; source: string }>();
  private readonly off = new Set<string>();

  /** `source` groups a connector's tools so they can be turned off together. */
  register<A>(tool: ToolDef<A>, source = "core"): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, { tool: tool as unknown as ToolDef, source });
    return this;
  }

  /** Forgets a source's tools entirely, for a connector being disconnected. */
  unregister(source: string): void {
    for (const [name, entry] of this.tools) {
      if (entry.source === source) this.tools.delete(name);
    }
    this.off.delete(source);
  }

  /** The source a tool was registered under, switched on or not. */
  sourceOf(name: string): string | undefined {
    return this.tools.get(name)?.source;
  }

  get(name: string): ToolDef | undefined {
    const entry = this.tools.get(name);
    if (!entry || this.off.has(entry.source)) return undefined;
    return entry.tool;
  }

  /** A tool whatever its switch says: only for running one the user just allowed on its card. */
  getAny(name: string): ToolDef | undefined {
    return this.tools.get(name)?.tool;
  }

  /** Known, but its source is switched off: the user can turn it on, the model can't use it. */
  isSwitchedOff(name: string): boolean {
    const entry = this.tools.get(name);
    return entry !== undefined && this.off.has(entry.source);
  }

  /** The tools whose source is switched off. */
  listSwitchedOff(): ToolDef[] {
    return [...this.tools.values()].filter((e) => this.off.has(e.source)).map((e) => e.tool);
  }

  list(): ToolDef[] {
    return [...this.tools.values()].filter((e) => !this.off.has(e.source)).map((e) => e.tool);
  }

  setEnabled(source: string, on: boolean): void {
    if (on) this.off.delete(source);
    else this.off.add(source);
  }

  isEnabled(source: string): boolean {
    return !this.off.has(source);
  }

  /** Every source that has registered something, with how many. */
  sources(): { source: string; tools: number; enabled: boolean }[] {
    const counts = new Map<string, number>();
    for (const entry of this.tools.values()) counts.set(entry.source, (counts.get(entry.source) ?? 0) + 1);
    return [...counts].map(([source, tools]) => ({ source, tools, enabled: !this.off.has(source) }));
  }
}
