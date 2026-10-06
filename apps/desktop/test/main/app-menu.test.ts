import { describe, expect, it } from "vitest";
import { getLocale, setLocale } from "@vunemi/i18n";
import { appMenuTemplate } from "../../src/main/app-menu.js";

describe("application menu", () => {
  it("names the app Vunemi, not the package, in the language of the app", () => {
    const before = getLocale();
    const labels = () => {
      const [first] = appMenuTemplate();
      const items = Array.isArray(first?.submenu) ? first.submenu : [];
      return { top: first?.label, byRole: Object.fromEntries(items.filter((i) => i.role).map((i) => [i.role, i.label])) };
    };
    setLocale("en");
    expect(labels()).toEqual({ top: "Vunemi", byRole: { about: "About Vunemi", services: undefined, hide: "Hide Vunemi", hideOthers: undefined, unhide: undefined, quit: "Quit Vunemi" } });
    setLocale("tr");
    expect(labels().byRole).toMatchObject({ about: "Vunemi Hakkında", hide: "Vunemi'yi gizle", quit: "Vunemi'den çık" });
    setLocale(before);
    expect(JSON.stringify(appMenuTemplate())).not.toContain("@vunemi");
  });

  it("keeps the standard menus", () => {
    expect(appMenuTemplate().slice(1).map((m) => m.role)).toEqual(["fileMenu", "editMenu", "viewMenu", "windowMenu"]);
  });
});
