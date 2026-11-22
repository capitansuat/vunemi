/**
 * Checks of a topic, by code with no model, after each pass while Vunemi is
 * idle: links to nothing, pages nothing links to, two pages for one thing,
 * pages whose cited files changed, and linked folders that can't be read.
 * The Memory page lists them under "Needs a look"; nothing is rewritten.
 */
import type { TopicCheckView } from "../../shared/ipc.js";
import type { FolderState } from "./linked.js";
import { keyOf, type TopicStore } from "./store.js";

export type TopicCheck = TopicCheckView;

/** Listed at most, the most pressing first. */
export const MAX_CHECKS = 50;

const ORDER: Record<TopicCheck["kind"], number> = { stale: 0, folder: 1, deadLink: 2, samePage: 3, orphan: 4 };

export function checkTopic(store: TopicStore, topic: string, folderState: (folder: string) => FolderState): TopicCheck[] {
  const checks: TopicCheck[] = [];
  for (const folder of store.linkedFolders(topic)) {
    const state = folderState(folder.path);
    if (state !== "ok") checks.push({ kind: "folder", path: folder.path, state });
  }
  // The Index is made by code: none of this is about it.
  const pages = store.listNotes(topic).filter((n) => !store.generatedNote(topic, n.title));
  const byName = new Map<string, string[]>();
  for (const page of pages) {
    for (const name of new Set([page.title, ...page.aliases].map(keyOf))) byName.set(name, [...(byName.get(name) ?? []), page.title]);
  }
  const linked = new Set<string>();
  for (const page of pages) {
    for (const link of page.links) {
      const to = byName.get(keyOf(link));
      if (to) {
        for (const title of to) if (title !== page.title) linked.add(title);
      } else if (store.resolveWiki(topic, link) === null) checks.push({ kind: "deadLink", page: page.title, link });
    }
    const stale = store.staleCites(topic, page);
    if (stale.length) checks.push({ kind: "stale", page: page.title, files: stale });
  }
  const doubles = new Set<string>();
  for (const titles of byName.values()) {
    const group = [...new Set(titles)].sort();
    if (group.length > 1 && !doubles.has(group.join("\n"))) {
      doubles.add(group.join("\n"));
      checks.push({ kind: "samePage", pages: group });
    }
  }
  // A lone page can't be linked from another.
  if (pages.length > 1) for (const page of pages) if (!linked.has(page.title)) checks.push({ kind: "orphan", page: page.title });
  return checks.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]).slice(0, MAX_CHECKS);
}
