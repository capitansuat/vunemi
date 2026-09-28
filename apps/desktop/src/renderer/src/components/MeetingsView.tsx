/**
 * Meetings: the list, the Record button, and the meeting being recorded,
 * written down as it goes. Recording starts here and nowhere else.
 */

import { useEffect, useRef, useState } from "react";
import { Mic, Search, Square, Users } from "lucide-react";
import type { MeetingLine, MeetingStatusView, MeetingSummaryView, MicrophoneView } from "../../../shared/ipc.js";
import { formatDate, t } from "@vunemi/i18n";
import { useStore } from "../store.js";
import { MeetingPage, meetingTitle, stateLabel } from "./MeetingPage.js";

const MIC_KEY = "vunemi.meetingMicrophone";

function storedMicrophone(): string {
  try {
    return localStorage.getItem(MIC_KEY) ?? "";
  } catch {
    return "";
  }
}

const message = (err: unknown) => String((err as Error).message ?? err).replace(/^.*Error: /, "");

export function MeetingsView() {
  const [status, setStatus] = useState<MeetingStatusView | null>(null);
  const [list, setList] = useState<MeetingSummaryView[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    const refresh = () => void window.vunemi.meetingsList(queryRef.current).then(setList);
    void window.vunemi.meetingsStatus().then(setStatus);
    refresh();
    return window.vunemi.onMeetings((next) => {
      setStatus(next);
      refresh();
    });
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void window.vunemi.meetingsList(query).then(setList), 150);
    return () => clearTimeout(timer);
  }, [query]);

  // Back from a meeting's page: it may have been renamed or deleted there.
  useEffect(() => {
    if (open === null) void window.vunemi.meetingsList(queryRef.current).then(setList);
  }, [open]);

  const record = async () => {
    setError(null);
    setStarting(true);
    try {
      setStatus(await window.vunemi.meetingsStart(storedMicrophone() || undefined));
    } catch (err) {
      setError(message(err));
    } finally {
      setStarting(false);
    }
  };

  if (open) return <MeetingPage id={open} onBack={() => setOpen(null)} />;

  const recording = status?.recording ?? null;
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-6 pt-8 pb-10">
        <h1 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight text-fg">
          <Users size={17} className="text-muted" /> {t("meetings.title")}
        </h1>

        {recording ? (
          <Recording recording={recording} onOpen={() => setOpen(recording.id)} />
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void record()}
              disabled={starting || !status || status.blocked !== null}
              className="inline-flex items-center gap-2 rounded-lg bg-danger px-3.5 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <span className="size-2.5 rounded-full bg-white" />
              {t("meetings.record")}
            </button>
            <MicrophonePicker />
          </div>
        )}
        {!recording && status?.blocked && <p className="mt-2 text-[12.5px] text-muted">{status.blocked}</p>}
        {error && (
          <p role="alert" className="mt-2 text-[12.5px] text-danger">
            {error}
          </p>
        )}

        <label className="mt-6 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
          <Search size={14} className="text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("meetings.search")}
            className="flex-1 bg-transparent text-[13px] text-fg outline-none placeholder:text-faint"
          />
        </label>

        {list.length === 0 ? (
          <p className="mt-6 text-[13px] text-muted">{query.trim() ? t("meetings.noResults") : t("meetings.empty")}</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {list.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => setOpen(m.id)}
                  className="flex w-full items-baseline gap-3 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">{meetingTitle(m)}</span>
                  {m.state !== "done" && <span className={`text-[12px] ${m.state === "failed" ? "text-danger" : "text-muted"}`}>{stateLabel(m.state)}</span>}
                  <span className="shrink-0 text-[12px] text-faint">{formatDate(m.startedAt, { dateStyle: "medium", timeStyle: "short" })}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function MicrophonePicker() {
  const [devices, setDevices] = useState<MicrophoneView[]>([]);
  const [chosen, setChosen] = useState(storedMicrophone);
  useEffect(() => {
    void window.vunemi.meetingsDevices().then(setDevices, () => setDevices([]));
  }, []);
  if (devices.length < 2) return null;
  return (
    <label className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
      <Mic size={13} />
      <span className="sr-only">{t("meetings.microphone")}</span>
      <select
        value={chosen}
        onChange={(e) => {
          setChosen(e.target.value);
          try {
            localStorage.setItem(MIC_KEY, e.target.value);
          } catch {
            // Only a convenience: the system's microphone is used instead.
          }
        }}
        className="rounded-md border border-line bg-surface px-2 py-1 text-[12.5px] text-fg"
      >
        <option value="">{t("meetings.systemMicrophone")}</option>
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function Recording({ recording, onOpen }: { recording: NonNullable<MeetingStatusView["recording"]>; onOpen: () => void }) {
  const model = useStore((s) => s.model);
  const [lines, setLines] = useState<MeetingLine[]>(recording.lines);
  const [levels, setLevels] = useState({ me: 0, others: 0 });
  const [now, setNow] = useState(Date.now());
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines(recording.lines);
    return window.vunemi.onMeetingLine((id, line) => {
      if (id === recording.id) setLines((current) => [...current, line].sort((a, b) => a.start - b.start));
    });
  }, [recording.id]);

  useEffect(() => {
    if (stopping) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void window.vunemi.meetingsLevels().then(setLevels, () => {});
    }, 200);
    return () => clearInterval(timer);
  }, [stopping]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [lines.length]);

  const stop = () => {
    setStopping(true);
    // Resolves when the summary is written; the list follows along meanwhile.
    void window.vunemi.meetingsStop(model).catch((err: unknown) => setError(message(err)));
  };

  return (
    <section className="mt-4 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center gap-3">
        <span className={`size-2.5 rounded-full bg-danger ${stopping ? "" : "animate-pulse"}`} />
        <span className="text-[13.5px] font-medium text-fg">{stopping ? t("meetings.state.transcribing") : t("meetings.recording")}</span>
        <span className="font-mono text-[13px] tabular-nums text-muted">{elapsed(now - recording.startedAt)}</span>
        <div className="ml-auto flex items-center gap-3">
          <Meter label={t("meetings.me")} value={levels.me} />
          <Meter label={t("meetings.others")} value={levels.others} />
          <button
            type="button"
            onClick={stop}
            disabled={stopping}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-[13px] text-fg transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            <Square size={12} className="fill-current" />
            {t("meetings.stop")}
          </button>
        </div>
      </div>
      <p className="mt-2 text-[12.5px] text-muted">{t("meetings.reminder")}</p>
      {error && (
        <p role="alert" className="mt-2 text-[12.5px] text-danger">
          {error}
        </p>
      )}
      <div className="scroll-thin mt-3 max-h-[360px] overflow-y-auto rounded-lg bg-bg p-3">
        {lines.length === 0 ? (
          <p className="text-[12.5px] text-faint">{t("meetings.listening")}</p>
        ) : (
          <Transcript lines={lines} />
        )}
        <div ref={end} />
      </div>
      <div className="mt-2 flex items-center justify-between text-[12px] text-faint">
        <span>{recording.pending > 0 ? t("meetings.behind", { count: recording.pending }) : ""}</span>
        {stopping && (
          <button type="button" onClick={onOpen} className="text-muted underline-offset-2 hover:underline">
            {t("common.open")}
          </button>
        )}
      </div>
    </section>
  );
}

