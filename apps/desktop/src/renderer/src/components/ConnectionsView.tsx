/**
 * The connections screen: everything Vunemi can reach, and the switch beside
 * each one.
 *
 * Laid out the way people already expect this to look — search, what is
 * connected, what is available — because a permissions screen is a bad place
 * to be original. The wording is where the care goes instead: each row says
 * what the connection can do and, when it is blocked, the sentence that tells
 * the user where to go.
 *
 * A switch that is off is not a preference. Those tools stop existing for the
 * model: absent from its list, and unreachable by name.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Calendar,
  CheckCircle2,
  ChevronDown,
  AppWindow,
  ChevronRight,
  CircleAlert,
  Clock,
  Folder,
  Globe,
  Loader2,
  Mail,
  Monitor,
  Plus,
  Search,
  Trash2,
  Unplug,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { ConnectorView, MailAccountInput, MailAppAccount, NewMcpServer } from "../../../shared/ipc.js";
import { lower, t } from "@vunemi/i18n";
import { useStore } from "../store.js";

export const ICONS: Record<string, LucideIcon> = {
  browser: Globe,
  files: Folder,
  desktop: Monitor,
  apps: AppWindow,
  calendar: Calendar,
  reminders: CheckCircle2,
  mail: Mail,
  automations: Clock,
  shortcuts: Workflow,
};

export function ConnectionsView() {
  const [rows, setRows] = useState<ConnectorView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void window.vunemi.listConnections().then(setRows);
  }, []);

  useEffect(load, [load]);

  // Arrived from a suggestion to switch one on: open it and bring it into view.
  const focus = useStore((s) => s.connectionFocus);
  const openConnection = useStore((s) => s.openConnection);
  useEffect(() => {
    if (!focus || !rows) return;
    setOpen(focus);
    openConnection(null);
    requestAnimationFrame(() => document.getElementById(`connection-${focus}`)?.scrollIntoView({ block: "center" }));
  }, [focus, rows, openConnection]);

  // A permission granted in System Settings while this screen is open should
  // appear without the user having to think about refreshing.
  useEffect(() => {
    const timer = setInterval(load, 4_000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (id: string, what: () => Promise<ConnectorView[]>) => {
    setBusy(id);
    setError(null);
    try {
      setRows(await what());
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const { computer, connected, available } = useMemo(() => {
    const needle = lower(query.trim());
    const matching = (rows ?? []).filter(
      (row) =>
        needle === "" ||
        lower(row.label).includes(needle) ||
        row.provides.some((p) => lower(p).includes(needle)),
    );
    const services = matching.filter((row) => row.group === "service");
    return {
      // The Mac's own permissions are a short, fixed list, so they are not
      // split further: seeing all three at once is the point.
      computer: matching.filter((row) => row.group === "computer"),
      connected: services.filter((row) => row.status.state !== "off"),
      available: services.filter((row) => row.status.state === "off"),
    };
  }, [rows, query]);

  const render = (row: ConnectorView) => (
    <Row
      key={row.id}
      row={row}
      busy={busy === row.id}
      disabled={busy !== null}
      open={open === row.id}
      onToggleOpen={() => setOpen(open === row.id ? null : row.id)}
      act={act}
    />
  );

  return (
    <div className="mx-auto w-full max-w-[760px] flex-1 overflow-y-auto px-6 py-8">
      <h1 className="text-[17px] font-semibold tracking-tight text-fg">{t("app.nav.connections")}</h1>
      <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-muted">
        {t("connections.intro")}
      </p>

      <div className="mt-5 flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2">
        <Search size={14} className="shrink-0 text-faint" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("connections.search")}
          className="w-full bg-transparent text-[13px] text-fg placeholder:text-faint focus:outline-none"
        />
      </div>

      {error && (
        <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
          <CircleAlert size={13} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      {rows === null && <p className="mt-6 text-[13px] text-faint">{t("common.loading")}</p>}

      <Group
        title={t("connections.computer")}
        note={t("connections.computerNote")}
        count={computer.length}
      >
        <ul className="space-y-2">{computer.map(render)}</ul>
      </Group>

      <Group
        title={t("app.nav.connections")}
        note={t("connections.servicesNote")}
        count={connected.length + available.length}
      >
        <Section title={t("connections.connected")} count={connected.length}>
          {connected.map(render)}
        </Section>
        <Section title={t("connections.available")} count={available.length}>
          {available.map(render)}
        </Section>
      </Group>

      <div className="mt-4 rounded-xl border border-dashed border-line p-4">
        {adding ? (
          <AddServer
            onCancel={() => setAdding(false)}
            onAdded={(next) => {
              setRows(next);
              setAdding(false);
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-2 text-[13px] text-fg transition-colors hover:text-ember"
          >
            <Plus size={14} />
            {t("connections.addMcp")}
          </button>
        )}
        <p className="mt-2 max-w-[62ch] text-[12px] leading-relaxed text-faint">
          {t("connections.mcpNote")}
        </p>
      </div>
    </div>
  );
}

/**
 * One of the two halves of the screen.
 *
 * The split is the point: "what may Vunemi do on this Mac" is a fixed list of
 * permissions, and "what else may it reach" is a catalogue that grows every
 * time someone plugs a server in. Read as one list the second buries the
 * first, and the blast radius on the machine stops being visible.
 */
