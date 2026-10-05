/**
 * What a travel request asks for, read from the user's own words in any of
 * the app's eleven languages. Word stems, not a model: these checks run on
 * every turn and must not depend on the model they keep honest.
 */

// Latin-script words match on a letter boundary; Chinese, Japanese and
// Korean have no spaces, so their words match anywhere.
const latin = (stems: string): string => `(?<!\\p{L})(?:${stems})`;

/** Verbs that ask to look something up. Turkish "arama" (a search, the noun) alone is not a request. */
const ACTION = new RegExp([
  latin("search|find|show|compare|check|look|browse"),
  latin("ara(?!ma)|bul|bak|göster|karşılaştır|listele") + "|arama(?:sı|si)?\\s+yap",
  latin("such|find|zeig|vergleich|prüf|schau"),
  latin("cherch|trouv|montr|compar|vérifi|regard"),
  latin("busc|encuentr|muestr|mostr|compar|revis|mira"),
  latin("cerc|trov|mostr|confront|controll|guard"),
  latin("procur|pesquis|encontr|mostr|compar|verifi|olh"),
  latin("найд|найти|ищи|поищ|покаж|сравн|провер|посмотр|подбер"),
  "搜|找|查|看看|比较|对比",
  "探し|探して|検索|調べ|見せ|比較|比べ",
  "찾아|찾기|검색|보여|비교|알아봐|확인",
].join("|"), "iu");

const HOTEL = new RegExp([
  latin("otel|konaklama|hotel|hôtel|accommodation|unterkunft|hébergement|alojamiento|alloggio|hospedagem|alojamento|отел|гостиниц|жиль"),
  "酒店|宾馆|住宿|ホテル|宿泊|호텔|숙소",
].join("|"), "iu");

const FLIGHT = new RegExp([
  latin("uçuş|ucus|uçak|ucak|flight|airfare|plane ticket|flug|flüge|vols?(?!\\p{L})|billet d'avion|vuelos?(?!\\p{L})|vol[oi](?!\\p{L})|voos?(?!\\p{L})|passagens? aérea|рейс|перел[её]т|авиабилет"),
  "航班|机票|飞机|フライト|航空券|飛行機|항공편|항공권|비행기",
].join("|"), "iu");

/**
 * The user's own words: a chosen card's details, quoted back as JSON, and
 * links say nothing about what to search. An offer link carries "search="
 * and a hotel's name carries "Hotel", which made a choice read as a request.
 */
const ownWords = (goal: string): string => goal.replace(/\{[^{}]*\}/g, " ").replace(/https?:\/\/\S+/g, " ");

/** Only explicit requests to look for travel options require a search call. */
export function requestedTravelTools(goal: string): string[] {
  const words = ownWords(goal);
  if (!ACTION.test(words)) return [];
  const wanted: string[] = [];
  if (HOTEL.test(words)) wanted.push("travel_search_hotels");
  if (FLIGHT.test(words)) wanted.push("travel_search_flights");
  return wanted;
}

const MORE = [
  "farklı|alternatif|esnek|birkaç|birden fazla|kıyasla|karşılaştır",
  "different|alternative|flexible|multiple|compare|several",
  "ander|alternativ|flexibel|mehrere|verschieden|vergleich",
  "différent|autre|alternati|flexible|plusieurs|compar",
  "diferente|otr[oa]s?|alternativ|flexible|vari[oa]s|compar",
  "divers|altr[eio]|alternativ|flessibil|vari|confront",
  "diferente|outr[oa]s?|alternativ|flexíve|vári[oa]s|compar",
  "друг|альтернатив|гибк|несколько|разн|сравн",
].join("|");
const WHAT = [
  "tarih|gün|rota|şehir|otel|uçuş",
  "date|day|route|city|hotel|flight",
  "datum|daten|tag|route|stadt|hotel|flug|flüge",
  "date|jour|itinéraire|trajet|ville|hôtel|vol",
  "fecha|día|ruta|ciudad|hotel|vuelo",
  "data|date|giorn|percorso|città|hotel|vol[oi]",
  "data|dia|rota|cidade|hotel|voo",
  "дат|день|дни|маршрут|город|отел|гостиниц|рейс|перел",
].join("|");
const MORE_CJK = "不同|其他|备选|灵活|几个|多个|比较|对比|別の|違う|他の|柔軟|いくつか|複数|比較|比べ|다른|대안|유연|여러|비교";
const WHAT_CJK = "日期|路线|城市|酒店|航班|日付|日程|ルート|都市|ホテル|便|フライト|날짜|일정|경로|도시|호텔|항공편";

const WANTS_MORE = new RegExp(
  `(?:${MORE}).{0,32}(?:${WHAT})|(?:${WHAT}).{0,32}(?:${MORE})|(?:${MORE_CJK}).{0,16}(?:${WHAT_CJK})|(?:${WHAT_CJK}).{0,16}(?:${MORE_CJK})`,
  "iu",
);

/** The user asked to compare dates, routes or places, so one search per kind is not enough. */
export function wantsMoreTravelSearches(goal: string): boolean {
  return WANTS_MORE.test(goal);
}
