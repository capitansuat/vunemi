import { describe, expect, it } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { getLocale, LOCALES, setLocale } from "@vunemi/i18n";
import { appMenuTemplate } from "../../src/main/app-menu.js";

const submenu = (item: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] => (Array.isArray(item?.submenu) ? item.submenu : []);
/** Every item of the menus, whatever its depth. */
const flat = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] => items.flatMap((item) => [item, ...flat(submenu(item))]);

describe("application menu", () => {
  it("names the app Vunemi, not the package, in the language of the app", () => {
    const before = getLocale();
    const labels = () => {
      const [first] = appMenuTemplate();
      return { top: first?.label, byRole: Object.fromEntries(submenu(first).filter((i) => i.role).map((i) => [i.role, i.label])) };
    };
    setLocale("en");
    expect(labels()).toEqual({ top: "Vunemi", byRole: { about: "About Vunemi", services: "Services", hide: "Hide Vunemi", hideOthers: "Hide Others", unhide: "Show All", quit: "Quit Vunemi" } });
    setLocale("tr");
    expect(labels().byRole).toMatchObject({ about: "Vunemi Hakkında", hide: "Vunemi'yi gizle", hideOthers: "Diğerlerini gizle", quit: "Vunemi'den çık" });
    setLocale(before);
    expect(JSON.stringify(appMenuTemplate())).not.toContain("@vunemi");
  });

  it("has the standard menus, each under the app's own word for it", () => {
    const before = getLocale();
    setLocale("tr");
    expect(appMenuTemplate().map((m) => m.label)).toEqual(["Vunemi", "Dosya", "Düzen", "Görüntü", "Pencere"]);
    setLocale("en");
    expect(appMenuTemplate().map((m) => m.label)).toEqual(["Vunemi", "File", "Edit", "View", "Window"]);
    setLocale(before);
    const [, file, edit, view, window] = appMenuTemplate();
    const roles = (item: MenuItemConstructorOptions | undefined) => flat(submenu(item)).flatMap((i) => (i.role ? [i.role] : []));
    expect(roles(file)).toEqual(["close"]);
    expect(roles(edit)).toEqual(["undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll", "startSpeaking", "stopSpeaking"]);
    expect(roles(view)).toEqual(["reload", "forceReload", "toggleDevTools", "resetZoom", "zoomIn", "zoomOut", "togglefullscreen"]);
    expect(window?.role).toBe("window");
    expect(roles(window)).toEqual(["minimize", "zoom", "front"]);
  });

  it("leaves no item to Electron's English name, in any language", () => {
    const before = getLocale();
    const english = new Map<string, string>();
    setLocale("en");
    for (const item of flat(appMenuTemplate())) if (item.role && item.label) english.set(item.role, item.label);
    for (const locale of LOCALES) {
      setLocale(locale.code);
      const items = flat(appMenuTemplate()).filter((item) => item.type !== "separator");
      for (const item of items) expect(item.label, `${locale.code} ${item.role ?? ""}`).toBeTruthy();
      if (locale.code === "en") continue;
      const same = items.filter((item) => item.role && item.label === english.get(item.role)).map((item) => item.role);
      // A few words are the same in other languages ("Services" in French, "Zoom" in Spanish, "File" in Italian).
      expect(same.length, `${locale.code}: ${same.join(", ")}`).toBeLessThanOrEqual(2);
    }
    setLocale(before);
  });
});
