export {nativeErrorText} from './native-errors.js';
export {NativeProcessBroker,type NativeProcessBrokerEvent} from './native-process-broker.js';
import {withJournalAdmission} from './journal-coordinator.js';
import {verifiedDocumentMoveResult} from './document-move.js';
import {verifiedSliderResult,type DragExpectation} from './background-slider-drag.js';
/**
 * The bridge to VunemiHelper, the signed Swift process that holds the
 * Accessibility privilege. One JSON object per line each way, one request at
 * a time, ids matched to replies.
 *
 * The helper is started when it is first needed and restarted if it dies, so
 * a crash costs one call rather than the session. Nothing here decides
 * anything: policy lives in policy.ts and in the Sentinel.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync,realpathSync,statSync } from "node:fs";
import {isAbsolute} from "node:path";
import { t } from "@vunemi/i18n";
import {TargetLeases,NoInputSent,validOwner,validLeaseTarget,type LeaseTarget} from "./target-lease.js";
import { OperationJournal, type OperationRecord } from "./operation-journal.js";
import { nativeErrorText } from "./native-errors.js";

export interface Permissions {
  accessibility: boolean;
  /** Diagnostic fields returned by the native helper for a failed AX check. */
  trusted?: boolean;
  probe?: string;
  screenRecording: boolean;
  /** Granted separately from everything else, and from each other. */
  calendars: boolean;
  reminders: boolean;
}

export interface MacApp {
  name: string;
  bundleId: string;
  pid: number;
  frontmost: boolean;
}

/** Long enough for an app to answer, short enough that nothing hangs. */
const CALL_TIMEOUT_MS = 20_000;

export class HelperUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HelperUnavailable";
  }
}

/** Local host adapter; guards/signals stay in this process and are never serialized as authority. */
export interface ObservationTransportOptions {timeoutMs?:number;signal?:AbortSignal;assertActive?:()=>void;ownerRunId?:string}
export interface ExecutionTransport {
  call(op:string,args:Record<string,unknown>,opts:ObservationTransportOptions):Promise<unknown>;
  dispose():void;
}
export interface ObservationTransport {
  call(op:'apps'|'permissions'|'background_environment'|'windows',args:Record<string,unknown>,opts:ObservationTransportOptions):Promise<unknown>;
  dispose():void;
}
export interface HelperCallOptions {beforeDispatch?:(dispatchId:string)=>void;timeoutMs?:number;signal?:AbortSignal;assertActive?:()=>void;ownerRunId?:string;target?:LeaseTarget;dragExpectation?:DragExpectation}
export class Helper {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly waiting = new Map<number, { owner: ChildProcessWithoutNullStreams; resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private readonly leases=new TargetLeases();
  private activeRPC:{owner?:string;done:Promise<void>}|null=null;
  private getJournal(assertCurrent?:()=>void):OperationJournal {
    if(!this.options.operationJournalPath)throw new NoInputSent('Durable operation journal unavailable; background dispatch blocked.','journal-unavailable');
    const journal=new OperationJournal(this.options.operationJournalPath,512,assertCurrent);
    if(assertCurrent){journal.quarantine();for(const record of journal.unresolved())this.leases.restoreUnknown(record.ownerRunId??'legacy-journal',record.target);}
    return journal;
  }
  async releaseRun(runId:string):Promise<void> {
    this.leases.closeOwner(runId);
    const active=this.activeRPC;if(active?.owner===runId)await active.done;
    this.leases.releaseKnown(runId);
  }
  constructor(private readonly binary: string, private readonly options: {operationJournalPath?:string;observationTransport?:ObservationTransport;executionTransport?:ExecutionTransport;processGone?:(pid:number)=>boolean} = {}) {}

  queryOperation(dispatchId:string):OperationRecord|null {
    if(typeof dispatchId!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(dispatchId))throw Error("Invalid dispatch ID.");
    if(!this.options.operationJournalPath)return null;
    return this.getJournal().query(dispatchId);
  }

  admitJournal<T>(journalPath:string,body:(assertCurrent:()=>void)=>Promise<T>|T,signal?:AbortSignal):Promise<T> {
    if(!this.installed)return Promise.reject(new NoInputSent(t('mac.helper.missing'),'helper-unavailable'));
    return withJournalAdmission(this.binary,journalPath,body,signal);
  }

  get installed(): boolean {
    return existsSync(this.binary);
  }

  /**
   * Asked fresh every time, never remembered: macOS grants and revokes these
   * while the app runs, and a cached "granted" turns into an agent that
   * quietly does nothing.
   */
  async permissions(prompt = false): Promise<Permissions> {
    const permissions = (await this.call("permissions", { prompt })) as Permissions;
    return permissions.probe ? { ...permissions, probe: nativeErrorText(permissions.probe) } : permissions;
  }