function Group({ title, note, count, children }: { title: string; note: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="text-[13px] font-semibold tracking-tight text-fg">{title}</h2>
      <p className="mt-0.5 mb-3 max-w-[62ch] text-[12px] leading-relaxed text-faint">{note}</p>
      {children}
    </section>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <>
      <h3 className="mt-4 mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-faint">{title}</h3>
      <ul className="space-y-2">{children}</ul>
    </>
  );
}

function Row({
  row,
  busy,
  disabled,
  open,
  onToggleOpen,
  act,
}: {
  row: ConnectorView;
  busy: boolean;
  disabled: boolean;
  open: boolean;
  onToggleOpen: () => void;
  act: (id: string, what: () => Promise<ConnectorView[]>) => Promise<boolean>;
}) {
  const Icon = ICONS[row.id] ?? (row.origin === "mcp" ? Unplug : Globe);
  const on = row.status.state !== "off";
  const blocked = row.status.state === "blocked" ? row.status : row.id === "desktop" ? row.permissionStatus ?? null : null;

  return (
    <li id={`connection-${row.id}`} className="rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-3 p-3.5">
        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={open}
          className="grid size-5 shrink-0 place-items-center text-faint transition-colors hover:text-fg"
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2">
          <Icon size={15} className={on ? "text-ember" : "text-faint"} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium text-fg">{row.label}</span>
            <StatusChip row={row} />
          </div>
          <p className="truncate text-[12.5px] text-muted">{row.description}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {busy && <Loader2 size={14} className="animate-spin text-faint" />}
          {!on ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                void act(row.id, () =>
                  row.connectable && !row.permitted ? window.vunemi.connectConnection(row.id) : window.vunemi.setConnection(row.id, true),
                )
              }
              title={row.permitted ? t("connections.permitted") : undefined}
              className="text-[12.5px] font-medium text-ember transition-opacity hover:opacity-75 disabled:opacity-40"
            >
              {row.connectable && !row.permitted ? t("connections.connect") : t("connections.turnOn")}
            </button>
          ) : (
            <Switch
              on={on}
              label={t("connections.switchLabel", { name: row.label })}
              disabled={disabled}
              onChange={(next) => void act(row.id, () => window.vunemi.setConnection(row.id, next))}
            />
          )}
        </div>
      </div>

      {/* What is wrong, and a way to fix it, without opening the row: a
          blocked connection is the one thing on this screen that needs
          the user to act. */}
      {blocked && (
        <div className="-mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 pb-3 pl-[4.25rem]">
          <p className="flex w-full items-start gap-1.5 text-[12px] leading-relaxed text-danger">
            <CircleAlert size={13} className="mt-0.5 shrink-0" />
            {blocked.reason}
          </p>
          {on && row.connectable && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => void act(row.id, () => window.vunemi.connectConnection(row.id))}
              className="rounded-md bg-ember px-2.5 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-85 disabled:opacity-40"
            >
              {t("connections.requestPermission")}
            </button>
          )}
          {blocked.settings && (
            <button
              type="button"
              onClick={() => void window.vunemi.openPrivacySettings(blocked.settings!)}
              className="text-[12px] font-medium text-ember transition-opacity hover:opacity-75"
            >
              {t("connections.openSettings")}
            </button>
          )}
        </div>
      )}

      {open && <Details row={row} disabled={disabled} act={act} />}
    </li>
  );
}

