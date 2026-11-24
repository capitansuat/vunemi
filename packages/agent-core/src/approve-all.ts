/**
 * What "approve all in this task" can reach. A tool is out unless it is named
 * here or answers for itself (ToolDef.approveAll), so a new tool always asks.
 * Sending, deleting and anything that gives lasting power stay out on purpose.
 */

import type { ApproveAllCover, ToolDef } from "./tools.js";

/** Pressing the button on any card also covers these. */
export const LOCAL_WORK = "local";

const LOCAL_TOOLS = new Set([
  "files_edit", "files_compress", "files_extract",
  "document_make", "document_convert", "document_edit",
  "sheet_make", "slides_make", "slides_edit",
  "pdf_combine", "pdf_extract", "pdf_from_images", "pdf_rotate",
  "image_draw", "photo_edit", "video_make",
  "word_read", "word_export_pdf", "excel_read_range", "excel_write_range", "powerpoint_outline",
  "notes_create", "notes_append", "reminder_create", "reminder_done",
]);

/**
 * Labels and keys that send, publish, delete or pay, in the 11 languages:
 * a control that sounds like one keeps its own card in an app and on a page.
 */
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

/** Undefined when this call needs its own card. An error covers nothing. */
export async function approveAllCover(tool: ToolDef, args: unknown): Promise<ApproveAllCover | undefined> {
  try {
    if (tool.alwaysAskWhen?.(args as Record<string, unknown>) === true) return undefined;
    if (tool.approveAll) return (await tool.approveAll(args as Record<string, unknown>)) ?? undefined;
    return LOCAL_TOOLS.has(tool.name) ? { key: LOCAL_WORK } : undefined;
  } catch {
    return undefined;
  }
}
