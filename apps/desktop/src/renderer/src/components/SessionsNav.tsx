import { useState } from "react";
import { FolderOpen, FolderPlus, Folder, Plus, Trash2 } from "lucide-react";
import type { ProjectView, SessionSummary } from "../../../shared/ipc.js";
import { clock, dayLabel } from "../lib/time.js";
import { useStore } from "../store.js";
import { t } from "@ocak/i18n";

const errorText = (e: unknown) =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e);

/**
 * Projects, each with its conversations, then the conversations that belong
 * to none. Switching is closed while a task runs: its events belong to the
 * conversation it started in.
 */
export function SessionsNav() {
  const { sessions, running, addProject } = useStore();
  const [error, setError] = useState<string | null>(null);
  const known = new Set(sessions.projects.map((p) => p.id));
  const loose = sessions.sessions.filter((s) => !s.projectId || !known.has(s.projectId));
  const freshHere = (projectId: string | undefined) =>
    !sessions.sessions.some((s) => s.id === sessions.current) && sessions.project === projectId;

  return (
    <div className="no-drag mt-5 flex min-h-0 flex-1 flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        <div className="flex items-center justify-between px-2.5 pb-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-faint">{t("app.projects.title")}</span>
          <button
            type="button"
            aria-label={t("app.projects.new")}
            title={t("app.projects.new")}
            disabled={running}
            onClick={() => {
              setError(null);
              addProject().catch((e: unknown) => setError(errorText(e)));
            }}
            className="grid size-6 place-items-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
          >
            <FolderPlus size={14} />
          </button>
        </div>
        {error && <p className="px-2.5 pb-1.5 text-[11.5px] leading-snug text-danger">{error}</p>}
        {sessions.projects.length === 0 && (
          <button
            type="button"
            disabled={running}
            onClick={() => {
              setError(null);
              addProject().catch((e: unknown) => setError(errorText(e)));
            }}
            className="w-full rounded-lg px-2.5 py-2 text-left text-[12px] leading-snug text-faint transition-colors hover:bg-surface-2 hover:text-muted disabled:opacity-50"
          >
            {t("app.projects.emptyHint")}
          </button>
        )}
        <ul className="space-y-0.5">
          {sessions.projects.map((project) => (
            <ProjectGroup
              key={project.id}
              project={project}
              items={sessions.sessions.filter((s) => s.projectId === project.id)}
              fresh={freshHere(project.id)}
            />
          ))}
        </ul>

        <div className="px-2.5 pt-4 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">{t("app.sessions.title")}</div>
        <ul className="space-y-0.5">
          {freshHere(undefined) && <FreshRow />}
          {loose.map((s) => <SessionRow key={s.id} item={s} />)}
        </ul>
      </div>
    </div>
  );
}

function ProjectGroup({ project, items, fresh }: { project: ProjectView; items: SessionSummary[]; fresh: boolean }) {
  const { sessions, running, newSession, removeProject, revealProject } = useStore();
  const [confirming, setConfirming] = useState(false);
  const here = sessions.project === project.id;
  return (
    <li>
      <div className="group relative">
        <button
          type="button"
          disabled={running}
          onClick={() => void newSession(project.id)}
          title={t("app.projects.newIn", { name: project.name, folder: project.folder })}
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 pr-14 text-left text-[13px] transition-colors disabled:opacity-50 ${
            here ? "text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"
          }`}
        >
          <Folder size={14} className={`shrink-0 ${here ? "text-ember" : "text-faint"}`} />
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          {project.missing && <span className="shrink-0 text-[11px] text-warn">{t("app.projects.missing")}</span>}
        </button>
        {confirming ? (
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              void removeProject(project.id);
            }}
            onBlur={() => setConfirming(false)}
            autoFocus
            title={t("app.projects.removeNote")}
            className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md bg-danger px-1.5 py-0.5 text-[11px] font-medium text-white"
          >
            {t("app.projects.remove")}
          </button>
        ) : (
          <div className="absolute top-1/2 right-1 flex -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              aria-label={t("app.projects.newSessionLabel", { name: project.name })}
              title={t("app.projects.newSessionLabel", { name: project.name })}
              disabled={running}
              onClick={() => void newSession(project.id)}
              className="grid size-6 place-items-center rounded-md text-faint hover:text-fg disabled:hidden"
            >
              <Plus size={13} />
            </button>
            <button
              type="button"
              aria-label={t("app.projects.revealLabel", { name: project.name })}
              title={t("app.projects.revealLabel", { name: project.name })}
              disabled={project.missing}
              onClick={() => void revealProject(project.id)}
              className="grid size-6 place-items-center rounded-md text-faint hover:text-fg disabled:hidden"
            >
              <FolderOpen size={13} />
            </button>
            <button
              type="button"
              aria-label={t("app.projects.removeLabel", { name: project.name })}
              title={t("app.projects.removeNote")}
              disabled={running}
              onClick={() => setConfirming(true)}
              className="grid size-6 place-items-center rounded-md text-faint hover:text-danger disabled:hidden"
            >
              <Trash2 size={13} />
            </button>
          </div>
        )}
      </div>
      {(fresh || items.length > 0) && (
        <ul className="ml-3.5 space-y-0.5 border-l border-line pl-1.5">
          {fresh && <FreshRow />}
          {items.map((s) => <SessionRow key={s.id} item={s} />)}
        </ul>
      )}
    </li>
  );
}

/** The fresh conversation is not kept until something happens in it. */
function FreshRow() {
  const { runs, view } = useStore();
  return (
    <li className={`rounded-lg px-2.5 py-2 text-[13px] ${view === "chat" ? "bg-surface-2 text-fg" : "text-muted"}`}>
      <div className="truncate">{runs[0]?.goal ?? t("app.newSession")}</div>
      <div className="text-[11.5px] text-faint">{runs.length === 0 ? t("app.sessions.empty") : t("app.sessions.ongoing")}</div>
    </li>
  );
}

function SessionRow({ item: s }: { item: SessionSummary }) {
  const { sessions, running, openSession, deleteSession } = useStore();
  const [confirming, setConfirming] = useState(false);
  const current = s.id === sessions.current;
  const title = s.title || t("app.sessions.untitled");
  return (
    <li className="group relative">
      <button
        type="button"
        disabled={running && !current}
        onClick={() => void openSession(s.id)}
        aria-current={current ? "true" : undefined}
        title={title}
        className={`w-full rounded-lg px-2.5 py-2 pr-8 text-left text-[13px] transition-colors disabled:opacity-50 ${
          current ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"
        }`}
      >
        <div className="truncate">{title}</div>
        <div className="text-[11.5px] text-faint">
          {dayLabel(s.updatedAt)} {clock(s.updatedAt)} · {t("app.sessions.tasks", { count: s.runs })}
          {s.interrupted && <span className="text-warn"> · {t("app.sessions.interrupted")}</span>}
        </div>
      </button>
      {confirming ? (
        <button
          type="button"
          onClick={() => {
            setConfirming(false);
            void deleteSession(s.id);
          }}
          onBlur={() => setConfirming(false)}
          autoFocus
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md bg-danger px-1.5 py-0.5 text-[11px] font-medium text-white"
        >
          {t("common.delete")}
        </button>
      ) : (
        <button
          type="button"
          aria-label={t("app.sessions.deleteLabel", { title })}
          disabled={running && current}
          onClick={() => setConfirming(true)}
          className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-md text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger focus-visible:opacity-100 disabled:hidden"
        >
          <Trash2 size={13} />
        </button>
      )}
    </li>
  );
}