function Details({
  row,
  disabled,
  act,
}: {
  row: ConnectorView;
  disabled: boolean;
  act: (id: string, what: () => Promise<ConnectorView[]>) => Promise<boolean>;
}) {
  const [mailForm, setMailForm] = useState(false);
  const [mailProvider, setMailProvider] = useState<"gmail" | "imap" | "outlook">("imap");
  const [mail, setMail] = useState<MailAccountInput>({
    email: "", imapHost: "", imapPort: 993, smtpHost: "", smtpPort: 587,
    smtpSecure: false, user: "", password: "",
  });
  const field = (key: keyof MailAccountInput, value: string | number | boolean) => setMail((current) => ({ ...current, [key]: value }));
  // The Mac's Mail app: its accounts, listed for the user to choose from.
  const [mailApp, setMailApp] = useState<MailAppAccount[] | null>(null);
  const [mailAppOpen, setMailAppOpen] = useState(false);
  const [mailAppError, setMailAppError] = useState<string | null>(null);
  const loadMailApp = () => {
    setMailAppError(null);
    window.vunemi.mailAppAccounts().then(setMailApp, (err: unknown) => setMailAppError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="border-t border-line px-3.5 py-3">
      {row.parts.length > 0 ? (
        <ul className="space-y-1.5">
          {row.parts.map((part) => (
            <li key={part.id} className="flex items-start gap-2.5">
              <Switch
                on={part.on}
                label={`${row.label} — ${part.label}`}
                disabled={disabled || row.status.state !== "ready"}
                onChange={(next) => void act(row.id, () => window.vunemi.setConnectionPart(row.id, part.id, next))}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12.5px] font-medium text-fg">{part.label}</span>
                  {part.tools > 0 && <span className="text-[11px] text-faint">{t("turn.tools", { count: part.tools })}</span>}
                </div>
                {part.description && <p className="text-[11.5px] leading-snug text-muted">{part.description}</p>}
                {row.id === "desktop" && part.id === "act" && row.status.state !== "ready" && (
                  <p className="text-[11.5px] leading-snug text-danger">{t("connections.controlNeedsDesktop")}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {row.provides.map((what) => (
            <span key={what} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">
              {what}
            </span>
          ))}
          <span className="text-[11px] text-faint">{t("turn.tools", { count: row.toolCount })}</span>
        </div>
      )}

      {row.accounts.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {row.accounts.map((account) => (
            <li key={account.id} className="flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{account.label}</span>
              {account.state === "blocked" && <span className="text-[11px] text-danger">{account.reason ?? t("connections.problem")}</span>}
              <button
                type="button"
                disabled={disabled}
                onClick={() => void act(row.id, () => window.vunemi.removeAccount(row.id, account.id))}
                className="text-[11.5px] text-faint transition-colors hover:text-danger disabled:opacity-40"
              >
                {t("connections.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}

      {row.providers.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11.5px] text-faint">{row.id === "calendar" ? t("connections.viaMac") : t("connections.addAccount")}</span>
          {row.providers.map((provider) => (
            row.id === "calendar" ? <span key={provider.id} title={provider.note} className="rounded-full border border-line px-2 py-0.5 text-[11.5px] text-muted">
              {provider.label}
            </span> : <button
              key={provider.id}
              type="button"
              disabled={disabled || !provider.available}
              title={provider.note}
              onClick={() => row.id === "mail" && provider.id === "applemail"
                ? (setMailForm(false), setMailAppOpen(true), setMailApp(null), loadMailApp())
                : row.id === "mail" && (provider.id === "imap" || provider.id === "gmail" || provider.id === "outlook")
                ? (setMailAppOpen(false), setMailProvider(provider.id), setMailForm(true))
                // Google and Microsoft sign-in needs no form: their own page opens in the browser.
                : void act(row.id, () => window.vunemi.addAccount(row.id, provider.id))}
              className="rounded-full border border-line px-2 py-0.5 text-[11.5px] text-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-40"
            >
              {provider.label}
              {!provider.available && ` (${t("connections.soon")})`}
            </button>
          ))}
          {row.id === "calendar" && <p className="w-full text-[11.5px] text-muted">{t("connections.calendarHint")}</p>}
        </div>
      )}

      {row.id === "mail" && mailForm && (
        <form className="mt-3 grid gap-2 rounded-lg border border-line bg-surface-2 p-3" onSubmit={(event) => {
          event.preventDefault();
          void act(row.id, () => window.vunemi.addAccount(row.id, mailProvider, mail)).then((ok) => {
            if (ok) {
              setMailForm(false);
              setMail((current) => ({ ...current, password: "" }));
            }
          });
        }}>
          <p className="text-[12px] text-muted">
            {mailProvider === "gmail"
              ? t("connections.mail.gmailHint")
              : mailProvider === "outlook"
                ? t("connections.mail.outlookHint")
                : t("connections.mail.imapHint")}
            {mailProvider !== "outlook" && ` ${t("connections.mail.passwordNote")}`}
          </p>
          {mailProvider === "outlook" ? <input required aria-label={t("connections.mail.clientId")} placeholder={t("connections.mail.clientIdPlaceholder")} value={mail.clientId ?? ""}
            onChange={(event) => field("clientId", event.target.value)} className="rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg" /> : <input required type="email" autoComplete="email" placeholder={t("connections.mail.email")} value={mail.email}
            onChange={(event) => field("email", event.target.value)} className="rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg" />
          }
          {mailProvider === "imap" && <input required placeholder={t("connections.mail.user")} value={mail.user}
            onChange={(event) => field("user", event.target.value)} className="rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg" />
          }
          {mailProvider === "imap" && <div className="grid grid-cols-[1fr_80px] gap-2">
            <input required placeholder={t("connections.mail.imapHost")} value={mail.imapHost}
              onChange={(event) => field("imapHost", event.target.value)} className="min-w-0 rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg" />
            <input required type="number" min="1" max="65535" aria-label={t("connections.mail.imapPort")} value={mail.imapPort}
              onChange={(event) => field("imapPort", Number(event.target.value))} className="min-w-0 rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg" />
          </div>}
          {mailProvider === "imap" && <div className="grid grid-cols-[1fr_80px] gap-2">
            <input required placeholder={t("connections.mail.smtpHost")} value={mail.smtpHost}
              onChange={(event) => field("smtpHost", event.target.value)} className="min-w-0 rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg" />
            <input required type="number" min="1" max="65535" aria-label={t("connections.mail.smtpPort")} value={mail.smtpPort}
              onChange={(event) => field("smtpPort", Number(event.target.value))} className="min-w-0 rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg" />
          </div>}
          {mailProvider === "imap" && <label className="flex items-center gap-2 text-[12px] text-muted">
            <input type="checkbox" checked={mail.smtpSecure} onChange={(event) => field("smtpSecure", event.target.checked)} />
            {t("connections.mail.smtpTls")}
          </label>}
          {mailProvider !== "outlook" && <input required type="password" autoComplete="new-password" placeholder={t("connections.mail.appPassword")} value={mail.password}
            onChange={(event) => field("password", event.target.value)} className="rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-fg" />
          }
          <div className="flex gap-2">
            <button type="submit" disabled={disabled} className="rounded-md bg-ember px-3 py-1.5 text-[12px] text-white disabled:opacity-50">{t("connections.mail.connect")}</button>
            <button type="button" onClick={() => { setMailForm(false); field("password", ""); }} className="px-2 text-[12px] text-muted">{t("common.cancel")}</button>
          </div>
        </form>
      )}

      {row.id === "mail" && mailAppOpen && (
        <div className="mt-3 grid gap-2 rounded-lg border border-line bg-surface-2 p-3">
          <p className="text-[12px] text-muted">{t("connections.mail.appleMailPick")}</p>
          {mailAppError && <p role="alert" className="text-[12px] text-danger">{mailAppError}</p>}
          {mailApp?.length === 0 && <p className="text-[12px] text-faint">{t("connections.mail.appleMailNone")}</p>}
          {mailApp && mailApp.length > 0 && (
            <ul className="space-y-1">
              {mailApp.map((account) => (
                <li key={account.name} className="flex items-center gap-2 rounded-md bg-surface px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">
                    {account.name}
                    {account.emails[0] && <span className="ml-2 text-[11.5px] text-faint">{account.emails[0]}</span>}
                  </span>
                  {account.connected ? (
                    <span className="text-[11.5px] text-muted">{t("connections.mail.appleMailConnected")}</span>
                  ) : (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => void act(row.id, () => window.vunemi.addAccount(row.id, "applemail", { account: account.name })).then((ok) => ok && loadMailApp())}
                      className="rounded-md bg-ember px-2.5 py-1 text-[11.5px] text-white disabled:opacity-50"
                    >
                      {t("connections.mail.connect")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div>
            <button type="button" onClick={() => setMailAppOpen(false)} className="px-1 text-[12px] text-muted">{t("common.cancel")}</button>
          </div>
        </div>
      )}

      {row.origin === "mcp" && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => void act(row.id, () => window.vunemi.removeConnection(row.id))}
          className="mt-3 flex items-center gap-1.5 text-[12px] text-faint transition-colors hover:text-danger disabled:opacity-40"
        >
          <Trash2 size={12} />
          {t("connections.removeConnection")}
        </button>
      )}
    </div>
  );
}

/** The form for a server the user runs themselves. */
function AddServer({ onCancel, onAdded }: { onCancel: () => void; onAdded: (rows: ConnectorView[]) => void }) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"stdio" | "http">("stdio");
  const [value, setValue] = useState("");
  const [secrets, setSecrets] = useState<{ key: string; value: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const filled = secrets.filter((item) => item.key.trim() || item.value);
    if (filled.some((item) => !item.key.trim() || !item.value)) {
      setError(t("connections.mcp.secretIncomplete"));
      setBusy(false);
      return;
    }
    if (new Set(filled.map((item) => item.key.trim().toLowerCase())).size !== filled.length) {
      setError(t("connections.mcp.secretDuplicate"));
      setBusy(false);
      return;
    }
    const env = Object.fromEntries(filled.map((item) => [item.key.trim(), item.value]));
    const server: NewMcpServer = { label, kind, ...(kind === "stdio" ? { command: value } : { url: value }), ...(filled.length ? { env } : {}) };
    try {
      const result = await window.vunemi.addMcpServer(server);
      if (result.ok) onAdded(result.rows);
      else setError(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={t("connections.mcp.name")}
        autoFocus
        className="w-full rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-[13px] text-fg placeholder:text-faint focus:outline-none focus:border-line-strong"
      />

      <div className="flex gap-1.5">
        {(["stdio", "http"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setKind(option)}
            className={`rounded-full px-2.5 py-1 text-[11.5px] transition-colors ${
              kind === option ? "bg-ember-soft text-ember" : "bg-surface-2 text-muted hover:text-fg"
            }`}
          >
            {option === "stdio" ? t("connections.mcp.command") : t("connections.mcp.address")}
          </button>
        ))}
      </div>

      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={kind === "stdio" ? "npx -y @some/mcp-server" : "https://server.example/mcp"}
        className="w-full rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12.5px] text-fg placeholder:text-faint focus:outline-none focus:border-line-strong"
      />

      <div className="space-y-2 rounded-lg border border-line p-2.5">
        <p className="text-[11.5px] text-muted">{kind === "stdio" ? t("connections.mcp.env") : t("connections.mcp.headers")} · {t("connections.mcp.inVault")}</p>
        {secrets.map((item, index) => (
          <div key={index} className="flex gap-1.5">
            <input aria-label={t("connections.mcp.secretName", { n: index + 1 })} placeholder={kind === "stdio" ? "API_KEY" : "Authorization"}
              value={item.key} onChange={(event) => setSecrets((rows) => rows.map((row, i) => i === index ? { ...row, key: event.target.value } : row))}
              className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] text-fg" />
            <input aria-label={t("connections.mcp.secretValue", { n: index + 1 })} type="password" autoComplete="off" placeholder={t("vault.form.value")}
              value={item.value} onChange={(event) => setSecrets((rows) => rows.map((row, i) => i === index ? { ...row, value: event.target.value } : row))}
              className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-[12px] text-fg" />
            <button type="button" aria-label={t("connections.mcp.secretRemove", { n: index + 1 })} onClick={() => setSecrets((rows) => rows.filter((_, i) => i !== index))}
              className="px-1.5 text-[12px] text-muted hover:text-danger">{t("common.delete")}</button>
          </div>
        ))}
        <button type="button" onClick={() => setSecrets((rows) => [...rows, { key: "", value: "" }])}
          className="text-[11.5px] text-ember">{t("vault.add")}</button>
      </div>

      {error && <p className="text-[12px] text-danger">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !label.trim() || !value.trim()}
          onClick={() => void submit()}
          className="flex items-center gap-1.5 rounded-full bg-ember px-3 py-1.5 text-[12.5px] text-white transition-all hover:brightness-110 disabled:bg-surface-3 disabled:text-faint"
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
          {t("connections.mcp.add")}
        </button>
        <button type="button" onClick={onCancel} className="text-[12.5px] text-faint transition-colors hover:text-fg">
          {t("common.cancel")}
        </button>
      </div>

      <p className="text-[11.5px] leading-relaxed text-faint">
        {t("connections.mcp.commandNote")}
      </p>
    </div>
  );
}

function StatusChip({ row }: { row: ConnectorView }) {
  const [text, tone] =
    row.status.state === "ready"
      ? [t("connections.state.ready"), "text-ember bg-ember-soft"]
      : row.status.state === "blocked"
        ? [t("connections.state.blocked"), "text-danger bg-danger/10"]
        : [t("connections.state.off"), "text-faint bg-surface-2"];
  return <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10.5px] ${tone}`}>{text}</span>;
}

export function Switch({
  on,
  label,
  disabled,
  onChange,
}: {
  on: boolean;
  label: string;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-ember" : "bg-surface-3"
      }`}
    >
      <span
        className={`absolute top-[3px] size-4 rounded-full bg-white shadow transition-all ${on ? "left-[19px]" : "left-[3px]"}`}
      />
    </button>
  );
}