function Meter({ label, value }: { label: string; value: number }) {
  // RMS of speech sits around 0.02–0.2; a square root spreads it over the bar.
  const width = Math.min(100, Math.round(Math.sqrt(Math.min(1, value * 4)) * 100));
  return (
    <span className="flex items-center gap-1.5 text-[11.5px] text-muted" title={label}>
      {label}
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-surface-3">
        <span className="block h-full rounded-full bg-ok transition-[width] duration-150" style={{ width: `${width}%` }} />
      </span>
    </span>
  );
}

export function Transcript({ lines }: { lines: MeetingLine[] }) {
  return (
    <ol className="selectable space-y-1.5">
      {lines.map((line, i) => (
        <li key={`${line.source}-${line.start}-${i}`} className="flex gap-2 text-[13.5px] leading-relaxed">
          <span className="w-12 shrink-0 font-mono text-[11.5px] tabular-nums leading-[1.9] text-faint">{elapsed(line.start * 1000)}</span>
          <span className={`w-20 shrink-0 truncate text-[12.5px] leading-[1.75] ${line.source === "me" ? "text-ember" : "text-ok"}`}>
            {line.source === "me" ? t("meetings.me") : t("meetings.others")}
          </span>
          <span className="min-w-0 flex-1 text-fg">{line.text}</span>
        </li>
      ))}
    </ol>
  );
}