  async apps(): Promise<MacApp[]> {
    const { apps } = (await this.call("apps")) as { apps: MacApp[] };
    return apps;
  }

  blockTarget(owner:string,target:LeaseTarget):void{this.leases.markUnknown(owner,target);}

  async call(op:string,args:Record<string,unknown>={},opts:HelperCallOptions={}):Promise<unknown> {
    opts={...opts,...(opts.target?{target:{...opts.target}}:{}),...(opts.dragExpectation?{dragExpectation:{...opts.dragExpectation}}:{})};
    const effect=['scheduled_document_append','scheduled_document_save','background_press','background_set_value','background_open_document','background_save_document','background_document_move','background_scroll_position','background_menu_open','background_menu_select','background_drag'].includes(op);
    if(!effect)return this.callAdmitted(op,args,opts);
    if(this.activeRPC)throw new NoInputSent('Native helper is busy; no request was queued or sent.','helper-busy');
    if(!this.options.operationJournalPath)throw new NoInputSent('Durable operation journal unavailable; background dispatch blocked.','journal-unavailable');
    return this.admitJournal(this.options.operationJournalPath,assertCurrent=>this.callAdmitted(op,args,opts,assertCurrent),opts.signal);
  }
  private async callAdmitted(op:string,args:Record<string,unknown>,opts:HelperCallOptions,assertCurrent?:()=>void):Promise<unknown> {
    opts={...opts,...(opts.target?{target:{...opts.target}}:{}),...(opts.dragExpectation?{dragExpectation:{...opts.dragExpectation}}:{})};
    if(this.activeRPC)throw new NoInputSent('Native helper is busy; no request was queued or sent.','helper-busy');
    const effect=['scheduled_document_append','scheduled_document_save','background_press','background_set_value','background_open_document','background_save_document','background_document_move','background_scroll_position','background_menu_open','background_menu_select','background_drag'].includes(op);
    let journal:OperationJournal|undefined;
    if(effect){
      if(!this.installed)throw new NoInputSent(t('mac.helper.missing'),'helper-unavailable');
      if(opts.signal?.aborted)throw new NoInputSent('Stopped before dispatch; no input sent.','stopped');
      try{opts.assertActive?.();}catch(cause){throw Object.assign(new NoInputSent('Run became inactive before dispatch.','stopped'),{cause});}
      try{journal=this.getJournal(assertCurrent);}catch(cause){throw Object.assign(new NoInputSent('Operation journal could not be opened before dispatch.','journal-unavailable'),{cause});}
      if(!validOwner(opts.ownerRunId))throw new NoInputSent('A current run owner is required for background dispatch.','invalid-owner');
    }
    let settled!:()=>void;
    const done=new Promise<void>(resolve=>{settled=resolve;});this.activeRPC={...(opts.ownerRunId?{owner:opts.ownerRunId}:{}),done};
    try{
      if(!effect){
        if(op==='scheduled_recipe_backup'){
          if(!validOwner(opts.ownerRunId)||!validLeaseTarget(opts.target)||String(args.app)!==String(opts.target.pid))throw new NoInputSent('Exact parent recipe required for backup.','invalid-owner');
          this.leases.acquire(opts.ownerRunId,opts.target);this.leases.assertOwner(opts.ownerRunId);
        }
        return await this.transport(op,args,opts);
      }
      if(op==='background_open_document')await this.admitDocumentOpen(args,opts,journal!);
      else {
        if(!validLeaseTarget(opts.target)||String(args.app)!==String(opts.target.pid))throw new NoInputSent('Exact validated target identity is required before dispatch.','invalid-target');
        this.leases.acquire(opts.ownerRunId!,opts.target);
      }
      assertCurrent?.();
      this.leases.assertOwner(opts.ownerRunId!);
      if(opts.signal?.aborted)throw new NoInputSent('Stopped before dispatch; no input sent.','stopped');
      try{opts.assertActive?.();}catch(cause){throw Object.assign(new NoInputSent('Run became inactive before dispatch.','stopped'),{cause});}
      let record:OperationRecord;
      try{
        record=journal!.prepare(op,{ownerRunId:opts.ownerRunId,...(opts.target?{target:opts.target}:{})});
        try{opts.beforeDispatch?.(record.dispatchId);}catch(cause){this.leases.markUnknown(opts.ownerRunId!,opts.target);journal!.transition(record.dispatchId,'unknown');throw cause;}
        opts.assertActive?.();
        journal!.transition(record.dispatchId,'dispatched');
      }catch(cause){throw Object.assign(new NoInputSent('Operation journal could not persist the dispatch boundary; no request was sent.','journal-unavailable'),{cause});}
      try{
        assertCurrent?.();
        const result=await this.transport(op,args,opts);
        const native=result&&typeof result==='object'?result as Record<string,unknown>:{};
        const opened=op==='background_open_document'?{bundleId:native.bundleId,pid:native.pid,processStartedAt:native.processStartedAt,windowId:native.windowId}:undefined;
        const rejected=(op==='scheduled_document_append'||op==='scheduled_document_save')&&native.status==='rejected'&&native.noInputSent===true;
        const known=rejected|| (op==='background_document_move'?(verifiedDocumentMoveResult(native)&&!!opts.target&&native.pid===opts.target.pid&&native.processStartedAt===opts.target.processStartedAt&&native.windowId===opts.target.windowId&&native.bundleId===opts.target.bundleId):op==='background_drag'?verifiedSliderResult(native,opts.dragExpectation):op==='background_open_document'?validLeaseTarget(opened):op==='background_save_document'?native.status==='saved':['verified','delivered'].includes(String(native.status)));
        const uncertain=!known||native.foregroundChanged===true||native.cursorChanged===true||native.deliveryUnknown===true;
        if(uncertain)this.leases.markUnknown(opts.ownerRunId!,opts.target);
        else if(opened)this.leases.acquire(opts.ownerRunId!,opened as LeaseTarget);
        journal!.transition(record.dispatchId,uncertain?'unknown':'native-result',result);
        return result&&typeof result==='object'?{...result,dispatchId:record.dispatchId,...(uncertain?{deliveryUnknown:true}:{})}:result;
      }catch(error){
        this.leases.markUnknown(opts.ownerRunId!,opts.target);
        try{if(journal!.query(record.dispatchId)?.state==='dispatched')journal!.transition(record.dispatchId,'unknown');}catch{/* Unknown stays blocked in memory even if persistence is unavailable. */}
        const failure=error instanceof Error?error:new Error(String(error));failure.message+=` Dispatch ID: ${record.dispatchId}. Query desktop_operation_status; inspect before any retry.`;
        throw Object.assign(failure,{dispatchId:record.dispatchId,deliveryUnknown:true,noInputSent:false,nativeRejection:false});
      }
    }finally{this.activeRPC=null;settled();}
  }

