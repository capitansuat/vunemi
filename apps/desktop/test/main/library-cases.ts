/**
 * A synthetic history for measuring the library: conversations and meetings
 * nobody had, and requests that are or are not about one of them. No real
 * person, place of work or conversation is in here.
 */
import type { AgentEvent } from "@vunemi/agent-core";
import type { Meeting } from "../../src/main/meetings/store.js";

const day = (d: number): number => Date.UTC(2026, 8, d, 10);

const task = (runId: string, goal: string, answer: string): AgentEvent[] => [
  { type: "run.started", runId, goal, model: "m", at: 0 },
  { type: "message.delta", runId, stepId: `${runId}-1`, text: answer },
  { type: "run.finished", runId, status: "done", detail: "", at: 0 } as AgentEvent,
];

export interface KeptConversation { id: string; title: string; updatedAt: number; events: AgentEvent[] }

export const CONVERSATIONS: KeptConversation[] = [
  { id: "s_lisbon", title: "Lizbon otelleri", updatedAt: day(3), events: [
    ...task("a1", "Lizbon'da nehre yakın, gecelik 150 avronun altında üç otel bul", "Üç seçenek: Casa do Rio (Alfama, 128 EUR), Hotel Miradouro (Chiado, 142 EUR), Pensão Azul (Baixa, 96 EUR)."),
    ...task("a2", "Hangisinde kahvaltı dahil?", "Yalnız Hotel Miradouro'da kahvaltı dahil. Onu seçmeni öneririm; sen de Miradouro'da karar kıldın."),
  ] },
  { id: "s_tax", title: "Tax receipts", updatedAt: day(4), events: task("b1", "Which receipts do I need to keep for this year's tax return?", "Keep rent, health insurance and the two donation receipts. The filing deadline you mentioned is 31 March.") },
  { id: "s_logo", title: "Fırın logosu renkleri", updatedAt: day(5), events: task("c1", "Mahalle fırınımın logosu için bir renk paleti öner", "Sıcak hardal sarısı (#D9A441) ve koyu kahve (#4A2E1F). İkincil renk olarak krem (#F4E9D8).") },
  { id: "s_run", title: "10K training plan", updatedAt: day(6), events: task("d1", "Make me a ten kilometre training plan for eight weeks", "Four runs a week: two easy, one interval session on Wednesdays, one long run on Sundays building to 12 km.") },
  { id: "s_cv", title: "CV summary", updatedAt: day(7), events: task("e1", "Tighten the summary at the top of my CV", "Product designer with eight years in fintech; led the redesign of a payments app used by two million people.") },
  { id: "s_rice", title: "Risotto", updatedAt: day(8), events: task("f1", "How long does risotto rice cook and how much stock do I need?", "About eighteen minutes; roughly three parts stock to one part rice, added a ladle at a time.") },
  { id: "s_router", title: "Modem kurulumu", updatedAt: day(9), events: task("g1", "Yeni modemi kurarken misafir ağını nasıl açarım?", "Arayüzde Kablosuz > Misafir Ağı'nı aç; adını EvMisafir yaptık ve 5 GHz bandını kapalı bıraktık.") },
  { id: "s_gift", title: "Anneme hediye", updatedAt: day(10), events: task("h1", "Annemin doğum günü için 2000 liraya kadar hediye fikri ver", "Seramik çay takımı, el dokuması şal ya da bir fotoğraf albümü. Sen şalı beğendin, lacivert olanı.") },
  { id: "s_sql", title: "Slow query", updatedAt: day(11), events: task("i1", "Why is this orders query slow?", "It scans the whole table: add an index on (customer_id, created_at) and select only the columns you need.") },
  { id: "s_plant", title: "Monstera yaprakları", updatedAt: day(12), events: task("j1", "Monsteramın yaprakları sararıyor, neden?", "Büyük olasılıkla fazla sulama. Toprağın üst üç santimi kuruyunca sula, haftada bir yeter.") },
  { id: "s_lease", title: "Lease clause", updatedAt: day(13), events: task("k1", "Explain the break clause in my lease draft", "Either side may end the lease after twelve months with two months' written notice; the deposit is returned within thirty days.") },
  { id: "s_bike", title: "Bisiklet seçimi", updatedAt: day(14), events: task("l1", "Şehir içi için hangi bisikleti almalıyım, bütçem 25 bin lira", "Alüminyum kadrolu, 8 vitesli bir şehir bisikleti: Kron CX100 ya da Bianchi Touring 208. Kron'u seçtik.") },
  { id: "s_talk", title: "Conference talk outline", updatedAt: day(15), events: task("m1", "Outline a twenty minute talk on design systems", "Three parts: why tokens, how we migrated 140 components, what broke. Close with the audit checklist.") },
  { id: "s_visa", title: "Japonya vizesi", updatedAt: day(16), events: task("n1", "Japonya için turist vizesine hangi belgeler gerekiyor?", "Pasaport, biyometrik fotoğraf, banka dökümü, otel rezervasyonu ve uçuş planı. Randevuyu 14 Ekim'e aldık.") },
];

