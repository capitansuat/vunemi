/**
 * Which apps Vunemi may drive, and — more to the point — which it may not.
 *
 * Controlling the desktop is the widest privilege in this product, so the
 * list of exceptions is where most of the safety lives. Three kinds of app
 * are off limits whatever the user says in the moment:
 *
 *  1. **Terminals.** Driving Terminal is a shell, and `system_run` is
 *     deliberately not a shell. Allowing it here would undo that decision in
 *     one keystroke.
 *  2. **Credential stores.** Keychain Access, Passwords, 1Password and the
 *     like. The agent never types a password; it has no business reading one
 *     either, and the Vault exists so it never needs to.
 *  3. **Vunemi itself, and the settings that govern it.** The agent must not be
 *     able to drive its own approval cards, its permissions, or System
 *     Settings. This is Muse's own blocklist rule: the control plane is not a
 *     surface the agent acts on.
 *
 * Everything else is allowed once the user has granted Accessibility, and
 * every action still goes through the Sentinel.
 */

import { t } from "@ocak/i18n";

export interface AppRef {
  name: string;
  bundleId: string;
}

/** Matched on bundle id prefix, so "com.apple.Terminal" covers its variants. */
const BLOCKED_BUNDLES: readonly string[] = [
  // Terminals and shells
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "co.zeit.hyper",
  "dev.warp.Warp",
  "net.kovidgoyal.kitty",
  "io.alacritty",
  "com.github.wez.wezterm",
  // Credentials
  "com.apple.keychainaccess",
  "com.apple.Passwords",
  "com.1password",
  "com.agilebits.onepassword",
  "com.bitwarden",
  "com.dashlane",
  // Vunemi's own control plane, and the settings that govern it
  "com.github.Electron",
  "com.vunemi",
  // Earlier names of the same app, which may still be installed.
  "one.ocak",
  "com.apple.systempreferences",
  "com.apple.SystemSettings",
  // Anything that can run code on this Mac as the user
  "com.apple.ScriptEditor2",
  "com.apple.Automator",
  "com.apple.dt.Xcode",
];

/** For apps whose bundle id we can't see, the name is the next best thing. */
const BLOCKED_NAMES: readonly string[] = [
  // Vunemi itself, by name too: the bundle id above changes when the app is
  // published under its own domain, and the block must not lapse with it.
  "vunemi",
  "tenami",
  "terminal",
  "iterm",
  "warp",
  "kitty",
  "alacritty",
  "wezterm",
  "ghostty",
  "keychain access",
  "anahtar zinciri erişimi",
  "schlüsselbundverwaltung",
  "trousseaux d’accès",
  "trousseaux d'accès",
  "acceso a llaveros",
  "accesso portachiavi",
  "acesso às chaves",
  "связка ключей",
  "钥匙串访问",
  "キーチェーンアクセス",
  "키체인 접근",
  "passwords",
  "parolalar",
  "passwörter",
  "mots de passe",
  "contraseñas",
  "senhas",
  "пароли",
  "密码",
  "パスワード",
  "암호",
  "1password",
  "bitwarden",
  "dashlane",
  "system settings",
  "sistem ayarları",
  "systemeinstellungen",
  "réglages système",
  "ajustes del sistema",
  "impostazioni di sistema",
  "ajustes do sistema",
  "системные настройки",
  "系统设置",
  "システム設定",
  "시스템 설정",
  "ターミナル",
  "终端",
  "터미널",
  "терминал",
  "system preferences",
  "script editor",
  "automator",
  "ocak",
  "electron",
];

/** Why this app is off limits, in the user's language, or null if it isn't. */
export function blockedReason(app: AppRef): string | null {
  const bundle = (app.bundleId ?? "").toLowerCase();
  const name = (app.name ?? "").toLocaleLowerCase("tr");

  if (BLOCKED_BUNDLES.some((b) => bundle.startsWith(b.toLowerCase()))) return reasonFor(name, bundle);
  if (BLOCKED_NAMES.some((n) => name === n || name.includes(n))) return reasonFor(name, bundle);
  return null;
}

function reasonFor(name: string, bundle: string): string {
  const shell = /terminal|ターミナル|终端|터미널|терминал|iterm|warp|kitty|alacritty|wezterm|ghostty|script|automator|xcode/.test(`${name} ${bundle}`);
  const secrets = /keychain|anahtar|password|parola|schlüssel|trousseau|llavero|portachiavi|chaves|ключ|钥匙|キーチェーン|키체인|passw|mots de passe|contraseñ|senha|пароль|密码|パスワード|암호|1password|bitwarden|dashlane/.test(`${name} ${bundle}`);
  if (shell) {
    return t("mac.policy.shell");
  }
  if (secrets) {
    return t("mac.policy.secrets");
  }
  return t("mac.policy.control");
}

/** The visible list, for the model's instructions. */
export function blockedExamples(): string {
  return "terminals, password apps, System Settings and Vunemi itself";
}