  /** Read-only isolation, never resolution: old unknown targets remain blocked/audited. */
  private async admitDocumentOpen(args:Record<string,unknown>,opts:HelperCallOptions,journal:OperationJournal):Promise<void> {
    const processGone=this.options.processGone??((pid:number)=>{try{process.kill(pid,0);return false;}catch(error){return (error as NodeJS.ErrnoException).code==='ESRCH';}});
    try{this.leases.admitOpen(opts.ownerRunId!);return;}catch(error){if(!(error instanceof NoInputSent)||error.reasonCode!=='delivery-blocked')throw error;}
    const blocked=()=>new NoInputSent('Prior uncertain target could not be independently isolated from this document; no open sent.','delivery-blocked');
    const unresolved=journal.unresolved();
    if(!unresolved.length||unresolved.some(r=>!r.target))throw blocked();
    try{
      if(typeof args.path!=='string'||!isAbsolute(args.path))throw blocked();
      const requested=realpathSync(args.path),before=statSync(requested);
      if(requested!==args.path||!before.isFile())throw blocked();
      const proven:LeaseTarget[]=[];
      for(const record of unresolved){
        const target=record.target!;
        // A process that has exited can no longer take the uncertain input, and a closed app can't be described: it would block every open for good.
        if(processGone(target.pid)){proven.push(target);continue;}
        const value=await this.transport('describe',{app:String(target.pid),part:'window',windowId:target.windowId,background:true},opts) as Record<string,unknown>;
        if(!value||value.bundleId!==target.bundleId||value.pid!==target.pid||value.processStartedAt!==target.processStartedAt||value.windowId!==target.windowId||value.controlMode!=='backgroundStrict'||value.foregroundChanged===true||typeof value.documentPath!=='string'||!isAbsolute(value.documentPath))throw blocked();
        const prior=realpathSync(value.documentPath),previous=statSync(prior);
        if(prior===requested||!previous.isFile()||previous.dev===before.dev&&previous.ino===before.ino)throw blocked();
        proven.push(target);
      }
      const after=statSync(requested);
      if(realpathSync(args.path)!==requested||after.dev!==before.dev||after.ino!==before.ino)throw blocked();
      if(opts.signal?.aborted)throw new NoInputSent('Stopped before document open.','stopped');
      opts.assertActive?.();
      this.leases.admitOpen(opts.ownerRunId!,proven);
    }catch(error){if(error instanceof NoInputSent)throw error;throw blocked();}
  }

