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
