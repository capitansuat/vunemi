/**
 * What the installed app does to itself at launch so another program on the
 * Mac cannot slip code into it and read what the vault decrypts.
 *
 * Most of this is done elsewhere, where it cannot be undone at run time:
 *  - the hardened runtime (package.sh signs with it, and the entitlements do
 *    not allow DYLD_* variables or debugging) makes dyld ignore injected
 *    libraries and refuses to let a debugger attach;
 *  - Electron's fuses (package.json "electronFuses") switch off
 *    ELECTRON_RUN_AS_NODE, NODE_OPTIONS and --inspect, and load the app's
 *    code only from its signed, integrity-checked app.asar.
 *
 * What is left is the environment: whatever launched Vunemi can hand it
 * variables that the programs Vunemi starts (the helper, osascript, MCP
 * servers) would otherwise inherit and honour.
 */

/** Variables that tell a loader or a runtime to run extra code. */
const LOADS_CODE = /^(DYLD_|LD_)|^(NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/;

/** Removes those variables in place and returns their names, for the log. */
export function scrubEnv(env: NodeJS.ProcessEnv): string[] {
  const removed = Object.keys(env).filter((key) => LOADS_CODE.test(key));
  for (const key of removed) delete env[key];
  return removed;
}

/**
 * Whether Vunemi was started with Chromium's remote debugging open. Any
 * program on the Mac could then drive the window, and with it the approval
 * cards, which are the user's to answer. Live tests use it; a build for other
 * people must not start with it (see package.sh, OCAK_DISTRIBUTION).
 */
export function remoteDebugging(argv: readonly string[]): boolean {
  return argv.some((arg) => /^--remote-debugging-(port|pipe)(=|$)/.test(arg));
}

/** A local test build says so in its package.json (package.sh adds it unless OCAK_DISTRIBUTION=1). */
export function isLocalTestBuild(packageJson: string): boolean {
  try {
    // The builder's command line may hand the value over as text.
    const mark = (JSON.parse(packageJson) as { tenamiLocalTestBuild?: unknown }).tenamiLocalTestBuild;
    return mark === true || mark === "true";
  } catch {
    return false;
  }
}

/**
 * Whether to offer moving Vunemi to Applications before anything starts: a
 * build for other people, opened from the disk image or Downloads. Run from
 * there, it looks unfinished and each launch comes from a different copy.
 */
export function shouldOfferMove(opts: { packaged: boolean; platform: string; inApplications: boolean; testBuild: boolean }): boolean {
  return opts.packaged && opts.platform === "darwin" && !opts.inApplications && !opts.testBuild;
}

