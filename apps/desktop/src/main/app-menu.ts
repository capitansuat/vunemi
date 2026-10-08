import type { MenuItemConstructorOptions } from "electron";
import { t } from "@vunemi/i18n";

/**
 * The macOS application menu, in the app's language.
 *
 * Electron's own menus name the app after the package ("Quit
 * @vunemi/desktop"), and the app's name cannot change: the keychain entry
 * of the vault is named after it. Its ready-made File, Edit, View and
 * Window menus are English whatever the app speaks, so each item is listed
 * here with its role and our word for it.
 *
 * macOS adds a few items of its own (dictation and emoji under Edit, window
 * tiling under Window). Those are in the language macOS runs the app in,
 * which the app sets at startup (see index.ts).
 */
export function appMenuTemplate(): MenuItemConstructorOptions[] {
  const separator: MenuItemConstructorOptions = { type: "separator" };
  return [
    {
      label: "Vunemi",
      submenu: [
        { role: "about", label: t("menu.about") },
        separator,
        { role: "services", label: t("menu.services") },
        separator,
        { role: "hide", label: t("menu.hide") },
        { role: "hideOthers", label: t("menu.hideOthers") },
        { role: "unhide", label: t("menu.showAll") },
        separator,
        { role: "quit", label: t("presence.quit") },
      ],
    },
    {
      label: t("menu.file"),
      submenu: [{ role: "close", label: t("menu.closeWindow") }],
    },
    {
      label: t("menu.edit"),
      submenu: [
        { role: "undo", label: t("menu.undo") },
        { role: "redo", label: t("menu.redo") },
        separator,
        { role: "cut", label: t("menu.cut") },
        { role: "copy", label: t("menu.copy") },
        { role: "paste", label: t("menu.paste") },
        { role: "pasteAndMatchStyle", label: t("menu.pasteAndMatchStyle") },
        { role: "delete", label: t("menu.delete") },
        { role: "selectAll", label: t("menu.selectAll") },
        separator,
        {
          label: t("menu.speech"),
          submenu: [
            { role: "startSpeaking", label: t("menu.startSpeaking") },
            { role: "stopSpeaking", label: t("menu.stopSpeaking") },
          ],
        },
      ],
    },
    {
      label: t("menu.view"),
      submenu: [
        { role: "reload", label: t("menu.reload") },
        { role: "forceReload", label: t("menu.forceReload") },
        { role: "toggleDevTools", label: t("menu.devTools") },
        separator,
        { role: "resetZoom", label: t("menu.actualSize") },
        { role: "zoomIn", label: t("menu.zoomIn") },
        { role: "zoomOut", label: t("menu.zoomOut") },
        separator,
        { role: "togglefullscreen", label: t("menu.fullScreen") },
      ],
    },
    {
      // The role makes it the menu macOS lists the open windows in.
      role: "window",
      label: t("menu.window"),
      submenu: [
        { role: "minimize", label: t("menu.minimize") },
        { role: "zoom", label: t("menu.zoom") },
        separator,
        { role: "front", label: t("menu.bringAllToFront") },
      ],
    },
  ];
}
