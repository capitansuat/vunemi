/**
 * What "approve all in this task" reaches in an app. Approving is per app, since
 * what a click does depends on where it lands. Apps where a click can send or
 * spend are never covered, whatever the user pressed.
 */

import type { ApproveAllCover } from "@vunemi/agent-core";
import type { MacApp } from "./helper.js";
import { notScheduledReason } from "./policy.js";
import { installedBundle, type AppLookup } from "./scheduled-apps.js";

const SENDS_OR_DELETES_LATIN_CYRILLIC = [
  "send", "submit", "post", "publish", "share", "reply", "forward", "delete", "remove", "erase", "trash", "discard", "empty", "pay", "buy", "purchase", "order", "checkout", "transfer", "backspace",
  "gönder", "yayınla", "paylaş", "yanıtla", "ilet", "sil", "kaldır", "çöp", "öde", "satın", "sipariş",
  "envoyer", "publier", "partager", "répondre", "transférer", "supprimer", "effacer", "corbeille", "payer", "acheter", "commander",
  "senden", "absenden", "veröffentlichen", "teilen", "antworten", "weiterleiten", "löschen", "entfernen", "papierkorb", "bezahlen", "kaufen", "bestellen", "überweisen",
  "enviar", "publicar", "compartir", "responder", "reenviar", "eliminar", "borrar", "papelera", "pagar", "comprar", "pedir", "transferir",
  "invia", "pubblica", "condividi", "rispondi", "inoltra", "elimina", "cancella", "cestino", "paga", "acquista", "ordina",
  "compartilhar", "encaminhar", "excluir", "apagar", "lixeira",
  "отправ", "опублик", "подел", "ответ", "перес", "удал", "стере", "корзин", "оплат", "купи", "заказ",
];
const SENDS_OR_DELETES_CJK = [
  "送信", "投稿", "共有", "返信", "転送", "削除", "消去", "ゴミ箱", "支払", "購入", "注文",
  "보내", "전송", "게시", "공유", "답장", "전달", "삭제", "지우", "휴지통", "결제", "구매", "주문",
  "发送", "發送", "发布", "發布", "分享", "回复", "回覆", "转发", "轉發", "删除", "刪除", "废纸篓", "支付", "购买", "購買", "订单", "訂單",
];
const STARTS_A_WORD = new RegExp(`(?<!\\p{L})(?:${SENDS_OR_DELETES_LATIN_CYRILLIC.join("|")})`, "iu");

/** A net, not a promise: a control's label needn't say what it does. */
export function soundsLikeSendOrDelete(word: string): boolean {
  return STARTS_A_WORD.test(word.toLocaleLowerCase("tr")) || STARTS_A_WORD.test(word.toLowerCase()) || SENDS_OR_DELETES_CJK.some((w) => word.includes(w));
}

/** `word` is the label of the control or the key combination this step would use. */
export async function inputCover(app: Pick<MacApp, "name" | "bundleId">, word?: string, look: Pick<AppLookup, "folders" | "withId"> = {}): Promise<ApproveAllCover | undefined> {
  if (word !== undefined && soundsLikeSendOrDelete(word)) return undefined;
  if (notScheduledReason(app)) return undefined;
  // Its category decides too (finance, social networking): an app whose bundle
  // can't be read keeps its card rather than pass for an ordinary one.
  const bundle = await installedBundle(app, look).catch(() => undefined);
  if (!bundle || notScheduledReason({ ...app, ...(bundle.category && { category: bundle.category }) })) return undefined;
  return { key: `app:${app.bundleId}`, app: app.name };
}
