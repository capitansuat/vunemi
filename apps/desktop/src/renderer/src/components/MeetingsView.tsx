/**
 * Meetings: the list, the Record button, and the meeting being recorded,
 * written down as it goes. Recording starts here and nowhere else.
 */

import { useEffect, useRef, useState } from "react";
import { Mic, Pencil, Search, Square, Users } from "lucide-react";
import { RenameInput } from "./RenameInput.js";
import type { MeetingLine, MeetingSpeaker, MeetingStatusView, MeetingSummaryView, MicrophoneView, SpeakersView } from "../../../shared/ipc.js";
import { formatDate, getLocale, t } from "@vunemi/i18n";
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
  const [renaming, setRenaming] = useState<string | null>(null);
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
        {!recording && <SpeakersSetting />}
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
              <li key={m.id} className="group relative">
                {renaming === m.id ? (
                  <div className="px-1 py-1.5">
                    <RenameInput
                      initial={m.title || meetingTitle(m)}
                      label={t("meetings.rename")}
                      onDone={(name) => {
                        setRenaming(null);
                        if (name) void window.vunemi.meetingsRename(m.id, name).then(() => window.vunemi.meetingsList(queryRef.current)).then(setList);
                      }}
                    />
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setOpen(m.id)}
                      onDoubleClick={() => setRenaming(m.id)}
                      className="flex w-full items-baseline gap-3 rounded-md px-2 py-2.5 pr-10 text-left transition-colors hover:bg-surface-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">{meetingTitle(m)}</span>
                      {m.state !== "done" && <span className={`text-[12px] ${m.state === "failed" ? "text-danger" : "text-muted"}`}>{stateLabel(m.state)}</span>}
                      <span className="shrink-0 text-[12px] text-faint">{formatDate(m.startedAt, { dateStyle: "medium", timeStyle: "short" })}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={t("meetings.rename")}
                      title={t("meetings.rename")}
                      onClick={() => setRenaming(m.id)}
                      className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
                    >
                      <Pencil size={12} />
                    </button>
                  </>
                )}
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

/** Telling the others apart after a meeting: off until the user turns it on, and its two models a download they ask for. */
function SpeakersSetting() {
  const [view, setView] = useState<SpeakersView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.vunemi.meetingSpeakers().then(setView).catch(() => {});
    return window.vunemi.onMeetingSpeakers(setView);
  }, []);

  if (!view || view.models.state === "unavailable") return null;
  const models = view.models;
  const size = new Intl.NumberFormat(getLocale(), { style: "unit", unit: "megabyte", maximumFractionDigits: 0 }).format(models.bytes / 1e6);
  const percent = models.state === "downloading" ? Math.round((models.received / models.bytes) * 100) : 0;

  return (
    <section className="mt-4 rounded-xl border border-line bg-surface p-4">
      <label className="flex items-center gap-2 text-[13px] font-medium text-fg">
        <input
          type="checkbox"
          checked={view.on}
          onChange={(e) => {
            setError(null);
            void window.vunemi.setMeetingSpeakers(e.target.checked).then(setView).catch((err: unknown) => setError(message(err)));
          }}
          className="size-3.5 accent-ember"
        />
        {t("meetings.separate.title")}
        {view.on && models.state === "ready" && <span className="ml-auto text-[12px] font-normal text-muted">{t("memory.search.ready")}</span>}
      </label>
      <p className="mt-1 text-[12px] text-muted">{t("meetings.separate.body", { size })}</p>
      {view.on && models.state === "absent" && (
        <button
          type="button"
          onClick={() => {
            setError(null);
            void window.vunemi.downloadMeetingSpeakers().then(setView).catch((err: unknown) => setError(message(err)));
          }}
          className="mt-3 rounded-lg bg-fg px-3.5 py-1.5 text-[12.5px] font-medium text-bg"
        >
          {t("memory.search.download")}
        </button>
      )}
      {models.state === "downloading" && (
        <div className="mt-3 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full bg-ember" style={{ width: `${percent}%` }} />
          </div>
          <span className="text-[12px] text-muted">{t("memory.search.downloading", { percent })}</span>
          <button type="button" onClick={() => void window.vunemi.cancelMeetingSpeakers()} className="text-[12px] text-muted hover:text-fg">
            {t("memory.search.cancel")}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {t("memory.search.failed", { error })}
        </p>
      )}
    </section>
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

/** What one of the others is called: the user's name for them, or their number. */
export function speakerLabel(id: number, speakers: readonly MeetingSpeaker[] = []): string {
  return speakers.find((s) => s.id === id)?.name || t("meetings.person", { n: id });
}

/** The words of a meeting. With `onMove`, a line of the others can be given to another of them. */
export function Transcript({ lines, speakers = [], onMove }: { lines: MeetingLine[]; speakers?: MeetingSpeaker[]; onMove?: (line: MeetingLine, speaker: number) => void }) {
  const who = (line: MeetingLine) => {
    if (line.source === "me") return t("meetings.me");
    if (!onMove || speakers.length < 2) return line.speaker ? speakerLabel(line.speaker, speakers) : t("meetings.others");
    return (
      <select
        aria-label={t("meetings.people.move")}
        title={t("meetings.people.move")}
        value={line.speaker ?? ""}
        onChange={(e) => onMove(line, Number(e.target.value))}
        className="w-full cursor-pointer appearance-none truncate bg-transparent text-[12.5px] text-ok outline-none hover:underline"
      >
        {!line.speaker && <option value="">{t("meetings.others")}</option>}
        {speakers.map((s) => (
          <option key={s.id} value={s.id}>
            {speakerLabel(s.id, speakers)}
          </option>
        ))}
      </select>
    );
  };
  return (
    <ol className="selectable space-y-1.5">
      {lines.map((line, i) => (
        <li key={`${line.source}-${line.start}-${i}`} className="flex gap-2 text-[13.5px] leading-relaxed">
          <span className="w-12 shrink-0 font-mono text-[11.5px] tabular-nums leading-[1.9] text-faint">{elapsed(line.start * 1000)}</span>
          <span className={`w-20 shrink-0 truncate text-[12.5px] leading-[1.75] ${line.source === "me" ? "text-ember" : "text-ok"}`}>
            {who(line)}
          </span>
          <span className="min-w-0 flex-1 text-fg">{line.text}</span>
        </li>
      ))}
    </ol>
  );
}
