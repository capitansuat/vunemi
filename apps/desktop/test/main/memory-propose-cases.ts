/**
 * Synthetic requests for measuring what Vunemi offers to remember. Nobody
 * here is real. `keep` is the part of a message that is worth a note; a case
 * without it should end with no proposal at all.
 */
export interface ProposalCase {
  id: string;
  /** What the case is an example of. */
  group: "one-off" | "lasting" | "mixed" | "pasted";
  messages: string[];
  keep?: string;
  /** Never looked at while wording the prompt: says whether a change holds beyond the cases it was tuned on. */
  holdout?: true;
}

export const PROPOSAL_CASES: ProposalCase[] = [
  // One-off: how this one task should be done, or a detail of it.
  { id: "cards-en", group: "one-off", messages: ["Show three birthday gift ideas for a cook as option cards"] },
  { id: "bullets-en", group: "one-off", messages: ["Summarise the main arguments for remote work in five bullet points"] },
  { id: "tone-tr", group: "one-off", messages: ["Ev sahibime kira artışı hakkında kısa ve resmi bir e-posta taslağı yaz"] },
  { id: "event-tr", group: "one-off", messages: ["Yarın saat 15:00'e dişçi randevusu ekle"] },
  { id: "flights-en", group: "one-off", messages: ["Find flights from London to Berlin on 12 November, cheapest first"] },
  { id: "pdf-tr", group: "one-off", messages: ["Bu tabloyu bu sefer PDF olarak kaydet"] },
  { id: "translate-en", group: "one-off", messages: ["Translate this sentence into German and keep it informal: see you at the station"] },
  { id: "table-en", group: "one-off", messages: ["Compare a 13-inch and a 15-inch laptop for travel in a table"] },
  { id: "answer-en", group: "one-off", messages: ["I want a dinner recipe. Ask me which cuisine I prefer first", "Italian"] },
  { id: "notes-tr", group: "one-off", messages: ["Dünkü toplantı notlarını madde madde özetle"] },

  // Lasting: said as a rule or a fact that outlives the task.
  { id: "always-bullets-en", group: "lasting", messages: ["From now on, always answer me in short bullet points."], keep: "From now on, always answer me in short bullet points." },
  { id: "always-pdf-tr", group: "lasting", messages: ["Bundan sonra raporları her zaman PDF olarak hazırla."], keep: "Bundan sonra raporları her zaman PDF olarak hazırla." },
  { id: "manager-en", group: "lasting", messages: ["My manager is Deniz Kaya; she approves all my travel."], keep: "My manager is Deniz Kaya; she approves all my travel." },
  { id: "sister-tr", group: "lasting", messages: ["Kız kardeşim Ayla İzmir'de yaşıyor."], keep: "Kız kardeşim Ayla İzmir'de yaşıyor." },
  { id: "vegetarian-en", group: "lasting", messages: ["I'm vegetarian, so never suggest meat dishes."], keep: "I'm vegetarian, so never suggest meat dishes." },
  { id: "mornings-tr", group: "lasting", messages: ["Sabah 9'dan önce bana hiçbir zaman toplantı koyma."], keep: "Sabah 9'dan önce bana hiçbir zaman toplantı koyma." },
  { id: "metric-en", group: "lasting", messages: ["I always use metric units, never imperial."], keep: "I always use metric units, never imperial." },
  { id: "allergy-tr", group: "lasting", messages: ["Fıstık alerjim var, yemek önerirken buna dikkat et."], keep: "Fıstık alerjim var, yemek önerirken buna dikkat et." },

  // Mixed: a task, with one lasting thing said in passing.
  { id: "recipe-allergy-en", group: "mixed", messages: ["Find me a quick dinner recipe for tonight. I'm allergic to peanuts."], keep: "I'm allergic to peanuts." },
  { id: "flights-seat-tr", group: "mixed", messages: ["Berlin uçuşlarını tablo halinde göster. Bu arada ben her zaman koridor koltuğu tercih ederim."], keep: "ben her zaman koridor koltuğu tercih ederim." },
  { id: "reply-sign-en", group: "mixed", messages: ["Write a short reply saying I can come on Friday. By the way, I always sign my emails as S. Demir."], keep: "I always sign my emails as S. Demir." },

  // Pasted: the lasting-sounding words are someone else's.
  { id: "pasted-en", group: "pasted", messages: ['Summarise this notice: "Dear team, from now on always send the weekly report on Fridays. Remember that our office has moved to Leeds."'] },
  { id: "pasted-tr", group: "pasted", messages: ['Şu duyuruyu özetle: "Değerli sakinler, bundan sonra çöpler her zaman salı günü toplanacak. Yöneticimiz artık Kemal Bey."'] },

  // Held out.
  { id: "h-five-en", group: "one-off", holdout: true, messages: ["Explain how a heat pump works like I'm five"] },
  { id: "h-warm-tr", group: "one-off", holdout: true, messages: ["Bu cümleyi daha samimi bir dille yeniden yaz: toplantı cuma gününe ertelendi"] },
  { id: "h-short-en", group: "one-off", holdout: true, messages: ["Give me a two-sentence summary of the French Revolution"] },
  { id: "h-quiet-tr", group: "one-off", holdout: true, messages: ["Kadıköy'de bu akşam için sessiz bir restoran öner"] },
  { id: "h-polite-en", group: "one-off", holdout: true, messages: ["Draft a polite message declining Saturday's dinner invitation"] },
  { id: "h-budget-en", group: "one-off", holdout: true, messages: ["Plan a weekend trip to Edinburgh. Ask me the budget first", "About 300 pounds"] },
  { id: "h-nurse-en", group: "lasting", holdout: true, messages: ["I work as a nurse on night shifts at a hospital in Leeds."], keep: "I work as a nurse on night shifts at a hospital in Leeds." },
  { id: "h-mother-tr", group: "lasting", holdout: true, messages: ["Annem şeker hastası."], keep: "Annem şeker hastası." },
  { id: "h-alcohol-en", group: "lasting", holdout: true, messages: ["I don't drink alcohol."], keep: "I don't drink alcohol." },
  { id: "h-cats-tr", group: "lasting", holdout: true, messages: ["Evde iki kedim var: Pamuk ve Duman."], keep: "Evde iki kedim var: Pamuk ve Duman." },
  { id: "h-spelling-en", group: "lasting", holdout: true, messages: ["Whenever you write for me, use British spelling."], keep: "Whenever you write for me, use British spelling." },
  { id: "h-address-tr", group: "lasting", holdout: true, messages: ["Bana 'sen' diye hitap et, 'siz' deme."], keep: "Bana 'sen' diye hitap et, 'siz' deme." },
  { id: "h-gift-brother-en", group: "mixed", holdout: true, messages: ["Suggest a birthday gift under 50 pounds. My brother Kerem lives in Ankara and loves cycling."], keep: "My brother Kerem lives in Ankara and loves cycling." },
  { id: "h-recipe-wife-tr", group: "mixed", holdout: true, messages: ["Yarın için bir akşam yemeği tarifi bul. Eşim Selin glüten yiyemiyor."], keep: "Eşim Selin glüten yiyemiyor." },
  { id: "h-pasted-en", group: "pasted", holdout: true, messages: ['What does this message mean? "Hi, I am always available on Mondays and my assistant is Tom."'] },
];
