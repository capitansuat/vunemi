import {copyQuotedSource,type QuotedSource} from '@vunemi/agent-core';
import type {TaskPermissionStore,TaskPermissionEpoch,TaskPermissionOfferView,TaskPermissionRevokeRequest,TaskPermissionsSnapshot} from "@vunemi/agent-core";
import {randomUUID} from 'node:crypto';
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
  type TaskRecord,
  isTrackingTool,
  type ApprovalDecision,
  type ChoiceAnswer,
  type ChoiceCard,
  type ChatModel,
  type HandoffOutcome,
  type MemoryNote,
  type MentionRef,
  type RunMention,
  type RunStatus,
  type PlanDecision,
  type ChatMessage,
  type ToolSpec,
  type OutputKeeper,
  listedRequest,
  type ToolArea,
  type RunOptions,
  type ToolRegistry,
  type ProviderConfig,
} from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";
import type { PreparedModel } from "./engine/service.js";
import { MENTION_SHARE } from "./mentions.js";

export interface SessionOptions {
  onStateChanged?:()=>void;
  /** Trusted process-local provider proxy; credentials stay with the service broker. */
  modelFactory?: (spec:string)=>ChatModel;
  validateQuotedSource?:(source:unknown)=>QuotedSource;
  taskPermissions?:{store:TaskPermissionStore;sessionId:()=>string;epoch:()=>TaskPermissionEpoch};
  tools: ToolRegistry;
  /** Long tool output, kept whole for output_read and output_search. */
  keptOutputs?: OutputKeeper;
  /**
   * The areas of tools, asked for at the start of each run. With them a
   * conversation keeps one tool list from its first request on.
   */
  areas?: () => ToolArea[];
  emit: (event: AgentEvent) => void;
  /** Close this emitted run owner only after its native RPC/child has settled. Stop alone never unlocks it. */
  onRunSettled?: (runId: string) => Promise<void>;
  /**
   * Extra guidance for the model, e.g. how to use the browser. Asked for at
   * the start of each run rather than fixed, so a connection the user
   * switches off stops being described as well as stopping working.
   */
  instructions?: () => string;
  chatInstructions?: () => string;
  planBeforeRun?: () => boolean;
  modelConfig?: (spec: string) => Partial<ProviderConfig>;
  /**
   * Loads the model a run names, e.g. starts the built-in engine. A failure
   * shows where the engine reports its state; the run then fails as
   * unreachable, which says the rest. It says the context it opened with, so
   * a shorter one reaches the run.
   */
  prepareModel?: (spec: string) => Promise<PreparedModel | null | void>;
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
  /** Latest task of this conversation, projected from persisted work events. */
  latestTask?: () => TaskRecord | undefined;
  /** The notes from memory a request is given; an error only means none. */
  recall?: (goal: string) => Promise<{ notes: MemoryNote[]; topic: string[] }>;
  /**
   * Reads what the user brought in with "@", within this many characters
   * between them (see mentions.ts).
   */
  readMentions?: (refs: MentionRef[], totalChars: number) => RunMention[] | Promise<RunMention[]>;
  /** The page showing in Vunemi's browser, if any, read as each request is sent. */
  openPage?: () => { title: string; url: string } | null;
  /**
   * The titles of the project's work notes, for a conversation's first
   * request only; null when there are none.
   */
  notesIndex?: () => string | null;
  /**
   * The earlier conversations and meetings a request may be about, as lines
   * for the model, and their ids; none of them in `given` (what this
   * conversation was told of before). Null when there are none, or the user
   * has not switched this on.
   */
  libraryIndex?: (goal: string, given: ReadonlySet<string>) => Promise<{ text: string; ids: string[] } | null>;
  /**
   * After a finished task the user watched: what they wrote lately, and the
   * model that did it, so memory can propose notes from their own words.
   */
  afterRun?: (run: { runId: string; model: ChatModel; words: string[] }) => void;
}

