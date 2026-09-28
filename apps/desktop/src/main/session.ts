/**
 * One conversation with the agent: history, approvals granted "always", and
 * at most one run in flight. Lives in the main process so a run keeps going
 * even if the window reloads.
 *
 * A person watching an agent work thinks of the next thing before the current
 * thing is done, and making them wait to say it is how a good instruction
 * gets lost. So typing is never blocked: a message sent while the agent is
 * busy goes into a queue and starts on its own when the run ends. If it
 * cannot wait, `steer` stops the run and takes the message first — and the
 * interrupted transcript is kept, sealed, so the correction arrives knowing
 * what the agent had already done.
 */

import {
  compact,
  createModel,
  DEFAULT_CHARS_PER_TOKEN,
  estimateTokens,
  FALLBACK_WINDOW,
  messageChars,
  overheadChars,
  systemPrompt,
  toolSpecsOf,
  runAgent,
  sealInterrupted,
  type AgentEvent,
  type ApprovalDecision,
  type ChatModel,
  type HandoffOutcome,
  type MemoryNote,
  type RunStatus,
  type PlanDecision,
  type ChatMessage,
  type RunOptions,
  type ToolRegistry,
  type ProviderConfig,
} from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";

export interface SessionOptions {
  tools: ToolRegistry;
  emit: (event: AgentEvent) => void;
  /**
   * Extra guidance for the model, e.g. how to use the browser. Asked for at
   * the start of each run rather than fixed, so a connection the user
   * switches off stops being described as well as stopping working.
   */
  instructions?: () => string;
  planBeforeRun?: () => boolean;
  modelConfig?: (spec: string) => Partial<ProviderConfig>;
  /**
   * Loads the model a run names, e.g. starts the built-in engine. A failure
   * shows where the engine reports its state; the run then fails as
   * unreachable, which says the rest.
   */
  prepareModel?: (spec: string) => Promise<void>;
  /** The Sentinel: the only thing that may authorise an action. */
  authorize: RunOptions["authorize"];
  /** A switched-off tool the user may switch back on from its card (see RunOptions.switchedOff). */
  switchedOff?: RunOptions["switchedOff"];
  switchOn?: RunOptions["switchOn"];
  /** Web text the agent read, for the Sentinel's taint tracking. */
  onUntrustedOutput: RunOptions["onUntrustedOutput"];
  /** Shared with the Sentinel, so "always" means the same set on both sides. */
  grants: Set<string>;
  /** The Vault's mask, applied to everything on its way to the model. */
  redact?: RunOptions["redact"];
  /** Scales pictures for a model that can see. */
  loadImage?: RunOptions["loadImage"];
  readImageText?: RunOptions["readImageText"];
  onUndoOffered?: RunOptions["onUndoOffered"];
  /** Told what the model remembers after each task, so the conversation can be kept. */
  onHistory?: (history: ChatMessage[]) => void;
  /** Told the conversation so far after every step of a run, so a crash can't take it. */
  onCheckpoint?: RunOptions["onCheckpoint"];
  /** The notes from memory a request is given; an error only means none. */
  recall?: (goal: string) => Promise<{ notes: MemoryNote[]; topic: string[] }>;
  /**
   * After a finished task the user watched: what they wrote lately, and the
   * model that did it, so memory can propose notes from their own words.
   */
  afterRun?: (run: { runId: string; model: ChatModel; words: string[] }) => void;
}

/** A message waiting its turn. */
export interface QueuedMessage {
  id: string;
  text: string;
  /** Files attached to it, already granted for reading. */
  attachments: string[];
  model: string;
  at: number;
}

/** What the model is told when the user's interruption cut a tool short. */
const INTERRUPTED = "[The user interrupted; this tool did not finish.]";

/** What the user wrote in the last few turns: what memory proposals may quote. */
const WORDS_KEPT = 3;

/** After a task, past this share of the window, make room for the next. */
const AFTER_RUN_LIMIT = 0.6;
/** …and aim below this. */
const AFTER_RUN_TARGET = 0.5;

