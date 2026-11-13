/**
 * Letting another assistant read meetings: VunemiMeetings, the signed Swift
 * program an assistant the user connected (Claude, Codex) starts itself. It
 * reads the meetings folder and the user's switch in settings.json; Vunemi
 * never starts it and never talks to it. This file only finds it and writes
 * what the user adds to the assistant's settings.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The name the assistant lists the connection under. */
const NAME = "vunemi-meetings";

export function bridgeBinary(opts: { packaged: boolean; resourcesPath: string; repo: string }): string | null {
  const path = opts.packaged
    ? join(opts.resourcesPath, "VunemiMeetings")
    : join(opts.repo, "native", "VunemiMeetings", ".build", "release", "VunemiMeetings");
  return existsSync(path) ? path : null;
}

/**
 * What goes into Claude's settings (JSON) and Codex's (TOML). The data folder
 * is named only when it is not the one the program looks in by itself: a
 * development build keeps its own.
 */
export function bridgeSetup(binary: string, userData: string, home: string): { claude: string; codex: string } {
  const args = userData === join(home, "Library", "Application Support", "Vunemi") ? [] : ["--data", userData];
  const server = args.length ? { command: binary, args } : { command: binary };
  // A TOML basic string takes the same escapes JSON writes for a path.
  const codex = [`[mcp_servers.${NAME}]`, `command = ${JSON.stringify(binary)}`];
  if (args.length) codex.push(`args = [${args.map((a) => JSON.stringify(a)).join(", ")}]`);
  return { claude: JSON.stringify({ mcpServers: { [NAME]: server } }, null, 2), codex: codex.join("\n") };
}
