import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, AudioLines, Download, FileText, ListPlus, Mic, Paperclip, Pause, Play, Square, X } from "lucide-react";
import { useStore } from "../store.js";
import { Queue } from "./Queue.js";
import { VoiceBar } from "./VoiceBar.js";
import { MentionIcon, MentionMenu, type MenuItem } from "./MentionMenu.js";
import { filterMentions, insertMention, mentionName, mentionQuery } from "../lib/mention.js";
import type { MentionItem } from "../../../shared/ipc.js";
import { formatDate, lower, t } from "@vunemi/i18n";

/**
 * Voice chat (Vunemi answering out loud, then listening again) stays off
 * until replies are read sentence by sentence and can be interrupted by
 * speaking. Dictation into the text box is unaffected.
 */
const VOICE_CHAT = false;

/** A message brings in this many conversations and meetings at most; the main process holds the same line. */
const MAX_MENTIONS = 5;

export function Composer() {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  // What "@" brought in. The chips decide what is sent; the names in the text are only text.
  const [mentions, setMentions] = useState<MenuItem[]>([]);
  const [caret, setCaret] = useState(0);
  /** What can be brought in, asked for each time the menu opens. */
  const [mentionable, setMentionable] = useState<MentionItem[] | null>(null);
  const [active, setActive] = useState(0);
  /** Where the "@" sits that the user closed the menu on with Esc. */
  const [closed, setClosed] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const { running, paused, pendingStart, model, send, steer, stop, pause, resume } = useStore();
  const { listen, finishListening, cancelListening, setHandsFree, takeDictation, refreshVoice, setVoiceStatus } = useStore();
  // The speech model offer opens when the mic is pressed without one, not before.
  const [offer, setOffer] = useState(false);

  const voice = useStore((s) => s.voice);
  const dictated = useStore((s) => s.dictated);
  const suggested = useStore((s) => s.suggested);

  useEffect(() => {
    void refreshVoice();
    return window.vunemi.onVoiceStatus(setVoiceStatus);
  }, [refreshVoice, setVoiceStatus]);

  // A transcript joins whatever is already typed, rather than replacing it.
  useEffect(() => {
    if (dictated === null) return;
    const said = takeDictation();
    if (said) setText((current) => (current.trim() ? `${current.trim()} ${said}` : said));
    ref.current?.focus();
  }, [dictated, takeDictation]);

  // A suggestion takes the box's place; picking it again changes nothing.
  useEffect(() => {
    if (suggested === null) return;
    useStore.setState({ suggested: null });
    setText(suggested);
    ref.current?.focus();
  }, [suggested]);

  const typing = mentionQuery(text, caret, mentions.map((m) => m.name));
  const query = typing && typing.start !== closed ? typing : null;
  const searching = typing !== null;
  useEffect(() => {
    if (!searching) {
      setClosed(null);
      return;
    }
    let stale = false;
    void window.vunemi
      .listMentions()
      .then((items) => !stale && setMentionable(items))
      .catch(() => !stale && setMentionable([]));
    return () => {
      stale = true;
    };
  }, [searching]);
  useEffect(() => setActive(0), [query?.query]);
  const named = useMemo<MenuItem[]>(
    () =>
      (mentionable ?? []).map((item) => ({
        ...item,
        name: mentionName(
          item.title ||
            (item.kind === "meeting"
              ? t("meetings.untitled", { date: formatDate(item.at, { dateStyle: "medium", timeStyle: "short" }) })
              : t("app.sessions.untitled")),
        ),
      })),
    [mentionable],
  );
  const full = mentions.length >= MAX_MENTIONS;
  const offered = query
    ? filterMentions(named.filter((item) => !mentions.some((m) => m.kind === item.kind && m.id === item.id)), query.query, lower)
    : [];
  // Nothing matches and there is a space in it: a sentence that starts with "@", not a search.
  const menuOpen = query !== null && mentionable !== null && (offered.length > 0 || !/\s/.test(query.query));
  const pickable = menuOpen && !full && offered.length > 0;

  const pick = (item: MenuItem) => {
    if (!query || full) return;
    const next = insertMention(text, query.start, caret, item.name);
    setText(next.text);
    setCaret(next.caret);
    setMentions((current) => [...current, item]);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  // Grow with content, up to a cap.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const addFiles = (paths: string[]) => {
    const fresh = paths.filter(Boolean);
    if (fresh.length === 0) return;
    setError(null);
    setFiles((current) => [...new Set([...current, ...fresh])].slice(0, 10));
    ref.current?.focus();
  };

  // A file dropped anywhere on the window joins the message. Without this
  // the drop did nothing at all: the window refuses to navigate to it.
  useEffect(() => {
    const carriesFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
    const over = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      // Only when it leaves the window, not each element on the way.
      if (e.relatedTarget === null) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      addFiles([...(e.dataTransfer?.files ?? [])].map((f) => window.vunemi.pathForFile(f)));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  // Esc: drop the microphone first, then stop a run.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc on the "@" menu closes the menu, and nothing else.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const state = useStore.getState();
      // Esc always gets you out of whatever voice state you're in first.
      if (state.voice.state !== "off") state.cancelListening();
      else if (state.running) void stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stop]);

  /**
   * Enter sends. While the agent is busy that means "get in line"; ⌘↵ means
   * "stop and take this now". Neither is ever refused for being busy — a
   * thought the user has to hold on to is a thought that gets lost.
   */
  const submit = (now = false) => {
    if ((!text.trim() && files.length === 0) || !model) return;
    // A message with only files in it asks the obvious thing.
    const goal = text.trim() || t("composer.filesOnly");
    const attached = files;
    const brought = mentions.map(({ kind, id, name }) => ({ kind, id, title: name }));
    setError(null);
    // Cleared only once it went: a refused attachment should still be there to fix.
    (now && running ? steer(goal, attached, brought) : send(goal, attached, brought))
      .then(() => {
        setText("");
        setFiles([]);
        setMentions([]);
      })
      .catch((err: unknown) => setError(String(err instanceof Error ? err.message : err).replace(/^.*Error: /, "")));
  };
  const ready = (text.trim() !== "" || files.length > 0) && !!model && !pendingStart;

  const listening = voice.state === "listening";
  const canHear = voice.status?.canHear ?? false;
  const offerable = !canHear && !!voice.status?.download;
  const micTitle = !canHear
    ? (voice.status?.hint ?? t("composer.voice.unavailable"))
    : listening
      ? t("composer.voice.finish")
      : voice.state === "thinking" || voice.state === "speaking"
        ? t("common.cancel")
        : t("composer.voice.speak", { engine: voice.status?.engine ?? t("composer.voice.local") });

  return (
    <div>
      <VoiceBar />
      <Queue />
      {offerable && (offer || voice.status?.downloading) && <VoiceDownload onClose={() => setOffer(false)} />}
      {voice.error && <p className="mb-2 px-1 text-[11.5px] text-danger">{voice.error}</p>}
      {error && <p className="mb-2 px-1 text-[11.5px] text-danger">{error}</p>}
      <div
        className={`relative rounded-2xl border bg-surface shadow-[0_1px_0_rgba(0,0,0,0.02),0_8px_24px_-12px_rgba(0,0,0,0.25)] transition-colors focus-within:border-line-strong ${
          dragging ? "border-ember border-dashed bg-ember-soft/40" : "border-line"
        }`}
      >
        {menuOpen && <MentionMenu items={offered} active={active} full={full} onPick={pick} onHover={setActive} />}
        {dragging && <p className="px-4 pt-3 text-[12px] text-ember">{t("composer.drop")}</p>}
        {(files.length > 0 || mentions.length > 0) && (
          <ul className="flex flex-wrap gap-1.5 px-3 pt-3">
            {mentions.map((m) => (
              <li key={`${m.kind}:${m.id}`} title={m.title || m.name} className="flex max-w-[260px] items-center gap-1.5 rounded-lg border border-line bg-surface-2 py-1 pr-1 pl-2 text-[12px] text-fg">
                <span className="text-muted"><MentionIcon kind={m.kind} /></span>
                <span className="truncate">{m.name}</span>
                <button
                  type="button"
                  onClick={() => setMentions((current) => current.filter((x) => x !== m))}
                  aria-label={t("composer.mention.remove", { name: m.name })}
                  className="grid size-5 shrink-0 place-items-center rounded text-faint hover:bg-surface-3 hover:text-fg"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
            {files.map((path) => (
              <li key={path} title={path} className="flex max-w-[260px] items-center gap-1.5 rounded-lg border border-line bg-surface-2 py-1 pr-1 pl-2 text-[12px] text-fg">
                <FileText size={13} className="shrink-0 text-muted" />
                <span className="truncate">{path.split("/").pop()}</span>
                <button
                  type="button"
                  onClick={() => setFiles((current) => current.filter((p) => p !== path))}
                  aria-label={t("composer.removeFile", { name: path.split("/").pop() ?? path })}
                  className="grid size-5 shrink-0 place-items-center rounded text-faint hover:bg-surface-3 hover:text-fg"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={ref}
          value={text}
          rows={1}
          autoFocus
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (menuOpen && !e.nativeEvent.isComposing) {
              if (e.key === "Escape") {
                e.preventDefault();
                setClosed(query.start);
                return;
              }
              if (pickable && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                setActive((current) => (current + (e.key === "ArrowDown" ? 1 : offered.length - 1)) % offered.length);
                return;
              }
              if (pickable && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
                e.preventDefault();
                pick(offered[active] ?? offered[0]!);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit(e.metaKey || e.ctrlKey);
            }
          }}
          placeholder={
            !model ? t("composer.placeholder.noModel") : running ? t("composer.placeholder.running") : t("composer.placeholder.idle")
          }
          disabled={!model}
          className="selectable block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[14.5px] leading-relaxed text-fg placeholder:text-faint focus:outline-none disabled:cursor-not-allowed"
        />
        <div className="flex items-center justify-between px-3 pb-2.5">
          <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void window.vunemi.pickFiles().then(addFiles)}
            disabled={!model}
            aria-label={t("composer.attach")}
            title={t("composer.attachHint")}
            className="grid size-7 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40"
          >
            <Paperclip size={14} />
          </button>
          <span className="truncate text-[11px] text-faint">
            {running
              ? t("composer.hint.running")
              : listening
                ? t("composer.hint.listening")
                : t("composer.hint.idle")}
          </span>
          </div>
          {running ? (
            <div className="flex items-center gap-1.5">
              {ready && (
                <>
                  <button
                    type="button"
                    onClick={() => submit(true)}
                    title={t("composer.steerHint")}
                    className="rounded-full border border-line px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:border-line-strong hover:text-fg"
                  >
                    {t("composer.steer")}
                  </button>
                  <button
                    type="button"
                    onClick={() => submit(false)}
                    aria-label={t("composer.queue")}
                    title={t("composer.queueHint")}
                    className="grid size-8 place-items-center rounded-full border border-ember/40 bg-ember-soft text-ember transition-colors hover:bg-ember/15"
                  >
                    <ListPlus size={15} />
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => void (paused ? resume() : pause())}
                aria-label={paused ? t("composer.resume") : t("composer.pause")}
                title={paused ? t("composer.resume") : t("composer.pauseHint")}
                className="grid size-8 place-items-center rounded-full border border-line-strong text-fg transition-colors hover:bg-surface-2"
              >
                {paused ? <Play size={12} fill="currentColor" /> : <Pause size={12} fill="currentColor" />}
              </button>
              <button
                type="button"
                onClick={() => void stop()}
                aria-label={t("composer.stop")}
                title={t("composer.stop")}
                className="grid size-8 place-items-center rounded-full bg-fg text-bg transition-opacity hover:opacity-85"
              >
                <Square size={11} fill="currentColor" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              {VOICE_CHAT && <button
                type="button"
                // Without a speech model it offers the download, like the mic;
                // a button that looks usable and does nothing reads as broken.
                onClick={() => (offerable ? setOffer(true) : setHandsFree(!voice.handsFree))}
                disabled={!canHear && !offerable}
                aria-pressed={voice.handsFree}
                aria-label={t("composer.voice.handsFree")}
                title={canHear ? t("composer.voice.handsFreeHint") : micTitle}
                className={`grid size-8 place-items-center rounded-full border transition-colors disabled:opacity-40 ${
                  voice.handsFree ? "border-ember bg-ember-soft text-ember" : "border-line text-muted hover:text-fg"
                }`}
              >
                <AudioLines size={14} />
              </button>}
              <button
                type="button"
                onClick={() => (offerable ? setOffer(true) : void (listening ? finishListening(voice.handsFree) : listen()))}
                disabled={(!canHear && !offerable) || voice.state === "thinking" || voice.state === "speaking"}
                aria-label={listening ? t("composer.voice.stopListening") : t("composer.voice.talk")}
                aria-pressed={listening}
                title={micTitle}
                className={`grid size-8 place-items-center rounded-full border transition-colors disabled:opacity-40 ${
                  listening ? "border-danger bg-danger/10 text-danger" : "border-line text-muted hover:text-fg"
                }`}
              >
                <Mic size={14} />
              </button>
              <button
                type="button"
                onClick={() => submit()}
                disabled={!ready}
                aria-label={t("composer.send")}
                className="grid size-8 place-items-center rounded-full bg-ember text-white transition-all hover:brightness-110 disabled:bg-surface-3 disabled:text-faint"
              >
                <ArrowUp size={16} strokeWidth={2.4} />
              </button>
            </div>
          )}
          </div>
      </div>
    </div>
  );
}

/**
 * The speech model, offered when the mic is pressed without one. It is
 * downloaded once, into Vunemi's own folder, and stays on this Mac.
 */
function VoiceDownload({ onClose }: { onClose: () => void }) {
  const status = useStore((s) => s.voice.status);
  const { downloadVoice, cancelVoiceDownload } = useStore();
  const size = Math.round((status?.download?.bytes ?? 0) / 1_000_000);
  const progress = status?.downloading;
  const percent = progress && progress.total > 0 ? Math.floor((progress.received / progress.total) * 100) : 0;
  return (
    <div className="mb-2 flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2 text-[12.5px]">
      <Mic size={14} className="shrink-0 text-muted" />
      {progress ? (
        <>
          <div className="min-w-0 flex-1">
            <div className="text-fg">{t("composer.voice.downloading", { percent })}</div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-ember transition-[width]" style={{ width: `${percent}%` }} />
            </div>
          </div>
          <button type="button" onClick={() => void cancelVoiceDownload()} className="shrink-0 text-muted hover:text-fg">
            {t("common.cancel")}
          </button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 text-muted">{t("composer.voice.downloadNote", { size })}</span>
          <button
            type="button"
            onClick={() => void downloadVoice()}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-ember px-3 py-1 text-[12px] font-medium text-white hover:brightness-110"
          >
            <Download size={12} />
            {t("composer.voice.download", { size })}
          </button>
          <button type="button" aria-label={t("common.close")} onClick={onClose} className="shrink-0 text-faint hover:text-fg">
            <X size={13} />
          </button>
        </>
      )}
    </div>
  );
}
