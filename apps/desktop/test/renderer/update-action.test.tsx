/** The update notice's one next step: a build that can't replace itself is told where to download instead. */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale, t } from "@vunemi/i18n";
import type { UpdateStatus } from "../../src/shared/ipc.js";
import { UpdateAction } from "../../src/renderer/src/components/UpdateAction.js";

const status = (over: Partial<UpdateStatus>): UpdateStatus => ({
  phase: "available", offer: { version: "0.5.1", notes: [], sizeMb: 120 }, error: null, checkedAt: 1, installable: true, idle: true, ...over,
});
const text = (s: UpdateStatus) =>
  renderToStaticMarkup(<UpdateAction status={s} />).replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");

describe("the update notice", () => {
  it("offers the download page where this copy can't replace itself (a .deb on Linux)", () => {
    setLocale("en");
    const shown = text(status({ installable: false, downloadPage: "https://github.com/capitansuat/vunemi/releases" }));
    expect(shown).toContain(t("updates.downloadInstead"));
    expect(shown).toContain(t("linux.updatesLink"));
    expect(shown).not.toContain(t("updates.moveFirst"));
    expect(shown).not.toContain(t("updates.update"));
  });

  it("still says to move or install first where there is no download page (the Mac)", () => {
    setLocale("en");
    const shown = text(status({ installable: false }));
    expect(shown).toContain(t("updates.moveFirst"));
    expect(shown).not.toContain(t("linux.updatesLink"));
  });

  it("offers the update itself where it can", () => {
    setLocale("en");
    expect(text(status({}))).toContain(t("updates.updateSize", { size: 120 }));
  });
});
