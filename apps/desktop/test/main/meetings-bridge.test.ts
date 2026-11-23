import { McpClient } from "@vunemi/mcp";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeBinary, bridgeSetup } from "../../src/main/meetings/bridge.js";
import { SettingsStore } from "../../src/main/settings.js";
const onWindows = process.platform === "win32";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vunemi-bridge-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("bridgeBinary", () => {
  it("finds nothing where nothing was built", () => {
    expect(bridgeBinary({ packaged: true, resourcesPath: dir, repo: dir })).toBeNull();
    expect(bridgeBinary({ packaged: false, resourcesPath: dir, repo: dir })).toBeNull();
  });

  it("is the program in the app's resources once packaged, the built one before", () => {
    writeFileSync(join(dir, "VunemiMeetings"), "");
    expect(bridgeBinary({ packaged: true, resourcesPath: dir, repo: "/nowhere" })).toBe(join(dir, "VunemiMeetings"));
    const built = join(dir, "native", "VunemiMeetings", ".build", "release");
    mkdirSync(built, { recursive: true });
    writeFileSync(join(built, "VunemiMeetings"), "");
    expect(bridgeBinary({ packaged: false, resourcesPath: "/nowhere", repo: dir })).toBe(join(built, "VunemiMeetings"));
  });
});

describe("bridgeSetup", () => {
  const binary = "/Applications/Vunemi.app/Contents/Resources/VunemiMeetings";
  const home = "/Users/ada";

  // Windows: meeting recording is off on Windows (path 3), and these fakes are shell scripts.
  it.skipIf(onWindows)("names only the program when the data folder is the one it looks in by itself", () => {
    const { claude, codex } = bridgeSetup(binary, `${home}/Library/Application Support/Vunemi`, home);
    expect(JSON.parse(claude)).toEqual({ mcpServers: { "vunemi-meetings": { command: binary } } });
    expect(codex).toBe(`[mcp_servers.vunemi-meetings]\ncommand = "${binary}"`);
  });

  it("names the data folder of a build that keeps its own", () => {
    const data = `${home}/Library/Application Support/@vunemi/desktop-dev`;
    const { claude, codex } = bridgeSetup(binary, data, home);
    expect(JSON.parse(claude)).toEqual({ mcpServers: { "vunemi-meetings": { command: binary, args: ["--data", data] } } });
    expect(codex.split("\n")[2]).toBe(`args = ["--data", "${data}"]`);
  });

  it("keeps a path with a quote or a backslash one string", () => {
    const odd = '/Users/a "b"/x\\y/VunemiMeetings';
    const { claude, codex } = bridgeSetup(odd, `${home}/Library/Application Support/Vunemi`, home);
    expect(JSON.parse(claude).mcpServers["vunemi-meetings"].command).toBe(odd);
    expect(codex.split("\n")[1]).toBe('command = "/Users/a \\"b\\"/x\\\\y/VunemiMeetings"');
  });
});

// The program itself, when it was built here (swift build -c release in native/VunemiMeetings):
// Vunemi's own MCP client stands in for the assistant that starts it.
const BUILT = bridgeBinary({ packaged: false, resourcesPath: "", repo: fileURLToPath(new URL("../../../..", import.meta.url)) });

describe.skipIf(!BUILT)("VunemiMeetings, as an assistant connects to it", () => {
  const id = "33333333-3333-4333-8333-333333333333";
  let client: McpClient;

  beforeEach(async () => {
    mkdirSync(join(dir, "meetings", id), { recursive: true });
    writeFileSync(join(dir, "meetings", id, "meeting.json"), JSON.stringify({
      id, title: "", startedAt: Date.now() - 90_000, endedAt: null, language: "tr", summary: null, state: "recording",
      lines: [
        { source: "me", start: 5, end: 9, text: "Deneme toplantısı başlıyor." },
        { source: "others", start: 70, end: 80, text: "Bütçeyi cuma günü konuşalım." },
      ],
    }));
    // The recorder is writing: the meeting is live.
    writeFileSync(join(dir, "meetings", id, "mic.pcm"), Buffer.alloc(4));
    client = new McpClient({ kind: "stdio", command: BUILT!, args: ["--data", dir] });
    await client.start();
  });

  afterEach(() => {
    client.dispose();
  });

  it("offers its tools, and gives nothing until the user's switch is on", async () => {
    expect((await client.listTools()).map((tool) => tool.name)).toEqual([
      "list_recent_meetings", "get_active_meeting", "get_recent_transcript", "get_full_transcript", "search_in_meeting", "get_meeting_summary",
    ]);
    await expect(client.callTool("get_full_transcript", {})).rejects.toThrow(/turned off in Vunemi/);
    // The switch as Vunemi itself writes it.
    new SettingsStore(dir).setMeetingsShared(true);
    expect(JSON.parse(await client.callTool("get_active_meeting", {}))).toMatchObject({ active: true, id, state: "recording", lines: 2 });
    new SettingsStore(dir).setMeetingsShared(false);
    await expect(client.callTool("get_active_meeting", {})).rejects.toThrow(/turned off in Vunemi/);
  });

  it("reads a meeting while it is recorded", async () => {
    new SettingsStore(dir).setMeetingsShared(true);
    const recent = JSON.parse(await client.callTool("get_recent_transcript", { seconds: 60 }));
    expect(recent.lines).toEqual([{ at: "1:10", who: "Others", text: "Bütçeyi cuma günü konuşalım." }]);
    const found = JSON.parse(await client.callTool("search_in_meeting", { query: "butce" }));
    expect(found.matches).toBe(1);
    // A line Vunemi writes down next is there at the next call.
    const file = join(dir, "meetings", id, "meeting.json");
    const meeting = JSON.parse(readFileSync(file, "utf8"));
    meeting.lines.push({ source: "me", start: 85, end: 88, text: "Olur." });
    writeFileSync(file, JSON.stringify(meeting));
    expect(JSON.parse(await client.callTool("get_full_transcript", {})).lines).toHaveLength(3);
  });
});
