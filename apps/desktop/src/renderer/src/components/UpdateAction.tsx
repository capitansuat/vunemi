import { t } from "@vunemi/i18n";
import type { UpdateStatus } from "../../../shared/ipc.js";

/**
 * The one thing to do next about an update: move, download, wait, or restart.
 * In the sidebar notice and in Settings, so the offer can be taken where it
 * is read. `roomy` is the Settings size.
 */
export function UpdateAction({ status, roomy = false }: { status: UpdateStatus; roomy?: boolean }) {
  const button = `mt-2 bg-ember font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 ${roomy ? "rounded-lg px-3 py-1.5 text-[13px]" : "rounded-md px-2.5 py-1 text-[11.5px]"}`;
  if (!status.installable) return <p className="mt-2 text-muted">{t("updates.moveFirst")}</p>;
  if (status.phase === "downloading") return <p className="mt-2 text-muted">{t("updates.downloading")}</p>;
  if (status.phase === "ready") {
    return (
      <>
        <button type="button" className={button} disabled={!status.idle} onClick={() => void window.vunemi.installUpdate()}>
          {t("updates.restart")}
        </button>
        {!status.idle && <p className="mt-1 text-muted">{t("updates.busy")}</p>}
      </>
    );
  }
  // The same download would be refused again: nothing to press.
  if (status.phase === "failed" && status.error === "signature") return <p className="mt-2 text-muted">{t("updates.badSignature")}</p>;
  return (
    <>
      {status.phase === "failed" && <p className="mt-2 text-muted">{t("updates.failed")}</p>}
      <button type="button" className={button} onClick={() => void window.vunemi.downloadUpdate()}>
        {status.offer?.sizeMb ? t("updates.updateSize", { size: status.offer.sizeMb }) : t("updates.update")}
      </button>
    </>
  );
}