export class AgentSession {
  private history: ChatMessage[] = [];
  /** Undone from the activity log since the last answer; told with the next request. */
  private undone: string[] = [];
  /** App tool groups a guide has opened in this conversation (ToolDef.onDemand). */
  private readonly openedTools = new Set<string>();
  private active: AbortController | null = null;
  private queue: QueuedMessage[] = [];
  private queueListeners = new Set<(queue: QueuedMessage[]) => void>();
  private nextQueueId = 1;
  private readonly pending = new Map<string, (d: ApprovalDecision) => void>();
  private readonly handoffs = new Map<string, (o: HandoffOutcome) => void>();
  private runId: string | null = null;
  private pendingPlan: ((d: PlanDecision) => void) | null = null;
  /** Set while paused; resolves on resume. */
  private pauseGate: { promise: Promise<void>; release: () => void } | null = null;
  /** Learned from the model's own token counts; carried from run to run. */
  private charsPerToken = DEFAULT_CHARS_PER_TOKEN;
  /** Each model's window, asked once per session. */
  private readonly windows = new Map<string, { window: number; known: boolean }>();
  /** The user's last few messages in this conversation, as they wrote them. */
  private words: string[] = [];
  /** Notes from memory already in the history; not sent again. */
  private readonly remembered = new Set<string>();
  /** Notes to announce once the run has its id. */
  private given: MemoryNote[] | null = null;

  constructor(private readonly opts: SessionOptions) {}

  /** Switched-off tools the user may allow from a card are shown to the model too. */
  private get offerable(): ((name: string) => boolean) | undefined {
    const offer = this.opts.switchedOff;
    return offer ? (name) => offer(name) !== null : undefined;
  }

  private readonly emit = (event: AgentEvent): void => {
    if (event.type === "run.started") this.runId = event.runId;
    this.opts.emit(event);
    if (event.type === "run.started" && this.given) {
      this.opts.emit({ type: "memory.given", runId: event.runId, notes: this.given, at: Date.now() });
      this.given = null;
    }
  };

  /** What the user wrote in the last few turns, for the memory tool's check. */
  userWords(): string[] {
    return [...this.words];
  }

  get running(): boolean {
    return this.active !== null;
  }

  /** What the model last said to the user, once a run has finished. */
  get lastAnswer(): string {
    const last = this.history.findLast((m) => m.role === "assistant" && m.content.trim().length > 0);
    return last?.content ?? "";
  }

  // -- the queue -------------------------------------------------------------

  get queued(): QueuedMessage[] {
    return [...this.queue];
  }

  onQueueChange(listener: (queue: QueuedMessage[]) => void): () => void {
    this.queueListeners.add(listener);
    return () => this.queueListeners.delete(listener);
  }

  /**
   * The ordinary way in. Starts straight away when the agent is idle, and
   * otherwise waits its turn — the caller never has to ask which.
   */
  submit(text: string, model: string, attachments: string[] = []): QueuedMessage | null {
    const goal = text.trim();
    if (!goal) return null;
    if (!this.active) {
      void this.start(goal, model, attachments).catch((err: unknown) => console.error("[vunemi] run failed to start:", err));
      return null;
    }
    const message: QueuedMessage = { id: `q${this.nextQueueId++}`, text: goal, attachments, model, at: Date.now() };
    this.queue.push(message);
    this.announce();
    return message;
  }

  /**
   * "Stop what you're doing and read this." The message goes to the front and
   * the current run is cut; draining then picks it up.
   */
  steer(text: string, model: string, attachments: string[] = []): void {
    const goal = text.trim();
    if (!goal) return;
    if (!this.active) {
      void this.start(goal, model, attachments).catch((err: unknown) => console.error("[vunemi] run failed to start:", err));
      return;
    }
    this.queue.unshift({ id: `q${this.nextQueueId++}`, text: goal, attachments, model, at: Date.now() });
    this.announce();
    this.stop();
  }

