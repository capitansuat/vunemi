/**
 * What each add-on gives the model: its tools, the line that says what they
 * are for, and the short guide that travels with them. A pack's tools are
 * registered once and switched with the add-on: installed, they are an area
 * the model can open; removed, they are gone.
 *
 * The short tools are conveniences. Each installed pack also opens full
 * engine access: discover its CLI and command catalogue on demand, then
 * run the required operations in an isolated job.
 */

import type { ToolArea, ToolDef, ToolRegistry } from "@vunemi/agent-core";
import type { AddonId } from "../../shared/ipc.js";
import { ADDONS } from "./catalog.js";
import { short, type AddonToolDeps } from "./tools/common.js";
import { fullAccessTools } from "./tools/full-access.js";
import { DOCUMENTS_GUIDE, documentTools, type DocumentOptions } from "./tools/documents.js";
import { DRAWING_GUIDE, drawingTools } from "./tools/drawing.js";
import { PDF_GUIDE, pdfTools } from "./tools/pdf.js";
import { PHOTO_GUIDE, photoTools } from "./tools/photo.js";
import { SHEETS_GUIDE, sheetTools } from "./tools/sheets.js";
import { SLIDES_GUIDE, slideTools } from "./tools/slides.js";
import { VIDEO_GUIDE, videoTools } from "./tools/video.js";

export interface AddonPack {
  id: AddonId;
  /** The area's name for the model. Not the id where that would read as something else. */
  area: string;
  /** A few words: what the area is for. Goes into every request while installed, so each word is paid for every time. */
  summary: string;
  /** What the add-on is called in the line about add-ons not installed. */
  name: string;
  guide: string;
  /** Words in a request that mean this area, in the app's languages. */
  wanted: RegExp;
  tools(deps: AddonToolDeps, opts: PackOptions): ToolDef[];
}

export type PackOptions = DocumentOptions;

export const PACKS: readonly AddonPack[] = [
  {
    id: "documents", area: "documents", name: "documents",
    summary: "Word/PDF files via Craft; Microsoft Office not required",
    guide: DOCUMENTS_GUIDE,
    wanted: /(?<!\p{L})(?:docx|word belge|word doc|rapor yaz|write a report)/iu,
    tools: documentTools,
  },
  {
    id: "sheets", area: "sheets", name: "spreadsheets",
    summary: "Excel files via Craft; no Office app required",
    guide: SHEETS_GUIDE,
    wanted: /(?<!\p{L})(?:xlsx|spreadsheet|excel (?:tablo|dosya|file|workbook))/iu,
    tools: sheetTools,
  },
  {
    id: "slides", area: "slides", name: "presentations",
    summary: "PowerPoint files via Craft; no Office app required",
    guide: SLIDES_GUIDE,
    wanted: /(?<!\p{L})(?:pptx|sunum|presentation|präsentation|présentation|presentaci[oó]n|presentazion|apresenta[cç][aã]o|презентац|slayt|slides?)(?!\p{L})|演示文稿|幻灯片|プレゼン|スライド|프레젠테이션|슬라이드/iu,
    tools: slideTools,
  },
  {
    id: "pdf", area: "pdf", name: "PDF tools",
    summary: "read, edit and process PDFs",
    guide: PDF_GUIDE,
    wanted: /(?<!\p{L})pdf(?!\p{L})/iu,
    tools: pdfTools,
  },
  {
    id: "drawing", area: "drawing", name: "drawing",
    summary: "draw and edit vector art",
    guide: DRAWING_GUIDE,
    wanted: /(?<!\p{L})(?:afiş|poster|logo|kartvizit|davetiye|illüstrasyon|illustration|svg)(?!\p{L})|海报|ポスター|포스터/iu,
    tools: drawingTools,
  },
  {
    // "photos" is the Photos library's group in the Mac apps connection.
    id: "photo", area: "photo_edit", name: "photo editing",
    summary: "edit images, layers and effects",
    guide: PHOTO_GUIDE,
    wanted: /(?<!\p{L})(?:kırp|crop|resize|boyutlandır|yeniden boyut|webp|heic)(?!\p{L})/iu,
    tools: photoTools,
  },
  {
    id: "video", area: "video_edit", name: "video editing",
    summary: "edit video, audio, effects and timelines",
    guide: VIDEO_GUIDE,
    wanted: /(?<!\p{L})(?:video|mp4|montaj|kurgu)(?!\p{L})|视频|動画|동영상|видео/iu,
    tools: videoTools,
  },
];

