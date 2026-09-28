/**
 * One meeting: its summary and transcript side by side, and what can be done
 * with them. Deleting sends the meeting to the Trash.
 */

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Copy, Download, RotateCcw, Search, Trash2 } from "lucide-react";
import type { MeetingState, MeetingSummaryView, MeetingView } from "../../../shared/ipc.js";
import { formatDate, lower, t } from "@vunemi/i18n";
import { useStore } from "../store.js";
import { Markdown } from "./Markdown.js";
import { Transcript } from "./MeetingsView.js";

export function meetingTitle(m: Pick<MeetingSummaryView, "title" | "startedAt">): string {
  return m.title || t("meetings.untitled", { date: formatDate(m.startedAt, { dateStyle: "medium", timeStyle: "short" }) });
}

export function stateLabel(state: MeetingState): string {
  return t(`meetings.state.${state}`);
}

const message = (err: unknown) => String((err as Error).message ?? err).replace(/^.*Error: /, "");

export function MeetingPage({ id, onBack }: { id: string; onBack: () => void }) {
  const model = useStore((s) => s.model);
  const [meeting, setMeeting] = useState<MeetingView | null>(null);
  const [find, setFind] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => void window.vunemi.meetingsGet(id).then(setMeeting);
    load();
    const offStatus = window.vunemi.onMeetings(load);
    const offLine = window.vunemi.onMeetingLine((lineId) => {
      if (lineId === id) load();
    });
    return () => {
      offStatus();
      offLine();
    };
  }, [id]);

  const lines = useMemo(() => {
    const all = meeting?.lines ?? [];
    const q = lower(find.trim());
    return q ? all.filter((l) => lower(l.text).includes(q)) : all;
  }, [meeting, find]);

  if (!meeting) return null;

  const act = async (what: () => Promise<unknown>) => {
    setError(null);
    try {
      await what();
    } catch (err) {
      setError(message(err));
    }
  };

  const rename = async () => {
    if (renaming === null) return;
    const title = renaming.trim();
    setRenaming(null);
    if (title && title !== meeting.title) await act(() => window.vunemi.meetingsRename(id, title));
    void window.vunemi.meetingsGet(id).then(setMeeting);
  };

  const copy = async () => {
    await navigator.clipboard.writeText(meeting.summary ?? meeting.lines.map((l) => l.text).join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const busy = meeting.state === "recording" || meeting.state === "transcribing" || meeting.state === "summarising";
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1100px] px-6 pt-6 pb-10">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <ArrowLeft size={14} />
          {t("meetings.back")}
        </button>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          {renaming !== null ? (
            <input
              autoFocus
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={() => void rename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void rename();
                if (e.key === "Escape") {
                  e.preventDefault();
                  setRenaming(null);
                }
              }}
              aria-label={t("meetings.rename")}
              className="min-w-[280px] flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 text-[17px] font-semibold text-fg outline-none"
            />
          ) : (
            <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-tight text-fg">
              <button type="button" title={t("meetings.rename")} onClick={() => setRenaming(meeting.title || meetingTitle(meeting))} className="max-w-full truncate text-left hover:underline">
                {meetingTitle(meeting)}
              </button>
            </h1>
          )}
          <div className="flex items-center gap-1.5">
            <ToolButton icon={copied ? Check : Copy} label={copied ? t("meetings.copied") : t("meetings.copy")} onClick={() => void copy()} disabled={busy} />
            <ToolButton icon={Download} label={t("meetings.export")} onClick={() => void act(() => window.vunemi.meetingsExport(id))} disabled={busy} />
            {confirming ? (
              <ToolButton
                icon={Trash2}
                label={t("meetings.deleteConfirm")}
                danger
                onClick={() => void act(async () => {
                  await window.vunemi.meetingsDelete(id);
                  onBack();
                })}
              />
            ) : (
              <ToolButton icon={Trash2} label={t("meetings.delete")} onClick={() => setConfirming(true)} disabled={meeting.state === "recording"} />
            )}
          </div>
        </div>
        <p className="mt-1 text-[12.5px] text-muted">
          {formatDate(meeting.startedAt, { dateStyle: "full", timeStyle: "short" })}
          {meeting.state !== "done" && ` · ${stateLabel(meeting.state)}`}
        </p>
        {error && (
          <p role="alert" className="mt-2 text-[12.5px] text-danger">
            {error}
          </p>
        )}

        <div className="mt-5 grid gap-6 lg:grid-cols-2">
          <section>
            {meeting.state === "failed" ? (
              <div className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-[13px] text-fg">
                <p>{meeting.error}</p>
                <button
                  type="button"
                  onClick={() => void act(() => window.vunemi.meetingsRetry(id, model))}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-line-strong px-2.5 py-1 text-[12.5px] transition-colors hover:bg-surface-2"
                >
                  <RotateCcw size={12} />
                  {t("meetings.retry")}
                </button>
              </div>
            ) : busy ? (
              <p className="text-[13px] text-muted">{stateLabel(meeting.state)}…</p>
            ) : meeting.summary ? (
              <Markdown text={meeting.summary} />
            ) : (
              <p className="text-[13px] text-muted">{t("meetings.nothingSaid")}</p>
            )}
          </section>
          <section className="min-w-0">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[13px] font-semibold text-fg">{t("meetings.transcript")}</h2>
              <label className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1">
                <Search size={12} className="text-faint" />
                <input
                  value={find}
                  onChange={(e) => setFind(e.target.value)}
                  placeholder={t("meetings.find")}
                  className="w-44 bg-transparent text-[12.5px] text-fg outline-none placeholder:text-faint"
                />
              </label>
            </div>
            <div className="mt-3">
              <Transcript lines={lines} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function ToolButton({ icon: Icon, label, onClick, disabled, danger }: { icon: typeof Copy; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12.5px] transition-colors disabled:opacity-50 ${
        danger ? "border-danger/50 text-danger hover:bg-danger/10" : "border-line text-muted hover:bg-surface-2 hover:text-fg"
      }`}
    >
      <Icon size={13} />
      {label}
    </button>
  );
}
