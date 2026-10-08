/**
 * Synthetic requests for measuring when the model asks with buttons, shows
 * option cards, or does neither. `want` is what the user should end up
 * looking at; "either" is for requests where buttons and cards both serve.
 */
export interface ChoiceCase {
  id: string;
  want: "buttons" | "cards" | "either" | "none";
  goal: string;
  /** How many options the request names: cards about anything else come in another number. */
  count?: number;
  /** Never looked at while changing the agent: says whether a change holds beyond the cases it was tuned on. */
  holdout?: true;
}

export const CHOICE_CASES: ChoiceCase[] = [
  // The user asks to be asked.
  { id: "cuisine-en", want: "buttons", goal: "I want a dinner recipe. Ask me which cuisine I prefer first" },
  { id: "genre-tr", want: "buttons", goal: "Bana bir kitap öner. Önce hangi türü sevdiğimi sor" },
  { id: "trip-en", want: "buttons", goal: "Plan a weekend trip for me. Ask me whether I prefer a city or nature first" },
  { id: "mood-tr", want: "buttons", goal: "Akşam için bir film öner. Önce nasıl bir ruh halinde olduğumu sor" },
  { id: "build-en", want: "buttons", goal: "Help me pick a programming language to learn. Ask me what I want to build first" },
  { id: "budget-tr", want: "buttons", goal: "Annem için bir hediye önereceksin; önce bütçemi sor" },

  // The user asks for options to choose from or compare.
  { id: "gift-cards-en", want: "cards", count: 3, goal: "Show three birthday gift ideas for a cook as option cards" },
  { id: "laptops-en", want: "cards", count: 2, goal: "Compare a 13-inch and a 15-inch laptop for travel" },
  { id: "coffee-tr", want: "cards", count: 3, goal: "Üç farklı kahve makinesi türü öner ve karşılaştır" },
  { id: "lunch-en", want: "cards", count: 3, goal: "Give me three options for a team lunch with their trade-offs so I can choose" },
  { id: "names-en", want: "either", goal: "Suggest three names for a bakery and let me pick one" },
  { id: "ideas-tr", want: "either", goal: "Hafta sonu için üç gezi fikri ver, birini seçeceğim" },

  // Nothing to choose: an answer, and no card.
  { id: "capital-en", want: "none", goal: "What is the capital of Australia?" },
  { id: "photo-tr", want: "none", goal: "Fotosentezi iki cümleyle açıkla" },
  { id: "haiku-en", want: "none", goal: "Write a haiku about autumn" },
  { id: "sum-tr", want: "none", goal: "15 ile 27'nin toplamı kaç?" },
  { id: "walking-en", want: "none", goal: "List three benefits of walking" },
  { id: "cities-tr", want: "none", goal: "Türkiye'nin en kalabalık üç şehrini say" },
  // The answer is itself a short question.
  { id: "translate-q-en", want: "none", goal: "Translate into German: where is the station?" },
  { id: "riddle-tr", want: "none", goal: "Bana bir bilmece sor" },
  // The answer is likely a list, with a question near it.
  { id: "remote-en", want: "none", goal: "What are the pros and cons of working from home?" },
  { id: "tea-coffee-tr", want: "none", goal: "Kahve mi çay mı daha sağlıklı, kısaca açıkla" },

  // The answer is a list, and the model often puts a question under it: an offer of more, which is not a card.
  { id: "rainy-en", want: "none", goal: "Give me three ideas for a rainy Sunday" },
  { id: "novels-en", want: "none", goal: "Name four classic novels worth reading" },
  { id: "dinner-tr", want: "none", goal: "Akşam yemeği için üç kolay yemek öner" },
  { id: "istanbul-tr", want: "none", goal: "İstanbul'da gezilecek beş yer söyle" },
  { id: "podcast-en", want: "none", goal: "Suggest three podcasts about history" },
  { id: "focus-tr", want: "none", goal: "Daha iyi odaklanmak için üç öneri ver" },
  { id: "games-en", want: "none", goal: "Recommend a few board games for two players" },
  { id: "houseplants-en", want: "none", goal: "What are some good houseplants for beginners?" },
  { id: "books-tr", want: "none", goal: "Yaz tatili için dört kitap öner" },
  { id: "exercise-tr", want: "none", goal: "Evde yapılabilecek üç egzersiz say" },
  { id: "snacks-en", want: "none", goal: "List five healthy snacks" },
  // The same list, and the user will pick from it.
  { id: "cat-en", want: "either", goal: "Suggest three names for my cat and let me pick one" },
  { id: "film-tr", want: "either", goal: "Bana üç film öner, birini seçeyim" },
  { id: "hobby-en", want: "either", goal: "I need a hobby. Give me a few options and ask which I'd like to try" },
  { id: "language-tr", want: "either", goal: "Yeni bir dil öğrenmek istiyorum; birkaç seçenek sun ve hangisini istediğimi sor" },
  { id: "puppy-en", want: "either", goal: "Give me three names for a puppy; I'll choose one" },
  { id: "holiday-tr", want: "either", goal: "Üç tatil yeri öner, hangisini istediğimi sor" },
  { id: "colours-en", want: "either", goal: "Offer a few colour schemes for a living room and ask me which I prefer" },

  // Held out.
  { id: "h-sport-en", want: "buttons", holdout: true, goal: "Recommend a sport for me to take up. First ask whether I prefer team or solo sports" },
  { id: "h-pet-tr", want: "buttons", holdout: true, goal: "Bana uygun bir evcil hayvan öner. Önce evde mi apartmanda mı yaşadığımı sor" },
  { id: "h-tone-en", want: "buttons", holdout: true, goal: "Write a toast for my friend's wedding. Ask me what tone I want before writing" },
  { id: "h-phones-en", want: "cards", count: 3, holdout: true, goal: "Compare three kinds of bicycle for commuting in a city" },
  { id: "h-plants-tr", want: "cards", count: 3, holdout: true, goal: "Az ışıklı bir ev için üç bitki seçeneği sun, karşılaştırıp seçeyim" },
  { id: "h-breakfast-en", want: "either", holdout: true, goal: "Offer me three breakfast ideas and I'll pick one" },
  { id: "h-moon-en", want: "none", holdout: true, goal: "How far is the Moon from the Earth?" },
  { id: "h-steps-tr", want: "none", holdout: true, goal: "Çay demlemenin adımlarını sırala" },
  { id: "h-tips-en", want: "none", holdout: true, goal: "Give me four tips for better sleep" },
  { id: "h-slogan-en", want: "none", holdout: true, goal: "Write a one-line slogan for a bakery, phrased as a question" },
  { id: "h-interview-en", want: "none", holdout: true, goal: "Give me five questions to ask in a job interview" },
  { id: "h-packing-tr", want: "none", holdout: true, goal: "Kış tatili için bavula ne koymalıyım?" },
  { id: "h-slogans-en", want: "none", holdout: true, goal: "Give me three slogans for a coffee shop" },
  { id: "h-groceries-en", want: "none", holdout: true, goal: "List four ways to save money on groceries" },
  { id: "h-stretches-en", want: "none", holdout: true, goal: "What are three good stretches for a stiff back?" },
  { id: "h-kahvalti-tr", want: "none", holdout: true, goal: "Bana üç kahvaltı fikri ver" },
  { id: "h-verim-tr", want: "none", holdout: true, goal: "Verimli çalışmak için dört ipucu yaz" },
  { id: "h-sehir-tr", want: "none", holdout: true, goal: "Hafta sonu gidilebilecek üç şehir öner" },
  { id: "h-taglines-en", want: "either", holdout: true, goal: "Give me three taglines for a bike shop and I'll choose one" },
  { id: "h-hediye-tr", want: "either", holdout: true, goal: "Bana üç doğum günü hediyesi fikri ver, birini seçeceğim" },
  { id: "h-weekend-en", want: "either", holdout: true, goal: "Suggest a few weekend activities and ask which one I want" },
];
