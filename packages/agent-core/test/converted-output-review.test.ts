import { it, expect } from 'vitest';
import { runAgent } from '../src/agent.js';
import { ToolRegistry } from '../src/tools.js';
import { taskProgressTool } from '../src/tasks.js';
import type { AgentEvent } from '../src/events.js';
import type { ChatModel, ChatRequest, ToolCall } from '../src/provider.js';

// The trial's rapor.docx as MarkItDown gave it: a year, a percentage and tables the request never names.
const MARKDOWN = '# 2026 Üçüncü Çeyrek Faaliyet Raporu\n\nGelirler bir önceki çeyreğe göre yüzde 12 arttı.\n\n| Bölge | Temmuz | Ağustos | Eylül | Toplam |\n| --- | --- | --- | --- | --- |\n| Marmara | 770 | 792 | 857 | 2419 |\n';
const usage = { promptTokens: 1, completionTokens: 1, ttftMs: 1, tokensPerSec: 1 };
const isReview = (r: ChatRequest) => r.messages[0]?.role === 'system' && String(r.messages[0].content).includes('source and output verifier');

function setup(files: Map<string, string>) {
  const path = (a: unknown) => String((a as { path?: unknown }).path ?? '').replace(/^~\//, '/Users/u/');
  return new ToolRegistry().register(taskProgressTool())
    .register({ name: 'markdown_convert', description: 'convert', actionClass: 'write-local', convertsFiles: true,
      parameters: { type: 'object', properties: { paths: { type: 'array' } } },
      run: async (a, ctx) => { for (const from of (a as { paths: string[] }).paths) { const to = from.replace(/^~\//, '/Users/u/').replace(/\.docx$/, '.md'); files.set(to, MARKDOWN); ctx.produced?.({ kind: 'file', path: to }); } return 'Created.'; } })
    .register({ name: 'files_write', description: 'write', actionClass: 'write-local', resolveFile: path,
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
      run: async (a, ctx) => { files.set(path(a), String((a as { content?: unknown }).content)); ctx.produced?.({ kind: 'file', path: path(a) }); return 'Saved.'; } })
    .register({ name: 'files_edit', description: 'edit', actionClass: 'write-local', resolveFile: path,
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
      run: async (a, ctx) => { files.set(path(a), String((a as { content?: unknown }).content)); ctx.produced?.({ kind: 'file', path: path(a) }); return 'Edited.'; } })
    .register({ name: 'files_read', description: 'read', actionClass: 'read', resolveFile: path,
      parameters: { type: 'object', properties: { path: { type: 'string' }, checks: { type: 'object' } } },
      run: async (a) => files.get(path(a)) ?? 'missing' });
}

async function run(goal: string, calls: ToolCall[][], verdict = '{"ok":false,"issues":["The output is fabricated: source_data is empty."]}') {
  const events: AgentEvent[] = []; const reviews: ChatRequest[] = []; let turn = 0;
  const model: ChatModel = { id: 'local', chat: async (r) => {
    if (isReview(r)) { reviews.push(r); return { text: verdict, toolCalls: [], usage }; }
    const next = calls[turn++];
    return { text: next ? '' : 'Done.', toolCalls: next ?? [], usage };
  } };
  const result = await runAgent({ model, tools: setup(new Map()), goal, emit: (e) => events.push(e), requestApproval: async () => ({ kind: 'approve' }) });
  const reads = events.filter((e): e is Extract<AgentEvent, { type: 'tool.finished' }> => e.type === 'tool.finished' && calls.flat().some((c) => c.id === e.callId && c.name === 'files_read'));
  return { result, reviews, reads };
}

const convert: ToolCall = { id: 'c', name: 'markdown_convert', argumentsText: '{"paths":["~/Demo/rapor.docx"]}' };
const readBack: ToolCall = { id: 'r', name: 'files_read', argumentsText: '{"path":"~/Demo/rapor.md","checks":{"nonempty":true}}' };

it("verifies a converter's output without a source review, which would call it invented", async () => {
  const { reviews, reads } = await run("Demo klasöründeki dosyaları markdown'a çevir", [[convert], [readBack]]);
  expect(reviews).toHaveLength(0);
  expect(reads[0]).toMatchObject({ ok: true, fileEvidence: { kind: 'verified-read', path: '/Users/u/Demo/rapor.md' } });
});

it('reviews a model-written file read back with checks, as before', async () => {
  const write: ToolCall = { id: 'w', name: 'files_write', argumentsText: JSON.stringify({ path: '~/Demo/rapor.md', content: MARKDOWN }) };
  const { reviews, reads } = await run('Write ~/Demo/rapor.md', [[write], [readBack]]);
  expect(reviews).toHaveLength(1);
  expect(reads[0]).toMatchObject({ ok: false });
});

it('reviews a converted file again once the model has edited it', async () => {
  const edit: ToolCall = { id: 'e', name: 'files_edit', argumentsText: JSON.stringify({ path: '~/Demo/rapor.md', content: `${MARKDOWN}\nÖzet: satışlar yüzde 40 arttı.\n` }) };
  const { reviews, reads } = await run("Demo klasöründeki dosyaları markdown'a çevir ve özet ekle", [[convert], [edit], [readBack]], '{"ok":true,"issues":[]}');
  expect(reviews).toHaveLength(1);
  expect(reads[0]).toMatchObject({ ok: true, fileEvidence: { kind: 'verified-read' } });
});
