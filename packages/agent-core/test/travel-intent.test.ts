import { describe, expect, it } from "vitest";
import { requestedTravelTools, wantsMoreTravelSearches } from "../src/travel-intent.js";

describe("travel requests in every app language", () => {
  const hotels = ["travel_search_hotels"];
  const flights = ["travel_search_flights"];

  it.each([
    ["Yarın İzmir'de otel bak", hotels],
    ["Find a hotel in Izmir tomorrow", hotels],
    ["Such mir ein Hotel in Izmir für morgen", hotels],
    ["Cherche un hôtel à Izmir pour demain", hotels],
    ["Busca un hotel en Esmirna para mañana", hotels],
    ["Cerca un hotel a Smirne per domani", hotels],
    ["Procure um hotel em Esmirna para amanhã", hotels],
    ["Найди отель в Измире на завтра", hotels],
    ["帮我找明天伊兹密尔的酒店", hotels],
    ["明日のイズミルのホテルを探して", hotels],
    ["내일 이즈미르 호텔 찾아줘", hotels],
    ["Manchester'dan İzmir'e uçuş ara", flights],
    ["Show me flights from Manchester to Izmir", flights],
    ["Zeig mir Flüge von Manchester nach Izmir", flights],
    ["Trouve des vols de Manchester à Izmir", flights],
    ["Busca vuelos de Manchester a Esmirna", flights],
    ["Cerca voli da Manchester a Smirne", flights],
    ["Procure voos de Manchester para Esmirna", flights],
    ["Найди рейсы из Манчестера в Измир", flights],
    ["查一下曼彻斯特到伊兹密尔的航班", flights],
    ["マンチェスターからイズミルへのフライトを検索して", flights],
    ["맨체스터에서 이즈미르 가는 항공편 검색해줘", flights],
  ])("%s", (goal, wanted) => {
    expect(requestedTravelTools(goal)).toEqual(wanted);
  });

  it("does not treat a question about search as a request to search", () => {
    expect(requestedTravelTools("Otel araması nasıl çalışıyor?")).toEqual([]);
    expect(requestedTravelTools("What is a hotel?")).toEqual([]);
  });

  it.each([
    "Farklı tarihleri karşılaştır",
    "Compare different dates",
    "Vergleiche verschiedene Daten",
    "Compare plusieurs dates",
    "Compara varias fechas",
    "Confronta date diverse",
    "Compare várias datas",
    "Сравни разные даты",
    "比较不同的日期",
    "別の日付も見て",
    "다른 날짜도 비교해줘",
  ])("allows more searches for %s", (goal) => {
    expect(wantsMoreTravelSearches(goal)).toBe(true);
  });

  it("keeps one search for a plain request", () => {
    expect(wantsMoreTravelSearches("Yarın İzmir'de otel bak")).toBe(false);
    expect(wantsMoreTravelSearches("Find a hotel in Izmir tomorrow")).toBe(false);
    expect(wantsMoreTravelSearches("内日のホテル")).toBe(false);
  });

  it("does not read quoted card data or a link as a search request", () => {
    const item = JSON.stringify({ source: "trivago", title: "Harbour View Hotel", displayedPrice: "£127",
      offerUrl: "https://www.trivago.co.uk/en-GB/lm/harbour-view-hotel?search=100-1;dr-20261103-20261105" });
    expect(requestedTravelTools(`Card details: ${item}. Is it a good fit?`)).toEqual([]);
    expect(requestedTravelTools("Is this one fine? https://www.trivago.co.uk/en-GB/lm/hotel?search=1")).toEqual([]);
    // The user's own words beside a link still count.
    expect(requestedTravelTools("Find a hotel like https://www.trivago.co.uk/en-GB/lm/x")).toEqual(hotels);
  });
});
