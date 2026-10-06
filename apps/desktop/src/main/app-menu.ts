import type { MenuItemConstructorOptions } from "electron";
import { t } from "@vunemi/i18n";

/**
 * The macOS application menu. Electron's own names the app after the package
 * ("Quit @vunemi/desktop"), and the app's name cannot change: the keychain
 * entry of the vault is named after it.
 */
export function appMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    {
      label: "Vunemi",
      submenu: [
        { role: "about", label: t("menu.about") },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: t("menu.hide") },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: t("presence.quit") },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}
