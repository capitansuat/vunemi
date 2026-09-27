import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Workspace packages ship TypeScript source, so they must be bundled rather
// than left as runtime requires. Read from the workspace rather than listed
// by hand: such a list is only ever noticed when a new package makes the app
// fail to start, and it has to include packages reached indirectly too — the
// browser's use of perception is as much a bundling problem as our own.
const packagesDir = resolve(import.meta.dirname, "../../packages");
const workspacePackages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    try {
      return (JSON.parse(readFileSync(resolve(packagesDir, entry.name, "package.json"), "utf8")) as { name?: string }).name;
    } catch {
      return undefined;
    }
  })
  .filter((name): name is string => typeof name === "string");

/**
 * Vunemi's Google and Microsoft app registrations, built in (see
 * src/main/oauth-clients.ts). From the environment, or from
 * oauth-clients.local.json beside this file, which git ignores:
 *   { "google": { "clientId": "…", "clientSecret": "…" }, "microsoft": { "clientId": "…" } }
 * Missing ones leave that sign-in out of the build.
 */
function oauthClients(): Record<string, unknown> {
  let local: { google?: { clientId?: string; clientSecret?: string }; microsoft?: { clientId?: string } } = {};
  try {
    local = JSON.parse(readFileSync(resolve(import.meta.dirname, "oauth-clients.local.json"), "utf8")) as typeof local;
  } catch {
    // No file: only the environment counts.
  }
  const googleId = process.env.VUNEMI_GOOGLE_CLIENT_ID ?? local.google?.clientId;
  const googleSecret = process.env.VUNEMI_GOOGLE_CLIENT_SECRET ?? local.google?.clientSecret;
  const microsoftId = process.env.VUNEMI_MICROSOFT_CLIENT_ID ?? local.microsoft?.clientId;
  return {
    ...(googleId && googleSecret && { google: { clientId: googleId, clientSecret: googleSecret } }),
    ...(microsoftId && { microsoft: { clientId: microsoftId } }),
  };
}

const bundleWorkspace = {
  externalizeDeps: { exclude: workspacePackages },
};

export default defineConfig({
  main: {
    define: { __VUNEMI_OAUTH__: JSON.stringify(oauthClients()) },
    build: {
      ...bundleWorkspace,
      // The Vault process is a second entry: out/main/vault.js, forked by main.
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/main/index.ts"),
          vault: resolve(import.meta.dirname, "src/vault-process/index.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      ...bundleWorkspace,
      // Sandboxed preloads must be CommonJS.
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": resolve("src/renderer/src") } },
  },
});
