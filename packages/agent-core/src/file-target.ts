/** Recognize only explicit write destinations, not source paths or folders.
 * Ambiguous requests retain the ordinary tool authorization flow. */
export function explicitWriteTargets(goal: string): string[] {
  const targets = new Set<string>();
  let start = goal.length;
  for (const m of goal.matchAll(/(?<![\p{L}\p{N}_~:.])((?:~\/|\/)[^\s"'“”`]+)\s+dosyas(?:ına|ina|ında|inda)\b/giu)) { targets.add(m[1]!); start=Math.min(start,m.index!); }
  for (const m of goal.matchAll(/["“`]((?:~\/|\/)[^"”`]+)["”`]\s+dosyas(?:ına|ina|ında|inda)\b/giu)) { targets.add(m[1]!); start=Math.min(start,m.index!); }
  for (const m of goal.matchAll(/\b(?:write|save|create)\b[^\n;.]{0,100}?(?<![\p{L}\p{N}_~:.])((?:~\/|\/)[^\s"'“”`]+)/giu)) { targets.add(m[1]!.replace(/[.,;:]$/, "")); start=Math.min(start,m.index!); }
  // A second named output with no explicit destination is ambiguous: do not
  // accidentally constrain it to the first output's path.
  const names=new Set([...targets].map(p=>p.split("/").at(-1)));
  if ([...goal.slice(start).matchAll(/\b[\w.-]+\.(?:txt|md|csv|json|html|svg|pdf|docx|xlsx|pptx)\b/gi)].some(m=>!names.has(m[0]))) return [];
  return [...targets];
}