  /**
   * A waiting message that can't wait after all — an emergency, a
   * correction. It goes to the front and the current run stops (or the
   * compaction after it), so it starts next, knowing what the agent had
   * already done. With nothing running, it simply starts.
   */
  interrupt(id: string): void {
    const index = this.queue.findIndex((m) => m.id === id);
    if (index === -1) return;
    const [message] = this.queue.splice(index, 1);
    this.queue.unshift(message!);
    this.announce();
    if (this.active) this.stop();
    else this.drain();
  }

  drop(id: string): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((m) => m.id !== id);
    if (this.queue.length !== before) this.announce();
  }

  clearQueue(): void {
    if (this.queue.length === 0) return;
    this.queue = [];
    this.announce();
  }

  private announce(): void {
    const snapshot = this.queued;
    for (const listener of this.queueListeners) listener(snapshot);
  }

  /** Starts the next message, if the agent is free and one is waiting. */
  private drain(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.announce();
    void this.start(next.text, next.model, next.attachments).catch((err: unknown) => {
      console.error("[vunemi] queued run failed to start:", err);
    });
  }

  /**
   * Resolves when the run has finished, with how it ended (null when it
   * could not start). A scheduled run passes `unattended`, a resumed one `askBeyondRead`, and a
   * `waitLimitMs` after which an unanswered card stops it.
   */
  async start(
    goal: string,
    modelSpec: string,
    attachments: string[] = [],
    run: { unattended?: boolean; askBeyondRead?: boolean; waitLimitMs?: number; onlySources?: readonly string[] } = {},
  ): Promise<RunStatus | null> {
    if (this.active) throw new Error("A run is already in progress.");
    const ctrl = new AbortController();
    this.active = ctrl;
    let status: RunStatus | null = null;
    /** Waits for the user; past the limit, stops the run rather than act without them. */
    const waitFor = <T>(register: (resolve: (value: T) => void) => void): Promise<T> =>
      new Promise<T>((resolve) => {
        const timer = run.waitLimitMs ? setTimeout(() => ctrl.abort(), run.waitLimitMs) : null;
        register((value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        });
      });
    try {
      if (this.opts.prepareModel) {
        // Loading can take a while; Stop must still work during it.
        await Promise.race([
          this.opts.prepareModel(modelSpec).catch(() => {}),
          new Promise<void>((resolve) => ctrl.signal.addEventListener("abort", () => resolve(), { once: true })),
        ]);
      }
      const model = this.model(modelSpec);
      const { window } = await this.windowOf(modelSpec, model);
      const undone = this.undone.splice(0);
      this.words = [...this.words, goal].slice(-WORDS_KEPT);
      const recalled = await this.opts.recall?.(goal).catch(() => null);
      const memory = recalled?.topic.filter((text) => !this.remembered.has(text)) ?? [];
      this.given = recalled?.notes.length ? recalled.notes : null;
      const result = await runAgent({
        goal,
        ...(undone.length > 0 && { undone }),
        ...(memory.length > 0 && { memory }),
        ...(attachments.length > 0 && { attachments }),
        model,
        contextWindow: window,
        charsPerToken: this.charsPerToken,
        tools: this.opts.tools,
        emit: this.emit,
        history: this.history,
        ...(this.opts.instructions && { instructions: this.opts.instructions() }),
        planEveryTask: this.opts.planBeforeRun?.() === true,
        maxSteps: 30,
        sessionGrants: this.opts.grants,
        openedTools: this.openedTools,
        authorize: this.opts.authorize,
        ...(this.opts.switchedOff && { switchedOff: this.opts.switchedOff }),
        ...(this.opts.switchOn && { switchOn: this.opts.switchOn }),
        onUntrustedOutput: this.opts.onUntrustedOutput,
        ...(this.opts.redact && { redact: this.opts.redact }),
        ...(this.opts.loadImage && { loadImage: this.opts.loadImage }),
        ...(this.opts.readImageText && { readImageText: this.opts.readImageText }),
        signal: ctrl.signal,
        whenUnpaused: () => this.pauseGate?.promise ?? Promise.resolve(),
        ...(this.opts.onUndoOffered && { onUndoOffered: this.opts.onUndoOffered }),
        ...(run.unattended && { unattended: true }),
        ...(run.onlySources && { onlySources: run.onlySources }),
        ...(run.askBeyondRead && { askBeyondRead: true }),
        ...(this.opts.onCheckpoint && { onCheckpoint: this.opts.onCheckpoint }),
        requestApproval: (req) => waitFor<ApprovalDecision>((resolve) => this.pending.set(req.callId, resolve)),
        requestHandoff: (req) => waitFor<HandoffOutcome>((resolve) => this.handoffs.set(req.callId, resolve)),
        requestPlanApproval: (steps) =>
          waitFor<PlanDecision>((resolve) => {
            void steps;
            this.pendingPlan = resolve;
          }),
      });
      status = result.status;
      // A finished turn is kept as it is. A stopped one is kept sealed: the
      // user who interrupts is usually about to say what they wanted
      // instead, and that correction is worth far more with the context of
      // what the agent had already done. One that ran out of steps is kept
      // too: its work is what "continue" continues from. A failed run is
      // dropped — whatever went wrong there should not be the ground the
      // next turn stands on.
      this.charsPerToken = result.charsPerToken ?? this.charsPerToken;
      if (result.status === "done") this.history = result.messages;
      else if (result.status === "stopped" || result.status === "max_steps") this.history = sealInterrupted(result.messages, INTERRUPTED);
      if (result.status !== "failed") for (const text of memory) this.remembered.add(text);
      this.opts.onHistory?.(this.history);
      if (result.status !== "failed") {
        // The run is over: nothing may pause it now, and the queue waits on compaction instead.
        this.runId = null;
        // A stopped task usually has a correction queued behind it; don't make it wait for a summary.
        await this.compactHistory(result.runId, model, window, { allowSummary: result.status !== "stopped", force: false });
      }
      // Nobody watches a scheduled task to answer a card under it.
      if (result.status === "done" && !run.unattended) this.opts.afterRun?.({ runId: result.runId, model, words: [...this.words] });
    } finally {
      this.given = null;
      this.pending.clear();
      this.handoffs.clear();
      this.pendingPlan = null;
      this.pauseGate?.release();
      this.pauseGate = null;
      this.runId = null;
      this.active = null;
      // After this run's own caller has had its turn, not inside it.
      setTimeout(() => this.drain(), 0);
    }
    return status;
  }

  stop(): void {
    this.active?.abort();
  }

  private model(spec: string): ChatModel {
    return createModel(spec, this.opts.modelConfig?.(spec));
  }

  /** The model's context length changed; ask its server again next time. */
  forgetWindow(spec: string): void {
    this.windows.delete(spec);
  }

  private async windowOf(spec: string, model: ChatModel): Promise<{ window: number; known: boolean }> {
    const cached = this.windows.get(spec);
    if (cached) return cached;
    const reported = await model.contextWindow?.().catch(() => null);
    // Only what the server said is remembered: the built-in engine cannot
    // answer while it is unloaded, and will know later.
    if (!reported) return { window: FALLBACK_WINDOW, known: false };
    const entry = { window: reported, known: true };
    this.windows.set(spec, entry);
    return entry;
  }

  private fixedChars(): number {
    return overheadChars(this.opts.tools, this.opts.instructions?.(), this.openedTools, this.offerable);
  }

  /** The model's window, and how much of it the next request would take. */
  async contextInfo(modelSpec: string): Promise<{ window: number; known: boolean; estimate: number }> {
    const { window, known } = await this.windowOf(modelSpec, this.model(modelSpec));
    const estimate = estimateTokens(this.fixedChars() + messageChars(this.history), this.charsPerToken);
    return { window, known, estimate };
  }

  /** "Compact now": the user asked, so the threshold doesn't apply. */
  async compactNow(modelSpec: string, runId: string): Promise<void> {
    if (this.active) throw new Error(t("main.stopFirst"));
    if (this.history.length === 0) return;
    try {
      await this.opts.prepareModel?.(modelSpec).catch(() => {});
      const model = this.model(modelSpec);
      const { window } = await this.windowOf(modelSpec, model);
      await this.compactHistory(runId, model, window, { allowSummary: true, force: true });
    } finally {
      setTimeout(() => this.drain(), 0);
    }
  }

  /**
   * Makes room in what the model reads next. Holds the session while it
   * works, so a message sent meanwhile waits in the queue; Stop cancels it
   * and keeps whatever trimming already gave.
   */
  private async compactHistory(
    runId: string,
    model: ChatModel,
    window: number,
    opts: { allowSummary: boolean; force: boolean },
  ): Promise<void> {
    const fixedChars = this.fixedChars();
    const estimate = estimateTokens(fixedChars + messageChars(this.history), this.charsPerToken);
    if (!opts.force && estimate <= window * AFTER_RUN_LIMIT) return;

    const ctrl = new AbortController();
    this.active = ctrl;
    let announced = false;
    try {
      const result = await compact(this.history, {
        model,
        window,
        system: systemPrompt(this.opts.instructions?.()),
        tools: toolSpecsOf(this.opts.tools, this.openedTools, this.offerable),
        charsPerToken: this.charsPerToken,
        target: AFTER_RUN_TARGET,
        keepTurns: 2,
        keepRecentTools: 2,
        pruneChars: 2_000,
        allowSummary: opts.allowSummary,
        force: opts.force,
        signal: ctrl.signal,
        onSummarizing: () => {
          announced = true;
          this.opts.emit({ type: "context.compacting", runId, at: Date.now() });
        },
      });
      if (result.error) console.error("[vunemi] compaction:", result.error);
      if (result.kind === "none" && !announced && !opts.force) return;
      this.history = result.history;
      // A summary may have left out the notes it was given: they may be sent again.
      if (result.kind === "summarized") this.remembered.clear();
      const redact = this.opts.redact ?? ((text: string) => text);
      this.opts.emit({
        type: "context.compacted",
        runId,
        kind: result.kind === "none" ? "unchanged" : result.kind,
        before: result.before,
        after: result.after,
        window,
        ...(result.summary && { summary: await redact(result.summary) }),
        at: Date.now(),
      });
      this.opts.onHistory?.(this.history);
    } finally {
      if (this.active === ctrl) this.active = null;
    }
  }

  get paused(): boolean {
    return this.pauseGate !== null;
  }

  /** Holds the run at its next safe point (before the next model call or tool). */
  pause(): void {
    if (!this.active || this.pauseGate || !this.runId) return;
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    this.pauseGate = { promise, release };
    this.emit({ type: "run.paused", runId: this.runId, at: Date.now() });
  }

  resume(): void {
    const gate = this.pauseGate;
    if (!gate || !this.runId) return;
    this.pauseGate = null;
    this.emit({ type: "run.resumed", runId: this.runId, at: Date.now() });
    gate.release();
  }

  resolveApproval(callId: string, decision: ApprovalDecision): void {
    const resolve = this.pending.get(callId);
    if (!resolve) return; // already resolved, or the run ended
    this.pending.delete(callId);
    resolve(decision);
  }

  resolveHandoff(callId: string, outcome: HandoffOutcome): void {
    const resolve = this.handoffs.get(callId);
    if (!resolve) return;
    this.handoffs.delete(callId);
    resolve(outcome);
  }

  resolvePlan(decision: PlanDecision): void {
    const resolve = this.pendingPlan;
    if (!resolve) return;
    this.pendingPlan = null;
    resolve(decision);
  }

  reset(): void {
    this.load([]);
  }

  /** Continues another conversation. Not while a task runs: its events would land in the wrong one. */
  load(history: ChatMessage[]): void {
    if (this.active) throw new Error(t("main.stopFirst"));
    this.clearQueue();
    this.history = [...history];
    this.undone = [];
    this.openedTools.clear();
    this.words = [];
    this.remembered.clear();
  }

  /** The user undid something this conversation did; the model hears it next time. */
  noteUndone(label: string): void {
    this.undone.push(label);
  }
}
