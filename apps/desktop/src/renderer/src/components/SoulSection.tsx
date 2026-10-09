import { useEffect, useState } from "react";
import { t } from "@vunemi/i18n";

/**
 * Settings › Personality: how the user wants Vunemi to write to them, in
 * their own words. Written here and nowhere else; the model has no way to
 * change it.
 */
export function SoulSection() {
  const [kept, setKept] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [max, setMax] = useState(0);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.vunemi.getSoul().then(
      (soul) => {
        setKept(soul.text);
        setText(soul.text);
        setMax(soul.max);
      },
      (err: unknown) => setError(String((err as Error).message ?? err)),
    );
  }, []);

  const length = [...text].length;
  const save = () => {
    setError(null);
    window.vunemi.setSoul(text).then(
      (next) => {
        setKept(next);
        setText(next);
        setSaved(true);
      },
      (err: unknown) => setError(String((err as Error).message ?? err).replace(/^.*Error: /, "")),
    );
  };

  return (
    <div className="mx-auto max-w-[620px]">
      <h2 className="text-[17px] font-semibold text-fg">{t("settings.sections.soul")}</h2>
      <p className="mt-1 text-[13px] text-muted">{t("soul.description")}</p>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
        disabled={kept === null}
        rows={10}
        aria-label={t("soul.label")}
        placeholder={t("soul.placeholder")}
        className="selectable mt-4 w-full resize-y rounded-xl border border-line bg-surface px-3.5 py-3 text-[13.5px] leading-relaxed text-fg outline-none placeholder:text-faint focus-visible:border-line-strong"
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={kept === null || text.trim() === kept || length > max}
          className="rounded-lg bg-fg px-3.5 py-1.5 text-[13px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {t("common.save")}
        </button>
        {saved && <span role="status" className="text-[12.5px] text-muted">{t("soul.saved")}</span>}
        <span className={`ml-auto text-[12px] tabular-nums ${length > max ? "text-danger" : "text-faint"}`}>
          {length} / {max}
        </span>
      </div>
      {length > max && <p role="alert" className="mt-2 text-[12.5px] text-danger">{t("soul.tooLong", { max })}</p>}
      {error && <p role="alert" className="mt-2 text-[12.5px] text-danger">{error}</p>}
      <p className="mt-4 text-[12px] text-faint">{t("soul.applies")}</p>
    </div>
  );
}
