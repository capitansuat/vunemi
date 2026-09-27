/**
 * Connections: everything Vunemi can reach, in one list the user controls.
 *
 * Three kinds of thing end up here and they deserve to sit together, because
 * from where the user stands they are the same question — "what can this
 * thing get at?":
 *
 *  - what is already on the Mac and needs a macOS permission (calendar,
 *    reminders, the desktop, files),
 *  - what runs here with no permission at all (the isolated browser),
 *  - what belongs to an account somewhere else and needs authorising
 *    (mail, drive, and whatever comes next).
 *
 * Keeping them in one catalogue is what makes "default off" in the threat
 * model true rather than aspirational: every connection is a switch, and a
 * switch that is off takes its tools out of the model's reach entirely.
 *
 * A connector never holds a credential itself. Anything secret lives in the
 * Vault under this connector's id, so the model is told the account's name
 * and never its key.
 */

import type { ToolDef } from "@vunemi/agent-core";

/** What a connection needs before it will work. */
export type ConnectorNeed =
  /** A macOS permission the user grants in System Settings. */
  | { kind: "permission"; what: string }
  /** An account to authorise. */
  | { kind: "account"; provider: string }
  /** Nothing: it works as soon as it is switched on. */
  | { kind: "none" };

export type ConnectorStatus =
  /** Switched off by the user. Its tools do not exist for the model. */
  | { state: "off" }
  /** On, and working. `account` names whose it is, when that applies. */
  | { state: "ready"; account?: string }
  /**
   * On, but it cannot work yet, and `reason` says what the user must do.
   * `settings` names the Privacy & Security pane that grants it, when only
   * System Settings can — so the screen can take the user there.
   */
  | { state: "blocked"; reason: string; settings?: PrivacyPane };

/** The Privacy & Security panes a connection can need. */
export type PrivacyPane = "calendars" | "reminders" | "accessibility" | "automation";

/**
 * A slice of what a connection can do, switchable on its own.
 *
 * "Files" is not one permission. Reading a folder, writing into it and
 * running a converter over it are three different amounts of trust, and a
 * user who wants the first should not have to accept the third. So a
 * connection declares its capabilities and each one carries its own tools
 * and its own switch.
 */
export interface Capability {
  id: string;
  label: string;
  /** One line: what this lets the agent do. */
  description?: string;
  /** The tools it owns, by name. */
  tools: string[];
  /** Reading tends to start on; acting does not. */
  defaultOn: boolean;
  /** Internal tool group that follows the parent connection without a separate switch. */
  hidden?: true;
}

/**
 * Which half of the screen a connection belongs to.
 *
 * These are two different questions wearing the same clothes. "May Vunemi use
 * this Mac?" is a short, fixed list — the browser, the files, the desktop —
 * and each entry is a permission the user grants once and rarely revisits.
 * "What else may Vunemi reach?" is an open catalogue that grows every time
 * someone plugs in a server, and its entries come and go.
 *
 * Kept in one list they read as peers, and the catalogue eventually buries
 * the permissions. Split, each side can be read for what it is: one is the
 * blast radius on this machine, the other is a shelf.
 *
 * Apple's Calendar sits in the catalogue rather than with the Mac
 * permissions, even though macOS is what guards it. It is there because of
 * what the user is choosing between: the row next to it is Google Calendar,
 * not the file system. Where the events are stored is our problem, not a
 * category.
 */
export type ConnectorGroup =
  /** Reach into this Mac: files, screen, input. */
  | "computer"
  /** An app or an account, built in or plugged in. */
  | "service";

export interface ConnectorDef {
  /** Stable id. Also the tool source and the Vault namespace. */
  id: string;
  label: string;
  /** Computer access, or the catalogue. Required: every connection picks. */
  group: ConnectorGroup;
  /** One line the user reads before deciding. */
  description: string;
  /** What it can do, in the user's words: "posta", "takvim". */
  provides: string[];
  /**
   * The separately switchable parts. When a connection declares none, all
   * of its tools are one part that follows the connection's own switch.
   */
  capabilities?: Capability[];
  needs: ConnectorNeed;
  /**
   * Whether it starts switched on. Only the things that are local, read
   * first and already gated by macOS do; anything reaching an account
   * starts off, and the user turns it on deliberately.
   */
  defaultOn: boolean;
  /** Built now, or contributed later by an MCP server the user adds. */
  origin: "builtin" | "mcp";
  /**
   * What the model needs to be told to use this well. Only the switched-on
   * connections contribute theirs, so the prompt describes the tools that
   * actually exist rather than a catalogue of things it cannot call.
   */
  instructions?: string;
}

/**
 * One account inside a connection. A person has a personal Gmail and a work
 * one, and both are "mail" — so the connection is the kind of thing, and an
 * account is an instance of it. Only accounts hold credentials, each under
 * its own key in the Vault.
 */
export interface AccountRef {
  id: string;
  /** What the user calls it: usually the address. */
  label: string;
  /** Which sort of account, e.g. "gmail". Matches a provider id. */
  provider: string;
  addedAt: number;
}

export interface AccountStatus extends AccountRef {
  state: "ready" | "blocked";
  /** What the user must do, when it is blocked. */
  reason?: string;
}

/** A kind of account this connection can add, for the "add" menu. */
export interface ProviderOption {
  id: string;
  label: string;
  /** False while the sign-in for it has not been built; shown greyed out. */
  available: boolean;
  /** Why it is not available yet, if it isn't. */
  note?: string;
}

/** A definition plus what it can currently do. */
export interface Connector extends ConnectorDef {
  /** Asked fresh, never cached: permissions come and go while an app runs. */
  status(): Promise<ConnectorStatus>;
  /** The tools this connection contributes, registered under its id. */
  tools(): ToolDef[];
  /** Starts whatever authorising or permission prompt it needs. */
  connect?(): Promise<ConnectorStatus>;
  /** Forgets the account and anything held for it in the Vault. */
  disconnect?(): Promise<void>;

  /**
   * Connections that hold accounts implement these. The tools do not
   * multiply with the accounts: there is one mail_search, and it takes an
   * account argument. Ten tools per account would bury a small model.
   */
  providers?: ProviderOption[];
  accounts?(): Promise<AccountStatus[]>;
  addAccount?(provider: string, input?: unknown): Promise<AccountStatus>;
  removeAccount?(id: string): Promise<void>;
}

/** What the UI is given for one row of the connections list. */
export interface ConnectorView extends ConnectorDef {
  status: ConnectorStatus;
  /** How many tools it puts in the agent's hands. */
  toolCount: number;
  /** Whether this one can be authorised from the app at all yet. */
  connectable: boolean;
  /**
   * For a connection that is off and needs a macOS permission: whether that
   * permission is already given, so switching it on is all that is left.
   */
  permitted?: boolean;
  /** A read-only permission failure while this connection is switched off. */
  permissionStatus?: Extract<ConnectorStatus, { state: "blocked" }>;
  /** Each part, and whether it is on right now. */
  parts: { id: string; label: string; description?: string; tools: number; on: boolean }[];
  /** The accounts added to it, for connections that hold accounts. */
  accounts: AccountStatus[];
  /** What can be added, for the "add account" menu. Empty when it holds none. */
  providers: ProviderOption[];
}
