/**
 * What the session process is told about each tool crosses a process
 * boundary, so it must be plain data. A function on a tool's definition
 * (page_read's first part) made every request fail with "An object could not
 * be cloned"; one left out (the page views' old-view head) silently did nothing.
 */
import { expect, it } from "vitest";
import { ToolRegistry } from "@vunemi/agent-core";
import { createBrowserTools, CONTENT_SHOWN, WHOLE_PAGE_MARK } from "@vunemi/browser";
import { SessionServiceBroker } from "../../src/main/session-service-broker.js";

function configuration() {
  const tools = new ToolRegistry();
  for (const tool of createBrowserTools({ kind: null } as never)) tools.register(tool, "browser");
  const options = { tools, grants: new Set<string>(), emit: () => {}, authorize: () => ({ kind: "allow" as const }), onUntrustedOutput: () => {}, switchOn: () => {} };
  return new SessionServiceBroker(options as never, () => "session", () => "en").configuration();
}

it("can be copied to the session process with the browser's tools", () => {
  expect(() => structuredClone(configuration())).not.toThrow();
});

it("carries where page_read's shown part ends, and how an old page view shortens", () => {
  const defs = new Map(structuredClone(configuration()).tools.map((t) => [t.definition.name, t.definition]));
  expect(defs.get("page_read")).toMatchObject({ firstPartChars: CONTENT_SHOWN, firstPartEnd: WHOLE_PAGE_MARK, ephemeral: true });
  expect(defs.get("page_describe")?.stale).toEqual(expect.objectContaining({ lines: 3 }));
});
