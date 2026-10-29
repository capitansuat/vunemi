/** Opt in with CRAFT_LIVE=1. Runs the short PDF, drawing, photo and video tools on the pinned programs; CRAFT_ADDONS_DIR points at another add-ons folder. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Roots } from '@vunemi/files';
import type { ToolContext, ToolDef } from '@vunemi/agent-core';
import { ADDONS, type AddonId } from '../../src/main/addons/catalog.js';
import { createEngines } from '../../src/main/addons/jobs.js';
import { drawingTools } from '../../src/main/addons/tools/drawing.js';
import { pdfTools } from '../../src/main/addons/tools/pdf.js';
import { photoTools } from '../../src/main/addons/tools/photo.js';
import { videoTools } from '../../src/main/addons/tools/video.js';
const installed = process.env.CRAFT_ADDONS_DIR ?? join(homedir(), 'Library/Application Support/Vunemi/addons');
const program = (id: AddonId) => { const a = ADDONS.find(a => a.id === id)!; return join(installed, id, a.tag, a.folder, a.binary); };
const ffmpeg = '/opt/homebrew/bin/ffmpeg';
const ctx = (): ToolContext => ({ signal: new AbortController().signal, handoff: async () => true, offerUndo: () => {}, attach: () => {} });
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="#f4a340"/><circle cx="160" cy="100" r="60" fill="#2a5d9f"/><text x="20" y="40" font-size="24" fill="#111">Vunemi</text></svg>';
let base: string;
let tools: Map<string, ToolDef>;
const call = async (name: string, a: Record<string, unknown>) => String(await tools.get(name)!.run(a, ctx()));
const made = (name: string) => { const p = join(base, name); expect(existsSync(p), name).toBe(true); expect(statSync(p).size, name).toBeGreaterThan(0); return p; };
describe.skipIf(process.env.CRAFT_LIVE !== '1' || process.platform !== 'darwin')('short add-on tools on the pinned programs', () => {
  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'vunemi-short-tools-')));
    const engines = createEngines({ home: homedir(), jobsDir: join(base, '.jobs'), addons: { binary: id => existsSync(program(id)) ? program(id) : null, engineDir: id => join(installed, id, ADDONS.find(a => a.id === id)!.tag) } });
    const deps = { engines, roots: new Roots([base]), shotDir: join(base, '.shots') };
    tools = new Map([...drawingTools(deps), ...pdfTools(deps), ...photoTools(deps), ...videoTools(deps)].map(t => [t.name, t]));
  });
  it.skipIf(!existsSync(program('drawing')))('Drawing: one SVG saved as PNG, PDF and SVG', async () => {
    for (const ext of ['png', 'pdf', 'svg']) { await call('image_draw', { path: join(base, `drawing.${ext}`), svg }); made(`drawing.${ext}`); }
  });
  it.skipIf(!existsSync(program('pdf')) || !existsSync(program('drawing')))('PDF: from images, combine, extract, rotate, list form fields', async () => {
    if (!existsSync(join(base, 'drawing.png'))) await call('image_draw', { path: join(base, 'drawing.png'), svg });
    await call('pdf_from_images', { paths: [join(base, 'drawing.png'), join(base, 'drawing.png')], out: join(base, 'pictures.pdf') }); made('pictures.pdf');
    await call('pdf_combine', { paths: [join(base, 'pictures.pdf'), join(base, 'pictures.pdf')], out: join(base, 'combined.pdf') }); made('combined.pdf');
    expect(await call('pdf_extract', { path: join(base, 'combined.pdf'), pages: '1,3', out: join(base, 'extracted.pdf') })).toMatch(/2/); made('extracted.pdf');
    await call('pdf_rotate', { path: join(base, 'extracted.pdf'), degrees: 90, pages: '1', out: join(base, 'rotated.pdf') }); made('rotated.pdf');
    expect(await call('pdf_form', { path: join(base, 'rotated.pdf') })).toBeTruthy();
  });
  it.skipIf(!existsSync(program('photo')) || !existsSync(program('drawing')))('Photo: crop, rotate, resize, tone and format change', async () => {
    if (!existsSync(join(base, 'drawing.png'))) await call('image_draw', { path: join(base, 'drawing.png'), svg });
    await call('photo_edit', { path: join(base, 'drawing.png'), out: join(base, 'edited.jpg'), crop: { ratio: '1:1' }, rotate: 90, resize: { width: 120 }, auto: true, brightness: 10, sharpen: true }); made('edited.jpg');
    const size = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', join(base, 'edited.jpg')], { encoding: 'utf8' });
    expect(size).toMatch(/pixelWidth: 120/); expect(size).toMatch(/pixelHeight: 120/);
    await call('photo_edit', { path: join(base, 'drawing.png'), out: join(base, 'converted.webp') }); made('converted.webp');
  });
  it.skipIf(!existsSync(program('video')) || !existsSync(ffmpeg))('Video: info, two clips with a fade, a title and captions', async () => {
    for (const [name, colour] of [['a.mp4', 'orange'], ['b.mp4', 'navy']] as const) execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=320x240:d=2:r=30`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(base, name)]);
    expect(await call('video_info', { path: join(base, 'a.mp4') })).toMatch(/320/);
    await call('video_make', { out: join(base, 'made.mp4'), clips: [{ path: join(base, 'a.mp4') }, { path: join(base, 'b.mp4'), start: 0.5 }], fade: true, titles: [{ text: 'Vunemi', at: 0, seconds: 1 }], captions: [{ text: 'Hello', at: 1, seconds: 1 }] });
    made('made.mp4');
    expect(await call('video_info', { path: join(base, 'made.mp4') })).toMatch(/320/);
  }, 300_000);
});