const meeting = (id: string, title: string, d: number, summary: string, lines: string[]): Meeting => ({
  id, title, startedAt: day(d), endedAt: day(d) + 3_600_000, language: null, state: "done", summary,
  lines: lines.map((text, i) => ({ source: i % 2 ? "me" : "others", start: i * 20, end: i * 20 + 15, text })),
});

export const MEETINGS: Meeting[] = [
  meeting("mt_budget", "Bütçe toplantısı", 17, "## Özet\n\n- Pazarlama bütçesi gelecek çeyrekte yüzde on azalıyor; yeni planı Deniz hazırlayacak.\n\n## Kararlar\n\n- İşe alım yıl sonuna kadar donduruldu.\n- Fuar katılımı iptal edildi.", [
    "Pazarlama bütçesini yüzde on kısmamız gerekiyor.", "Fuardan vazgeçersek bu rakamı tutarız.", "Yeni planı Deniz cuma gününe kadar çıkarsın.",
  ]),
  meeting("mt_launch", "Launch sync", 18, "## Summary\n\n- The launch moves from 3 November to 17 November because the payment provider's review is late.\n\n## Actions\n\n- Mira updates the press list.\n- Tomas books the demo room.", [
    "The provider says their review needs two more weeks.", "Then we move the launch to the seventeenth of November.", "Mira, can you update the press list?",
  ]),
  meeting("mt_school", "Veli toplantısı", 19, "## Özet\n\n- Okul gezisi 22 Ekim'de Çanakkale'ye; izin formları 15 Ekim'e kadar teslim edilecek.\n\n## Kararlar\n\n- Servis saati 07.30.", [
    "Gezi Çanakkale'ye, yirmi iki Ekim'de.", "İzin formlarını ayın on beşine kadar getirin.", "Servis yedi buçukta okuldan kalkacak.",
  ]),
];

export interface LibraryCase {
  id: string;
  goal: string;
  /** The item the request is about; null when it is about nothing earlier. */
  about: string | null;
  /** What a right answer holds; for a request about nothing earlier, nothing is checked. */
  expect?: RegExp[];
}

export const LIBRARY_CASES: LibraryCase[] = [
  // About an earlier conversation or meeting, in words it shares with it.
  { id: "hotel-tr", goal: "Lizbon için hangi otelde karar kılmıştık?", about: "s_lisbon", expect: [/Miradouro/i] },
  { id: "tax-en", goal: "What was the tax filing deadline I told you about?", about: "s_tax", expect: [/31\s*March|March\s*31/i] },
  { id: "logo-tr", goal: "Fırın logosu için seçtiğimiz renklerin kodları neydi?", about: "s_logo", expect: [/D9A441/i, /4A2E1F/i] },
  { id: "budget-tr", goal: "Bütçe toplantısında işe alımla ilgili ne karar verildi?", about: "mt_budget", expect: [/dondur/i] },
  { id: "launch-en", goal: "When did the launch sync move the launch to, and why?", about: "mt_launch", expect: [/17/, /provider|review/i] },
  { id: "school-tr", goal: "Veli toplantısında izin formları için hangi tarih söylendi?", about: "mt_school", expect: [/15\s*Ekim/i] },
  { id: "bike-tr", goal: "Geçen konuştuğumuz bisikletlerden hangisini seçmiştik?", about: "s_bike", expect: [/Kron/i] },
  { id: "visa-tr", goal: "Japonya vizesi randevusunu hangi güne almıştık?", about: "s_visa", expect: [/14\s*Ekim/i] },
  // About one, in other words than its own.
  { id: "wifi-tr", goal: "Evdeki konuk kablosuz ağına ne ad vermiştik?", about: "s_router", expect: [/EvMisafir/i] },
  { id: "present-en", goal: "Which present did I like for my mother's birthday when we talked about it?", about: "s_gift", expect: [/şal|shawl/i] },
  { id: "rent-en", goal: "Remind me how much notice the rental contract we looked at asks for", about: "s_lease", expect: [/two months|2 months/i] },
  // About nothing earlier, some of them sharing a word with something that is.
  { id: "weather-tr", goal: "Lizbon'da ekim ayında hava nasıl olur?", about: null },
  { id: "eggs-en", goal: "How many minutes should I boil an egg for a soft yolk?", about: null },
  { id: "capital-en", goal: "What is the capital of Peru?", about: null },
  { id: "translate-tr", goal: "\"Yarın görüşürüz\" cümlesini İngilizceye çevir", about: null },
  { id: "sort-en", goal: "Show me how to sort a list of numbers in Python", about: null },
  { id: "poem-tr", goal: "Sonbahar hakkında dört satırlık bir şiir yaz", about: null },
  { id: "budget-new-tr", goal: "Aylık ev bütçesi için basit bir tablo şablonu hazırla", about: null },
];
