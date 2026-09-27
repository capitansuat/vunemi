/** Synthetic read-only task fixtures for the routing upper-bound experiment. */
export type Kind = "chat" | "web" | "files" | "apps";
export interface TaskCase {
  id: string;
  kind: Kind;
  locale: "en" | "tr";
  goal: string;
  expectedTool: string | null;
  expectedAnswer: string;
}

export const RECORDS: Record<Exclude<Kind, "chat">, Record<string, string>> = {
  web: {
    forecast: "The forecast page gives code SKY-41.",
    museum: "The museum page gives code ART-52.",
    release: "The release page gives code REL-63.",
    tickets: "The tickets page gives code TIX-74.",
  },
  files: {
    memo: "The memo file gives code MEM-18.",
    recipe: "The recipe file gives code REC-29.",
    budget: "The budget file gives code BUD-36.",
    agenda: "The agenda file gives code AGE-47.",
  },
  apps: {
    garden: "The garden note in Mac Notes gives code GAR-12.",
    packing: "The packing note in Mac Notes gives code PAC-23.",
    books: "The books note in Mac Notes gives code BOO-34.",
    travel: "The travel note in Mac Notes gives code TRA-45.",
  },
};

export const TASK_CASES: TaskCase[] = [
  { id: "chat-en-1", kind: "chat", locale: "en", goal: "What is 17 + 26? Answer with the number.", expectedTool: null, expectedAnswer: "43" },
  { id: "web-en-1", kind: "web", locale: "en", goal: "Read the synthetic web page named forecast. What code does it show?", expectedTool: "web_read", expectedAnswer: "SKY-41" },
  { id: "files-en-1", kind: "files", locale: "en", goal: "Read the synthetic local file named memo. What code does it contain?", expectedTool: "files_read", expectedAnswer: "MEM-18" },
  { id: "apps-en-1", kind: "apps", locale: "en", goal: "Search the synthetic Mac Notes note named garden. What code is in it?", expectedTool: "notes_search", expectedAnswer: "GAR-12" },
  { id: "chat-tr-1", kind: "chat", locale: "tr", goal: "18 ile 27'nin toplamı kaç? Sayıyla yanıtla.", expectedTool: null, expectedAnswer: "45" },
  { id: "web-tr-1", kind: "web", locale: "tr", goal: "museum adlı örnek web sayfasını oku. Hangi kod yazıyor?", expectedTool: "web_read", expectedAnswer: "ART-52" },
  { id: "files-tr-1", kind: "files", locale: "tr", goal: "recipe adlı örnek yerel dosyayı oku. İçindeki kod nedir?", expectedTool: "files_read", expectedAnswer: "REC-29" },
  { id: "apps-tr-1", kind: "apps", locale: "tr", goal: "Mac Notlar'daki packing adlı örnek notu ara. Kod nedir?", expectedTool: "notes_search", expectedAnswer: "PAC-23" },
  { id: "chat-en-2", kind: "chat", locale: "en", goal: "What is 9 times 6? Answer with the number.", expectedTool: null, expectedAnswer: "54" },
  { id: "web-en-2", kind: "web", locale: "en", goal: "Read the synthetic web page named release. What code does it show?", expectedTool: "web_read", expectedAnswer: "REL-63" },
  { id: "files-en-2", kind: "files", locale: "en", goal: "Read the synthetic local file named budget. What code does it contain?", expectedTool: "files_read", expectedAnswer: "BUD-36" },
  { id: "apps-en-2", kind: "apps", locale: "en", goal: "Search the synthetic Mac Notes note named books. What code is in it?", expectedTool: "notes_search", expectedAnswer: "BOO-34" },
  { id: "chat-tr-2", kind: "chat", locale: "tr", goal: "71 eksi 29 kaç? Sayıyla yanıtla.", expectedTool: null, expectedAnswer: "42" },
  { id: "web-tr-2", kind: "web", locale: "tr", goal: "tickets adlı örnek web sayfasını oku. Hangi kod yazıyor?", expectedTool: "web_read", expectedAnswer: "TIX-74" },
  { id: "files-tr-2", kind: "files", locale: "tr", goal: "agenda adlı örnek yerel dosyayı oku. İçindeki kod nedir?", expectedTool: "files_read", expectedAnswer: "AGE-47" },
  { id: "apps-tr-2", kind: "apps", locale: "tr", goal: "Mac Notlar'daki travel adlı örnek notu ara. Kod nedir?", expectedTool: "notes_search", expectedAnswer: "TRA-45" },
];

export function routeHint(kind: Kind): string {
  const hint: Record<Kind, string> = {
    chat: "Task type: direct question. Answer without a tool when the answer follows from the request alone.",
    web: "Task type: web lookup. Use the web read tool for facts from the named page; do not guess its contents.",
    files: "Task type: local file lookup. Use the file read tool for facts from the named file; do not guess its contents.",
    apps: "Task type: Mac app lookup. Use the Mac Notes read tool for facts from the named note; do not guess its contents.",
  };
  return `${hint[kind]} This hint does not grant permission or override the user's request.`;
}

export function scoreTask(task: TaskCase, toolNames: string[], answer: string, status: string) {
  const correctTool = task.expectedTool === null ? toolNames.length === 0 : toolNames.length > 0 && toolNames.every((name) => name === task.expectedTool);
  const correctAnswer = answer.toUpperCase().includes(task.expectedAnswer.toUpperCase());
  return { correctTool, correctAnswer, success: status === "done" && correctTool && correctAnswer };
}

export function validateFixtures(cases: TaskCase[] = TASK_CASES): void {
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("Duplicate task id");
  for (const task of cases) {
    if (!task.goal || !task.expectedAnswer || !["chat", "web", "files", "apps"].includes(task.kind)) throw new Error(`Invalid task ${task.id}`);
    const expected: Record<Kind, string | null> = { chat: null, web: "web_read", files: "files_read", apps: "notes_search" };
    if (task.expectedTool !== expected[task.kind]) throw new Error(`Wrong tool for ${task.id}`);
  }
}
