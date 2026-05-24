import { EMPTY, normalizePalette, parsePaletteCsv, displayCode } from './color.js';

export function encodeRle(cells) {
  const out = [];
  if (!cells.length) return out;
  let value = cells[0];
  let count = 1;
  for (let i = 1; i < cells.length; i++) {
    const next = cells[i];
    if (next === value && count < 65535) count++;
    else { out.push([value, count]); value = next; count = 1; }
  }
  out.push([value, count]);
  return out;
}

export function decodeRle(rle, total) {
  const cells = new Int16Array(total);
  let ptr = 0;
  for (const pair of rle) {
    const value = Number(pair[0]);
    const count = Number(pair[1]);
    cells.fill(value, ptr, ptr + count);
    ptr += count;
  }
  if (ptr !== total) throw new Error(`RLE长度不匹配：需要 ${total}，得到 ${ptr}`);
  return cells;
}

export function serializePattern(pattern) {
  const doc = {
    type: 'BeadPatternX',
    version: 1,
    createdAt: new Date().toISOString(),
    width: pattern.width,
    height: pattern.height,
    emptyIndex: EMPTY,
    paletteId: pattern.palette.id,
    palette: pattern.palette,
    cellsRle: encodeRle(Array.from(pattern.cells)),
    params: pattern.params ?? {},
    metrics: pattern.metrics ?? {},
    notes: pattern.notes ?? '',
    source: pattern.source ?? {},
  };
  return JSON.stringify(doc, null, 2);
}

export function parsePattern(text) {
  const doc = JSON.parse(text);
  if (doc.type !== 'BeadPatternX') throw new Error('不是 BeadPatternX / .pbdx 文件。');
  if (!doc.width || !doc.height || !doc.palette || !doc.cellsRle) throw new Error('图纸文件缺少必要字段。');
  const palette = normalizePalette(doc.palette, doc.paletteId ?? 'imported_palette');
  return {
    width: Number(doc.width),
    height: Number(doc.height),
    cells: decodeRle(doc.cellsRle, Number(doc.width) * Number(doc.height)),
    palette,
    params: doc.params ?? {},
    metrics: doc.metrics ?? {},
    notes: doc.notes ?? '',
    source: doc.source ?? {},
    errors: null,
  };
}

export function downloadText(filename, text, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type });
  downloadBlob(filename, blob);
}

export function downloadBlob(filename, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}

export function exportCountsCsv(pattern) {
  const counts = new Map();
  for (const index of pattern.cells) if (index !== EMPTY) counts.set(index, (counts.get(index) ?? 0) + 1);
  const rows = [['code', 'name', 'hex', 'count']];
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([index, count]) => {
      const c = pattern.palette.colors[index];
      rows.push([displayCode(pattern.palette, c), c.name ?? c.code, c.hex, count]);
    });
  return rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
}

export function parseAnyPaletteFile(filename, text) {
  if (/\.csv$/i.test(filename)) return parsePaletteCsv(text);
  return normalizePalette(JSON.parse(text), `custom_${Date.now()}`);
}
