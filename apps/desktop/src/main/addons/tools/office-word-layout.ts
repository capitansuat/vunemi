/** Presentation only, for a freshly converted document_make result. Never called on existing-document edits. */
export function newWordTableLayout(inspection: string): string[] {
  const parsed = JSON.parse(inspection) as { blocks?: { index?: number; type?: string; cells?: unknown[][] }[] };
  if (!Array.isArray(parsed.blocks)) throw new Error('WordCraft inspection did not describe document blocks.');
  const args: string[] = [];
  let bytes = 0;
  const cmd = (id: string, params: unknown) => {
    const value = `${id}=${JSON.stringify(params)}`;
    bytes += Buffer.byteLength(value, 'utf8') + 8;
    if (bytes > 64_000) throw new Error('New-document table layout exceeds the safe command budget. Split large tables into smaller documents before exporting.');
    args.push('--cmd', value);
  };
  for (const table of parsed.blocks) {
    if (table.type !== 'table') continue;
    if (!Number.isInteger(table.index) || table.index! < 0 || !Array.isArray(table.cells) || !table.cells.length) throw new Error('WordCraft table position is incomplete.');
    cmd('caret.set', { pos: { path: [table.index, 0, 0, 0], off: 0, story: "body" } });
    cmd('table.selectTable', {});
    cmd('table.cellMargins', { top: 4, bottom: 4, left: 6, right: 6 });
    if (table.cells.length > 2000) throw new Error('New-document table layout supports up to 2000 rows per table.');
    for (let row = 0; row < table.cells.length; row++) {
      cmd('caret.set', { pos: { path: [table.index, row, 0, 0], off: 0, story: 'body' } });
      cmd('table.rowHeight', { height: 24, rule: 'atLeast' });
      if (row > 0) table.cells[row]!.forEach((value, col) => {
        if (typeof value !== 'string' || !/^[-+]?\d+(?:[.,]\d+)?$/.test(value.trim())) return;
        cmd('caret.set', { pos: { path: [table.index, row, col, 0], off: 0, story: 'body' } });
        cmd('para.alignRight', {});
      });
    }
  }
  return args;
}