  private async transport(op: string, args: Record<string, unknown> = {}, opts: ObservationTransportOptions = {}): Promise<unknown> {
    if (!this.installed) {
      throw new HelperUnavailable(
        t("mac.helper.missing"),
      );
    }
    if(opts.signal?.aborted)throw opts.signal.reason ?? new Error("Stopped.");
    opts.assertActive?.();
    if(this.options.executionTransport)return this.options.executionTransport.call(op,{...args},{...(opts.timeoutMs!==undefined&&{timeoutMs:opts.timeoutMs}),...(opts.signal&&{signal:opts.signal}),...(opts.assertActive&&{assertActive:opts.assertActive}),...(opts.ownerRunId&&{ownerRunId:opts.ownerRunId})});
    const observe=this.options.observationTransport;
    const keys=Object.keys(args).sort().join(',');
    const remote=(op==='apps'||op==='background_environment')&&keys===''||op==='permissions'&&keys==='prompt'&&args.prompt===false||op==='windows'&&keys==='app,background'&&typeof args.app==='string'&&args.background===true;
    if(observe&&remote)return observe.call(op as 'apps'|'permissions'|'background_environment'|'windows',{...args},{...(opts.timeoutMs!==undefined&&{timeoutMs:opts.timeoutMs}),...(opts.signal&&{signal:opts.signal}),...(opts.assertActive&&{assertActive:opts.assertActive}),...(opts.ownerRunId&&{ownerRunId:opts.ownerRunId})});
    const child = this.start();
    const id = this.nextId++;

    return new Promise<unknown>((resolve, reject) => {
      let cancelling=false,completed=false;
      const cancel=(error:unknown)=>{
        if(cancelling||completed)return;cancelling=true;this.waiting.delete(id);cleanup();
        if(child.exitCode!==null||child.signalCode!==null){reject(error);return;}
        let fallback:ReturnType<typeof setTimeout>|undefined,forced:ReturnType<typeof setTimeout>|undefined;
        const exited=()=>{clearTimeout(fallback);clearTimeout(forced);child.removeListener('exit',exited);child.removeListener('error',failed);reject(error);};
        const failed=()=>{if(child.pid===undefined)exited();};child.once('exit',exited);child.once('error',failed);
        if(op==='background_drag'){child.kill('SIGUSR1');fallback=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');forced=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},500);}},2000);}else child.kill();
      };
      const aborted=()=>cancel(opts.signal?.reason ?? new Error("Stopped."));
      const validityTimer=opts.assertActive ? setInterval(()=>{try{opts.assertActive!();}catch(error){cancel(error);}},25) : undefined;
      const cleanup=()=>{clearTimeout(timer);clearInterval(validityTimer);opts.signal?.removeEventListener("abort",aborted);};
      const timer = setTimeout(() => {
        cancel(new Error(t("mac.helper.timeout", { op })));
      }, opts.timeoutMs ?? CALL_TIMEOUT_MS);

      this.waiting.set(id, {
        owner:child,
        resolve: (value) => {
          if(cancelling)return;completed=true;cleanup();
          resolve(value);
        },
        reject: (error) => {
          if(cancelling)return;completed=true;cleanup();
          reject(error);
        },
      });
      opts.signal?.addEventListener("abort",aborted,{once:true});
      child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  dispose(): void {
    try{this.options.executionTransport?.dispose();}
    finally{try{this.options.observationTransport?.dispose();}
    finally{this.child?.kill();this.child = null;}}
  }

  // -- internals -------------------------------------------------------------

  private start(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;

    const child = spawn(this.binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.buffer = "";

    child.stdout.on("data", (chunk: Buffer) => {if(this.child===child)this.read(chunk.toString());});
    child.stderr.on("data", (chunk: Buffer) => console.error("[vunemi helper]", chunk.toString().trim()));
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      // Whoever was waiting will never hear back; say so rather than hang.
      for (const [id, pending] of this.waiting) {
        if(pending.owner!==child)continue;
        this.waiting.delete(id);
        pending.reject(new Error(t("mac.helper.exited", { code: code ?? "signal" })));
      }
    });
    child.on("error", (err) => {
      // A failed kill/send with a live PID is not evidence that native work ended.
      if(child.pid!==undefined&&child.exitCode===null&&child.signalCode===null)return;
      if (this.child === child) this.child = null;
      for (const [id, pending] of this.waiting) {
        if(pending.owner!==child)continue;
        this.waiting.delete(id);
        pending.reject(new HelperUnavailable(t("mac.helper.spawnFailed", { reason: err.message })));
      }
    });
    return child;
  }

  private read(text: string): void {
    this.buffer += text;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (line.trim()) this.deliver(line);
    }
  }

  private deliver(line: string): void {
    let message: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      console.error("[vunemi helper] unreadable reply:", line.slice(0, 200));
      return;
    }
    const pending = typeof message.id === "number" ? this.waiting.get(message.id) : undefined;
    if (!pending || typeof message.id !== "number") return;
    this.waiting.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(Object.assign(new Error(message.error ? nativeErrorText(message.error) : t("mac.helper.failed")),{nativeRejection:true}));
  }
}
