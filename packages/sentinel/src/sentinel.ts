/**
 * The Sentinel: the one place that may authorise an action.
 *
 * The model proposes; only this decides. It is deliberately dull and
 * deterministic — no model runs here, so a prompt injection has nothing to
 * persuade. Three jobs:
 *
 *  1. Autonomy policy per action class (read / write-local / destructive /
 *     outbound / financial).
 *  2. Taint tracking. Text the agent read from the web is remembered; when
 *     such text turns up in the arguments of an action that can carry data
 *     outward, the user is asked even if they once said "always", and the
 *     card says where the text came from. This is the "lethal trifecta"
 *     (private data + untrusted content + an exfiltration channel) cut at
 *     the third leg, and it keeps ordinary clicks quiet so approvals stay
 *     meaningful.
 *  3. Domain policy: Vunemi's own control surfaces are off limits, and the
 *     user's blocklist is enforced here rather than trusted to the model.
 */

import type { ActionClass, AutonomyPolicy } from "@vunemi/agent-core";
import { t } from "@vunemi/i18n";

export type Verdict =
  | { kind: "allow" }
  | { kind: "ask"; reason: string; alert?: boolean }
  | { kind: "deny"; reason: string };

export interface GateRequest {
  tool: string;
  actionClass: ActionClass;
  args: unknown;
  /** The URL this call would open, when it is a navigation. */
  url?: string;
  /** The tool asks every time; neither "auto" nor a session grant lets it through. */
  alwaysAsk?: boolean;
}

export interface SentinelOptions {
  policy: AutonomyPolicy;
  /** Tools the user approved for the whole session. Owned by the caller. */
  grants: Set<string>;
  /** Hosts the user never wants the agent on, e.g. ["bank.example"]. */
  blockedHosts?: readonly string[];
  /** How much recent web text to keep for taint checks. */
  taintBudget?: number;
}

/** Actions that can carry data out of the machine or change the world. */
const CARRIES_DATA = new Set<ActionClass>(["outbound", "destructive", "financial"]);

/** Shorter runs of text match by accident ("Kabul et", a price); longer ones don't. */
const MIN_TAINT_MATCH = 24;

const TAINT_BUDGET = 40_000;

/**
 * Money is outside the product, not behind a switch: the agent does not pay,
 * transfer or trade, and the user does those themselves. The policy type
 * still has a financial row because the class exists — a tool must be able
 * to say what it is — but no policy can open it. Enforced here, since this
 * is the only place that authorises anything; a settings screen or a
 * hand-edited file that says otherwise is simply overruled.
 */
function sealed(policy: AutonomyPolicy): AutonomyPolicy {
  return { ...policy, financial: "deny" };
}

export class Sentinel {
  private tainted: { text: string; source: string }[] = [];
  private size = 0;
  private policy: AutonomyPolicy;

  constructor(private readonly opts: SentinelOptions) {
    this.policy = sealed(opts.policy);
  }

  /**
   * Changes the autonomy policy while the app runs. Tightening it takes
   * effect on the next call; loosening it does not touch the session grants,
   * which the user gave one at a time and can clear separately.
   */
  setPolicy(policy: AutonomyPolicy): void {
    this.policy = sealed(policy);
  }

  get currentPolicy(): AutonomyPolicy {
    return { ...this.policy };
  }

  /** Remembers text the agent read from somewhere it doesn't control. */
  noteUntrusted(text: string, source: string): void {
    if (!text) return;
    this.tainted.push({ text: normalise(text), source });
    this.size += text.length;
    const budget = this.opts.taintBudget ?? TAINT_BUDGET;
    while (this.size > budget && this.tainted.length > 1) {
      this.size -= this.tainted.shift()!.text.length;
    }
  }

  /** Starts a fresh conversation: nothing read, nothing granted. */
  reset(): void {
    this.tainted = [];
    this.size = 0;
    this.opts.grants.clear();
  }

  check(req: GateRequest): Verdict {
    const host = hostOf(req.url ?? urlArg(req.args));
    if (host && this.blocked(host)) {
      return { kind: "deny", reason: t("sentinel.blockedHost", { host }) };
    }

    // Before grants and before the policy: nothing the user or the model
    // switched on earlier gets a payment through.
    if (req.actionClass === "financial") {
      return { kind: "deny", reason: t("sentinel.financial") };
    }

    const mode = this.policy[req.actionClass];
    if (mode === "deny") {
      return { kind: "deny", reason: t("sentinel.classDenied", { actionClass: t(`actionClass.${req.actionClass}`) }) };
    }

    // Taint beats a session grant: the user allowed the tool, not this payload.
    if (CARRIES_DATA.has(req.actionClass)) {
      const carried = this.carriedText(req.args);
      if (carried) {
        return {
          kind: "ask",
          alert: true,
          reason: t("sentinel.carries", { source: carried.source, text: ellipsis(carried.text, 60) }),
        };
      }
    }

    if (!req.alwaysAsk && (mode === "auto" || this.opts.grants.has(req.tool))) return { kind: "allow" };
    return { kind: "ask", reason: `${req.tool}: ${t(`sentinel.class.${req.actionClass}`)}` };
  }

  // -- internals -------------------------------------------------------------

  private blocked(host: string): boolean {
    return (this.opts.blockedHosts ?? []).some((b) => host === b || host.endsWith(`.${b}`));
  }

  /** The longest argument string that came from somewhere untrusted. */
  private carriedText(args: unknown): { text: string; source: string } | null {
    let best: { text: string; source: string } | null = null;
    for (const value of strings(args)) {
      if (value.length < MIN_TAINT_MATCH) continue;
      const needle = normalise(value);
      for (const t of this.tainted) {
        if (t.text.includes(needle) && (!best || value.length > best.text.length)) {
          best = { text: value, source: t.source };
        }
      }
    }
    return best;
  }
}

function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  else if (value && typeof value === "object") for (const v of Object.values(value)) yield* strings(v);
}

/** Whitespace and case differ between a page and what the agent types back. */
function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Navigation tools carry the address in their arguments. */
function urlArg(args: unknown): string | null {
  const url = (args as { url?: unknown } | null)?.url;
  return typeof url === "string" ? url : null;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function ellipsis(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
