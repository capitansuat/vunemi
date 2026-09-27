import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const source = process.argv[2];
if (!source) {
  process.stderr.write("Kullanım: node select.mjs Online_Mind2Web.json\n");
  process.exit(2);
}

const rows = JSON.parse(readFileSync(source, "utf8"));
if (!Array.isArray(rows)) throw new Error("Veri kümesi bir görev dizisi olmalı.");

const candidates = rows.filter((row) =>
  row && typeof row.task_id === "string" && typeof row.website === "string" &&
  typeof row.task_description === "string" && Number.isInteger(row.reference_length),
);
const score = (id) => createHash("sha256").update(`ocak-om2w-v1:${id}`).digest("hex");
candidates.sort((a, b) => score(a.task_id).localeCompare(score(b.task_id)));

const seen = new Set();
const selected = [];
for (const row of candidates) {
  let host;
  try {
    host = new URL(row.website).hostname.toLowerCase();
  } catch {
    continue;
  }
  if (seen.has(host)) continue;
  seen.add(host);
  selected.push({ task_id: row.task_id, website: row.website, task_description: row.task_description, reference_length: row.reference_length, reviewRequired: true });
  if (selected.length === 20) break;
}
if (selected.length !== 20) throw new Error(`20 farklı site bulunamadı (${selected.length}).`);
process.stdout.write(`${JSON.stringify({ source: "osunlp/Online-Mind2Web", selection: "sha256 ocak-om2w-v1, unique host", tasks: selected }, null, 2)}\n`);