const sourceOf = (pack: AddonPack): string => `addon:${pack.id}`;

/** The packs whose tools are written: the catalogue should offer no other add-on. */
export const packIds = (): AddonId[] => PACKS.map((pack) => pack.id);

export interface AddonToolsOptions extends AddonToolDeps, PackOptions {
  tools: ToolRegistry;
  installed: (id: AddonId) => boolean;
}

/**
 * Registers every pack's tools and returns `sync`, to call whenever an add-on
 * is installed or removed.
 */
export function registerAddonTools(opts: AddonToolsOptions): { sync(): void } {
  for (const pack of PACKS) {
    const engine = ADDONS.find(addon => addon.id === pack.id)!.engine;
    for (const tool of [...pack.tools(opts, opts), ...fullAccessTools(pack.id, engine, pack.id, opts)]) {
      opts.tools.register({ ...tool, onDemand: pack.area, wantedFor: tool.wantedFor ?? pack.wanted }, sourceOf(pack));
    }
  }
  const sync = (): void => {
    for (const pack of PACKS) opts.tools.setEnabled(sourceOf(pack), opts.installed(pack.id));
  };
  sync();
  return { sync };
}

/**
 * Where files may be read and written, said with every pack's guide. Without
 * it a model asked for "~/Downloads/x.xlsx" wrote /Users/vunemi/Downloads: it
 * had never been told the folders, or that ~ is how the home folder is written.
 */
export function pathsNote(folders: readonly string[]): string {
  const open = folders.map(short).join(", ");
  return `Paths: files are read from and saved into the folders open to you${open ? `: ${open}` : ""}. Write the home folder as ~ (~/Downloads/report.pdf), never as /Users/ and a name you guessed. A folder in the path that does not exist yet is made for you.`;
}

/** One area per pack. The agent lists only those with a tool that can be called. */
export function addonAreas(folders: readonly string[]): ToolArea[] {
  const note = pathsNote(folders);
  return PACKS.map((pack) => ({ id: pack.area, summary: pack.summary, guide: `${fullGuide(pack)}\n${pack.guide}\n- ${note}` }));
}

/** The complete catalogue is requested only for the engine and feature needed. */
function fullGuide(pack: AddonPack): string {
  const catalogue: Record<AddonId, string> = {
    documents: 'commands --json', sheets: 'commands --json --search <feature>',
    slides: 'commands <feature>', pdf: 'tools', drawing: 'commands',
    photo: 'commands --json --filter <feature>', video: 'commands <feature> --json',
  };
  return `Full engine access:\n- ${pack.id}_engine_help shows the installed CLI. ${pack.id}_engine_run reaches its complete supported command set, formats and options. The short tools below are conveniences, not feature limits. Discover commands with CLI args for ${catalogue[pack.id]}; do not guess command IDs or parameters.\n- Pass argv as args, source files as inputs {path,name}, inline assets/scripts as files {name,text}, and saved files or directories as outputs {name,path}. Names are relative to the temporary job; use them in argv and JSON parameters. Jobs do not persist between calls: export anything needed later, including linked assets. No outputs means only the isolated job changes.\n- Read the input structure first; use engine inspection/calculation and saved-output readback to verify requested changes. Render with the engine when a visual check is needed. Report unsupported operations and engine errors accurately.`;
}

/**
 * What the model is told about add-ons that are not installed, so that a
 * request for a presentation gets "download it in Settings" and not a claim
 * that it cannot be done, or worse, that it was.
 */
export function addonInstructions(installed: (id: AddonId) => boolean): string {
  const missing = PACKS.filter((pack) => !installed(pack.id)).map((pack) => pack.name);
  if (missing.length === 0) return "";
  return `Add-ons not downloaded yet: ${missing.join(", ")}. If a request needs one, tell the user to add it in Settings › Add-ons.`;
}