/** A message waiting its turn. */
export interface QueuedMessage {
  quotedSource?:QuotedSource;
  id: string;
  text: string;
  /** Files attached to it, already granted for reading. */
  attachments: string[];
  /** Conversations and meetings brought in with "@"; read when its turn comes. */
  mentions: MentionRef[];
  model: string;
  at: number;
}

/** What the model is told when the user's interruption cut a tool short. */
const INTERRUPTED = "[The user interrupted; this tool did not finish.]";

/** What the user wrote in the last few turns: what memory proposals may quote. */
const WORDS_KEPT = 3;
type RequestOwner={runId:string;requestId:string};
type DecisionWait<T>={owner:RequestOwner;resolve:(decision:T)=>void};

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
  /** The tools this conversation lists to the model; filled by its first run. */
  private readonly shownTools = new Set<string>();
  private active: AbortController | null = null;
  private queue: QueuedMessage[] = [];
  private queueListeners = new Set<(queue: QueuedMessage[]) => void>();
  private nextQueueId = 1;
  private readonly pendingPermissionOffers=new Map<string,TaskPermissionOfferView>();
  private activePermissionSessionId:string|null=null;
  private readonly pending = new Map<string, DecisionWait<ApprovalDecision>>();
  private readonly handoffs = new Map<string, DecisionWait<HandoffOutcome>>();
  private readonly issuedRequests=new Map<string,RequestOwner>();
  private readonly choices = new Map<string, { owner:RequestOwner; card: ChoiceCard; resolve: (answer: ChoiceAnswer) => void }>();
  private runId: string | null = null;
  private pendingPlan: DecisionWait<PlanDecision> | null = null;
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
  /** The earlier conversations and meetings this one was already told of: not listed twice. */
  private readonly libraryGiven = new Set<string>();
  /** Notes to announce once the run has its id. */
  private given: MemoryNote[] | null = null;
  /** A shorter context the last launch had to take; told to the run once it has an id. */
  private lowered: { context: number; wanted: number; tight: boolean } | null = null;

  constructor(private readonly opts: SessionOptions) {}

  /** Switched-off tools the user may allow from a card are shown to the model too. */
  private get offerable(): ((name: string) => boolean) | undefined {
    const offer = this.opts.switchedOff;
    return offer ? (name) => offer(name) !== null : undefined;
  }

  private readonly emit = (event: AgentEvent): void => {
    if (event.type === "run.started") this.runId = event.runId;
    if(event.type==='approval.required'||event.type==='handoff.required'||event.type==='plan.proposed'||event.type==='choice.asked'){
      const owner={runId:event.runId,requestId:randomUUID()};
      this.issuedRequests.set(this.requestKey(event.type,'callId'in event?event.callId:undefined),owner);
      event={...event,requestId:owner.requestId};
    }
    if(event.type==='run.finished'){
      this.issuedRequests.clear();this.pending.clear();this.handoffs.clear();this.choices.clear();this.pendingPermissionOffers.clear();this.pendingPlan=null;
    }
    this.opts.emit(event);
    if (event.type === "run.started" && this.given) {
      this.opts.emit({ type: "memory.given", runId: event.runId, notes: this.given, at: Date.now() });
      this.given = null;
    }
    if (event.type === "run.started" && this.lowered) {
      this.opts.emit({ type: "model.context", runId: event.runId, ...this.lowered, at: Date.now() });
      this.lowered = null;
    }
  };

  private requestKey(kind:string,callId?:string):string{return kind+':'+(callId??'');}
  private takeRequest(kind:string,callId?:string):RequestOwner{
    const key=this.requestKey(kind,callId),owner=this.issuedRequests.get(key);this.issuedRequests.delete(key);
    if(!owner||owner.runId!==this.runId||!this.active||this.active.signal.aborted)throw Error('No active approval request.');
    return owner;
  }
  private requestCurrent(owner:RequestOwner|undefined,expected:RequestOwner):boolean{
    return !!owner&&typeof owner==='object'&&!Array.isArray(owner)&&[Object.prototype,null].includes(Object.getPrototypeOf(owner))&&Object.keys(owner).sort().join(',')==='requestId,runId'&&typeof owner.runId==='string'&&typeof owner.requestId==='string'&&owner.runId===expected.runId&&owner.requestId===expected.requestId&&this.runId===expected.runId&&!!this.active&&!this.active.signal.aborted&&!this.pauseGate;
  }

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
    return this.queue.map(message=>({...message,...(message.quotedSource&&{quotedSource:{...message.quotedSource}})}));
  }

  onQueueChange(listener: (queue: QueuedMessage[]) => void): () => void {
    this.queueListeners.add(listener);
    return () => this.queueListeners.delete(listener);
  }

  private validateQuote(source:unknown):QuotedSource|undefined {
    if(source===undefined)return undefined;
    if(!this.opts.validateQuotedSource)throw Error('Quoted source validation unavailable.');
    return copyQuotedSource(this.opts.validateQuotedSource(copyQuotedSource(source)));
  }

  /**
   * The ordinary way in. Starts straight away when the agent is idle, and
   * otherwise waits its turn — the caller never has to ask which.
   */
  submit(text: string, model: string, attachments: string[] = [], mentions: MentionRef[] = [], quotedSource?:QuotedSource): QueuedMessage | null {
    const quote=this.validateQuote(quotedSource);
    const goal = text.trim();
    if (!goal) return null;
    // A message that brings something with it is a request of its own, not a card's answer.
    if (!quote && this.active && attachments.length === 0 && mentions.length === 0) {
      const waiting = [...this.choices].findLast(([, entry]) => entry.card.kind === "choice" && entry.card.allowOther);
      if (waiting && this.runId && this.resolveChoice(this.runId, waiting[0], { text: goal },waiting[1].owner)) return null;
    }
    if (!this.active) {
      void this.start(goal, model, attachments, { mentions,...(quote&&{quotedSource:quote}) }).catch((err: unknown) => console.error("[vunemi] run failed to start:", err));
      return null;
    }
    const message: QueuedMessage = { id: `q${this.nextQueueId++}`, text: goal, attachments, mentions, ...(quote&&{quotedSource:quote}), model, at: Date.now() };
    this.queue.push(message);
    this.announce();
    return {...message,...(quote&&{quotedSource:{...quote}})};
  }

  /**
   * "Stop what you're doing and read this." The message goes to the front and
   * the current run is cut; draining then picks it up.
   */
  steer(text: string, model: string, attachments: string[] = [], mentions: MentionRef[] = [], quotedSource?:QuotedSource): void {
    const quote=this.validateQuote(quotedSource);
    const goal = text.trim();
    if (!goal) return;
    if (!this.active) {
      void this.start(goal, model, attachments, { mentions,...(quote&&{quotedSource:quote}) }).catch((err: unknown) => console.error("[vunemi] run failed to start:", err));
      return;
    }
    this.queue.unshift({ id: `q${this.nextQueueId++}`, text: goal, attachments, mentions, ...(quote&&{quotedSource:quote}), model, at: Date.now() });
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
    void this.start(next.text, next.model, next.attachments, { mentions: next.mentions,quotedSource:next.quotedSource }).catch((err: unknown) => {
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
    run: { quotedSource?:QuotedSource; resumeTask?: TaskRecord; unattended?: boolean; askBeyondRead?: boolean; waitLimitMs?: number; onlySources?: readonly string[]; mentions?: readonly MentionRef[] } = {},
  ): Promise<RunStatus | null> {
    if (this.active) throw new Error("A run is already in progress.");
    const quotedSource=this.validateQuote(run.quotedSource);
    if(quotedSource&&run.resumeTask)throw Error('Quoted questions cannot resume a prior task.');
    run={...run,...(quotedSource&&{quotedSource})};
    // Resolve at actual start, also for queued/steered messages after Stop.
    // A short continuation picks up work; added instructions/files are new work.
    const continuation=goal.trim().toLocaleLowerCase("tr").replaceAll("ı","i").replaceAll("ğ","g").replace(/[.!?]+$/u,"").replace(/\s+/gu," ");
    if(!run.quotedSource && !run.resumeTask && !run.unattended && !attachments.length && !run.mentions?.length &&
       /^(?:devam et|kaldigin yerden devam et|continue|resume|continue where you left off)$/.test(continuation)){
      const task=this.opts.latestTask?.();
      if(task && ["stopped","interrupted"].includes(task.status) &&
         (task.planAccepted || task.operations.some(o=>["completed","unknown"].includes(o.status)&&!isTrackingTool(o.tool))))
        run={...run,resumeTask:structuredClone(task),askBeyondRead:true};
    }
    if(run.resumeTask?.executionMode==='native-recipe'||run.resumeTask?.operations.some(o=>o.tool==='native_recipe_textedit_append_save'))throw Error(t('nativeRecipes.noResume'));
    const permissionSessionId=this.opts.taskPermissions?.sessionId();
    this.activePermissionSessionId=permissionSessionId??null;
    const preparationStartedAt=Date.now();
    const ctrl = new AbortController();
    this.active = ctrl;
    let status: RunStatus | null = null;
    let ownerRunId: string | null = null;
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
          this.prepare(modelSpec),
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
      const openPage = this.opts.openPage?.() ?? null;
      // Read now, not when picked: a queued message brings the item as it is when its turn comes.
      const mentions = run.mentions?.length
        ? await this.opts.readMentions?.([...run.mentions], Math.floor(window * this.charsPerToken * MENTION_SHARE))
        : undefined;
      // Only a conversation's first request: added later, it would sit in the middle of the history.
      const notesIndex = this.history.length === 0 ? (this.opts.notesIndex?.() ?? null) : null;
      // Not for a scheduled task (nobody asked it about the past), nor beside what the user brought in themselves.
      const library = run.unattended || run.mentions?.length ? null : await this.opts.libraryIndex?.(goal, this.libraryGiven).catch(() => null) ?? null;
      // Model/library preparation can await: the conversation may have changed meanwhile.
      if(quotedSource)this.validateQuote(quotedSource);
      const result = await runAgent({
        ...(this.opts.taskPermissions&&permissionSessionId&&{taskPermissions:{store:this.opts.taskPermissions.store,sessionId:permissionSessionId,epoch:this.opts.taskPermissions.epoch}}),
        goal,
        ...(quotedSource&&{quotedSource}),
        preparationStartedAt,
        ...(openPage && { openPage }),
        ...(undone.length > 0 && { undone }),
        ...(memory.length > 0 && { memory }),
        ...(notesIndex && { notesIndex }),
        ...(library && { libraryIndex: library.text }),
        ...(attachments.length > 0 && { attachments }),
        ...(mentions?.length && { mentions }),
        model,
        contextWindow: window,
        charsPerToken: this.charsPerToken,
        tools: this.opts.tools,
        ...(this.opts.keptOutputs && { keptOutputs: this.opts.keptOutputs }),
        emit: event => {
          if (event.type === "run.started") ownerRunId = event.runId;
          this.emit(event);
        },
        history: this.history,
        ...(this.opts.instructions && { instructions: this.opts.instructions() }),
        lightChat: true,
        compactTaskTools: true,
        automaticOutputChecks: true,
        ...(this.opts.chatInstructions && { chatInstructions: this.opts.chatInstructions() }),
        planEveryTask: this.opts.planBeforeRun?.() === true,
        maxSteps: 30,
        sessionGrants: this.opts.grants,
        openedTools: this.openedTools,
        ...(this.opts.areas && { areas: this.opts.areas(), shownTools: this.shownTools }),
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
        ...(run.resumeTask && { resumeTask: run.resumeTask }),
        ...(this.opts.onCheckpoint && { onCheckpoint: this.opts.onCheckpoint }),
        requestApproval: (req) => waitFor<ApprovalDecision>((resolve) => {const owner=this.takeRequest('approval.required',req.callId);if(req.taskPermissionOffer)this.pendingPermissionOffers.set(req.callId,req.taskPermissionOffer);this.pending.set(req.callId,{owner,resolve});}),
        requestChoice: (req) => waitFor<ChoiceAnswer>((resolve) => this.choices.set(req.callId, { owner:this.takeRequest('choice.asked',req.callId),card: req.card, resolve })),
        requestHandoff: (req) => waitFor<HandoffOutcome>((resolve) => this.handoffs.set(req.callId,{owner:this.takeRequest('handoff.required',req.callId),resolve})),
        requestPlanApproval: (steps) =>
          waitFor<PlanDecision>((resolve) => {
            void steps;
            this.pendingPlan = {owner:this.takeRequest('plan.proposed'),resolve};
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
      if (result.status !== "failed") for (const id of library?.ids ?? []) this.libraryGiven.add(id);
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
      this.opts.taskPermissions?.store.expire("run-ended");
      try {
        // run.finished (and Stop) can precede a native child exiting. Keep the
        // session busy and its queue waiting until the owner boundary settles.
        if (ownerRunId) await this.opts.onRunSettled?.(ownerRunId);
      } finally {
        this.given = null;
        this.pending.clear();
        this.issuedRequests.clear();
        this.pendingPermissionOffers.clear();
        this.activePermissionSessionId=null;
        this.handoffs.clear();
        this.choices.clear();
        this.pendingPlan = null;
        this.pauseGate?.release();
        this.pauseGate = null;
        this.runId = null;
        this.active = null;
        this.opts.onStateChanged?.();
        // After this run's own caller has had its turn, not inside it.
        setTimeout(() => this.drain(), 0);
      }
    }
    return status;
  }

  private nativeRecipeActive=false;
  async startNativeRecipe(req:{runId:string;goal:string;execute(signal:AbortSignal,emit:(e:AgentEvent)=>void):Promise<RunStatus>}):Promise<RunStatus>{
    if(this.active||this.queue.length)throw Error('Session is busy');
    const active=new AbortController();this.active=active;this.nativeRecipeActive=true;
    this.emit({type:'run.started',runId:req.runId,goal:req.goal,model:'recipe:textedit.append-save.v1',executionMode:'native-recipe',at:Date.now()});
    let status:RunStatus='failed';
    try{status=await req.execute(active.signal,this.emit);if(active.signal.aborted)status='stopped';return status;}
    finally{try{await this.opts.onRunSettled?.(req.runId);}finally{
      this.emit({type:'run.finished',runId:req.runId,status,detail:t(status==='done'?'nativeRecipes.slotStatus.verified':'nativeRecipes.title'),at:Date.now()});this.runId=null;this.active=null;this.nativeRecipeActive=false;this.opts.onStateChanged?.();setTimeout(()=>this.drain(),0);
    }}
  }

  stop(): void {
    this.opts.taskPermissions?.store.expire("stopped");
    this.active?.abort();
  }

  private model(spec: string): ChatModel {
    return this.opts.modelFactory?.(spec) ?? createModel(spec, this.opts.modelConfig?.(spec));
  }

  /** The model's context length changed; ask its server again next time. */
  forgetWindow(spec: string): void {
    this.windows.delete(spec);
  }

  /** Loads the model; a context other than the cached one is asked for again, and a lowered one is told to the run. */
  private async prepare(spec: string): Promise<void> {
    const prepared = await this.opts.prepareModel?.(spec).catch(() => null);
    if (!prepared) return;
    if (this.windows.get(spec)?.window !== prepared.context) this.windows.delete(spec);
    if (prepared.announce) this.lowered = { context: prepared.context, wanted: prepared.wanted, tight: prepared.tight };
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

  /** What every request carries besides the conversation, as the next run would send it. */
  private fixed(): { system: string; tools: ToolSpec[] } {
    const instructions = this.opts.instructions?.();
    if (this.opts.areas && this.shownTools.size > 0) return listedRequest(this.opts.tools, this.opts.areas(), this.shownTools, instructions, this.offerable, undefined, true);
    return { system: systemPrompt(instructions), tools: toolSpecsOf(this.opts.tools, this.openedTools, this.offerable) };
  }

  private fixedChars(): number {
    if (this.opts.areas && this.shownTools.size > 0) {
      const { system, tools } = this.fixed();
      return system.length + JSON.stringify(tools).length;
    }
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
      await this.prepare(modelSpec);
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
        ...this.fixed(),
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
      if (result.kind === "summarized") {
        this.remembered.clear();
        this.libraryGiven.clear();
      }
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
      if (this.active === ctrl) {this.active = null;this.opts.onStateChanged?.();}
    }
  }

  get paused(): boolean {
    return this.pauseGate !== null;
  }

  /** Holds the run at its next safe point (before the next model call or tool). */
  pause(): void {
    if(this.nativeRecipeActive){this.stop();return;}
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

  private permissionOwner(sessionId:string,runId:string|null):TaskPermissionStore {
    const config=this.opts.taskPermissions;
    if(!config||sessionId!==config.sessionId())throw new Error('Task permission session changed.');
    const snapshot=config.store.snapshot();
    if(snapshot.sessionId!==sessionId||snapshot.runId!==runId)throw new Error('Task permission run changed.');
    return config.store;
  }
  resolveTaskApproval(request:{sessionId:string;runId:string;callId:string;decision:{kind:'approve_run';offerId:string;offerRevision:number}}):void {
    const store=this.permissionOwner(request.sessionId,request.runId);
    const offer=this.pendingPermissionOffers.get(request.callId),pending=this.pending.get(request.callId);
    if(!pending||!this.requestCurrent(pending.owner,pending.owner)||this.activePermissionSessionId!==request.sessionId||this.runId!==request.runId||!offer||offer.offerId!==request.decision.offerId||offer.revision!==request.decision.offerRevision)throw new Error('Stale or foreign scoped approval.');
    if(!store.canApprove(offer.offerId,offer.revision,{sessionId:request.sessionId,taskId:offer.taskId,runId:request.runId},request.callId))throw new Error('Expired or revoked scoped approval.');
    this.pendingPermissionOffers.delete(request.callId);this.pending.delete(request.callId);pending.resolve(request.decision);
  }
  listTaskPermissions(request:{sessionId:string;runId:string|null}):TaskPermissionsSnapshot{
    const config=this.opts.taskPermissions;
    if(!config||request.sessionId!==config.sessionId())throw new Error('Task permission session changed.');
    if(request.runId===null){
      if(this.active&&this.runId)throw new Error('A run is active.');
      const snapshot=config.store.snapshot();
      return {revision:snapshot.revision,sessionId:request.sessionId,runId:null,grants:snapshot.sessionId===request.sessionId?snapshot.grants.filter(g=>g.status!=='active'):[]};
    }
    return this.permissionOwner(request.sessionId,request.runId).snapshot();
  }
  revokeTaskPermission(request:TaskPermissionRevokeRequest):TaskPermissionsSnapshot{return this.permissionOwner(request.sessionId,request.runId).revoke(request);}

  /** A preview/adjustment may check ownership without consuming the decision. */
  canResolveApproval(callId:string,owner:RequestOwner):boolean{
    const pending=this.pending.get(callId);return !!pending&&this.requestCurrent(owner,pending.owner);
  }
  resolveApproval(callId: string, decision: ApprovalDecision,owner:RequestOwner): boolean {
    if(decision?.kind==="approve_run")throw new Error("Scoped approvals require the scoped channel.");
    if(!decision||typeof decision!=='object'||Array.isArray(decision)||![Object.prototype,null].includes(Object.getPrototypeOf(decision))||!['approve','approve_always','reject'].includes(decision.kind)||Object.keys(decision).some(key=>key!=='kind'&&(decision.kind!=='reject'||key!=='note'))||decision.kind==='reject'&&decision.note!==undefined&&(typeof decision.note!=='string'||decision.note.length>1000))return false;
    const pending=this.pending.get(callId);if(!pending||!this.canResolveApproval(callId,owner))return false;
    this.pendingPermissionOffers.delete(callId);this.pending.delete(callId);pending.resolve(decision);return true;
  }

  resolveHandoff(callId: string, outcome: HandoffOutcome,owner:RequestOwner): boolean {
    if(outcome!=='done'&&outcome!=='cancelled')return false;
    const pending=this.handoffs.get(callId);if(!pending||!this.requestCurrent(owner,pending.owner))return false;
    this.handoffs.delete(callId);pending.resolve(outcome);return true;
  }

  /** A second click or a stale card cannot answer the same wait again. */
  resolveChoice(runId: string, callId: string, answer: ChoiceAnswer,owner:RequestOwner): boolean {
    const entry = this.choices.get(callId);
    if (!entry || runId !== this.runId || !this.requestCurrent(owner,entry.owner)) return false;
    if(!answer||typeof answer!=='object'||Array.isArray(answer)||typeof answer.text!=='string'||Object.keys(answer).some(key=>key!=='index'&&key!=='text'))return false;
    const index = answer.index;
    if (index !== undefined && (!Number.isInteger(index) || index < 0 || index >= (entry.card.kind === "choice" ? entry.card.options.length : entry.card.items.length))) return false;
    if (index === undefined && (entry.card.kind !== "choice" || !entry.card.allowOther || !answer.text.trim())) return false;
    this.choices.delete(callId);
    if (index === undefined) this.words = [...this.words, answer.text.trim()].slice(-WORDS_KEPT);
    entry.resolve(answer);
    return true;
  }

  resolvePlan(decision: PlanDecision,owner:RequestOwner): boolean {
    if(!decision||typeof decision!=='object'||Array.isArray(decision)||![Object.prototype,null].includes(Object.getPrototypeOf(decision))||decision.kind!=='go'&&decision.kind!=='cancel')return false;
    if(Object.keys(decision).some(key=>key!=='kind'&&(decision.kind!=='go'||key!=='steps'))||decision.kind==='go'&&(!Array.isArray(decision.steps)||!decision.steps.length||decision.steps.length>12||decision.steps.some(step=>typeof step!=='string'||!step.trim()||step.length>1000)))return false;
    const pending=this.pendingPlan;if(!pending||!this.requestCurrent(owner,pending.owner))return false;
    this.pendingPlan=null;pending.resolve(decision);return true;
  }

  reset(): void {
    this.load([]);
  }

  /** Continues another conversation. Not while a task runs: its events would land in the wrong one. */
  load(history: ChatMessage[]): void {
    this.opts.taskPermissions?.store.expire("session-changed");
    if (this.active) throw new Error(t("main.stopFirst"));
    this.clearQueue();
    this.history = [...history];
    this.undone = [];
    this.openedTools.clear();
    this.shownTools.clear();
    this.words = [];
    this.remembered.clear();
    this.libraryGiven.clear();
    // A notice from a load in the previous conversation is not this one's.
    this.lowered = null;
  }

  /** The user undid something this conversation did; the model hears it next time. */
  noteUndone(label: string): void {
    this.undone.push(label);
  }
}
