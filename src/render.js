import { EMPTY, readableTextColor, displayCode } from './color.js';

function cssSize(canvas) {
  const rect = canvas.getBoundingClientRect();
  return { width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
}

export function fitView(pattern, canvas, margin = 24) {
  const size = cssSize(canvas);
  const scale = Math.max(2, Math.min((size.width - margin * 2) / pattern.width, (size.height - margin * 2) / pattern.height));
  return {
    scale,
    offsetX: (size.width - pattern.width * scale) / 2,
    offsetY: (size.height - pattern.height * scale) / 2,
  };
}

export function cellAtPoint(pattern, view, clientX, clientY, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((clientX - rect.left - view.offsetX) / view.scale);
  const y = Math.floor((clientY - rect.top - view.offsetY) / view.scale);
  if (!pattern || x < 0 || y < 0 || x >= pattern.width || y >= pattern.height) return null;
  return { x, y, index: y * pattern.width + x, colorIndex: pattern.cells[y * pattern.width + x] };
}

function drawCell(ctx, x, y, size, color, shape) {
  const inset = shape === 'round' ? Math.max(1, size * 0.13) : 0;
  if (shape === 'round') {
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, Math.max(0.1, size / 2 - inset), 0, Math.PI * 2);
    ctx.fillStyle = color.hex;
    ctx.fill();
    if (size >= 11) {
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      ctx.arc(x + size * 0.37, y + size * 0.34, Math.max(0.1, size * 0.09), 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  } else {
    ctx.fillStyle = color.hex;
    ctx.fillRect(x, y, size, size);
  }
}

export function renderPatternCanvas(canvas, pattern, view, options = {}) {
  const dpr = window.devicePixelRatio || 1;
  const size = cssSize(canvas);
  canvas.width = Math.round(size.width * dpr);
  canvas.height = Math.round(size.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);

  ctx.fillStyle = options.dark ? '#16171a' : '#fbfaf7';
  ctx.fillRect(0, 0, size.width, size.height);
  if (!pattern) {
    ctx.fillStyle = options.dark ? '#9aa1ad' : '#6f6a61';
    ctx.font = '16px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('上传图片后生成拼豆图纸', size.width / 2, size.height / 2);
    return;
  }

  const scale = view.scale;
  const startX = Math.max(0, Math.floor((-view.offsetX) / scale) - 1);
  const startY = Math.max(0, Math.floor((-view.offsetY) / scale) - 1);
  const endX = Math.min(pattern.width, Math.ceil((size.width - view.offsetX) / scale) + 1);
  const endY = Math.min(pattern.height, Math.ceil((size.height - view.offsetY) / scale) + 1);
  ctx.save();
  ctx.translate(view.offsetX, view.offsetY);

  // Empty-board background.
  ctx.fillStyle = options.dark ? '#22242a' : '#fffdf8';
  ctx.fillRect(0, 0, pattern.width * scale, pattern.height * scale);

  const shape = options.beadShape ?? 'square';
  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const idx = pattern.cells[y * pattern.width + x];
      if (idx === EMPTY) continue;
      const color = pattern.palette.colors[idx];
      if (!color) continue;
      drawCell(ctx, x * scale, y * scale, scale, color, shape);
    }
  }

  if (options.highlightSelected && options.selectedColorIndex !== undefined && options.selectedColorIndex !== EMPTY) {
    ctx.fillStyle = options.dark ? 'rgba(8,10,14,0.62)' : 'rgba(250,247,240,0.72)';
    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const idx = pattern.cells[y * pattern.width + x];
        if (idx === options.selectedColorIndex) continue;
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    }
    ctx.strokeStyle = options.dark ? '#ffd166' : '#d65f7b';
    ctx.lineWidth = Math.max(1, scale * 0.07);
    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const idx = pattern.cells[y * pattern.width + x];
        if (idx !== options.selectedColorIndex) continue;
        ctx.strokeRect(x * scale + 0.5, y * scale + 0.5, scale - 1, scale - 1);
      }
    }
  }
  if (options.highlightErrors && pattern.errors && scale >= 5) {
    ctx.lineWidth = Math.max(1, scale * 0.08);
    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const i = y * pattern.width + x;
        const idx = pattern.cells[i];
        if (idx === EMPTY) continue;
        const err = pattern.errors[i] || 0;
        if (err > (options.errorThreshold ?? 24)) {
          ctx.strokeStyle = 'rgba(255,0,0,0.55)';
          ctx.strokeRect(x * scale + 1, y * scale + 1, Math.max(1, scale - 2), Math.max(1, scale - 2));
        }
      }
    }
  }

  const showGrid = options.showGrid !== false;
  if (showGrid && scale >= 4) {
    ctx.beginPath();
    ctx.strokeStyle = options.gridColor ?? (options.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.12)');
    ctx.lineWidth = Number(options.gridWidth) > 0 ? Number(options.gridWidth) : 1 / Math.max(1, window.devicePixelRatio || 1);
    for (let x = startX; x <= endX; x++) { ctx.moveTo(x * scale, startY * scale); ctx.lineTo(x * scale, endY * scale); }
    for (let y = startY; y <= endY; y++) { ctx.moveTo(startX * scale, y * scale); ctx.lineTo(endX * scale, y * scale); }
    ctx.stroke();
  }

  const boardMinor = Number(options.boardMinor ?? 0);
  if (boardMinor > 0 && scale >= 2) {
    ctx.beginPath();
    ctx.strokeStyle = options.boardMinorColor ?? (options.dark ? 'rgba(255,255,255,0.30)' : 'rgba(92,63,35,0.28)');
    ctx.lineWidth = Number(options.boardMinorWidth) > 0 ? Number(options.boardMinorWidth) : Math.max(1, Math.min(2, scale * 0.045));
    for (let x = 0; x <= pattern.width; x += boardMinor) { ctx.moveTo(x * scale, 0); ctx.lineTo(x * scale, pattern.height * scale); }
    for (let y = 0; y <= pattern.height; y += boardMinor) { ctx.moveTo(0, y * scale); ctx.lineTo(pattern.width * scale, y * scale); }
    ctx.stroke();
  }
  const boardMajor = Number(options.boardMajor ?? 0);
  if (boardMajor > 0 && scale >= 2) {
    ctx.beginPath();
    ctx.strokeStyle = options.boardMajorColor ?? (options.dark ? 'rgba(255,255,255,0.62)' : 'rgba(60,40,20,0.62)');
    ctx.lineWidth = Number(options.boardMajorWidth) > 0 ? Number(options.boardMajorWidth) : Math.max(2, Math.min(5, scale * 0.1));
    for (let x = 0; x <= pattern.width; x += boardMajor) { ctx.moveTo(x * scale, 0); ctx.lineTo(x * scale, pattern.height * scale); }
    for (let y = 0; y <= pattern.height; y += boardMajor) { ctx.moveTo(0, y * scale); ctx.lineTo(pattern.width * scale, y * scale); }
    ctx.stroke();
  }

  if (options.showCodes && scale >= 14) {
    ctx.font = `${Math.max(8, Math.floor(scale * 0.33))}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const idx = pattern.cells[y * pattern.width + x];
        if (idx === EMPTY) continue;
        const color = pattern.palette.colors[idx];
        if (!color) continue;
        ctx.fillStyle = readableTextColor(color.rgb);
        ctx.fillText(displayCode(pattern.palette, color), x * scale + scale / 2, y * scale + scale / 2, scale * 0.92);
      }
    }
  }

  if (options.selectedCell) {
    const { x, y } = options.selectedCell;
    ctx.strokeStyle = '#ff5c8a';
    ctx.lineWidth = Math.max(2, scale * 0.12);
    ctx.strokeRect(x * scale + 1, y * scale + 1, scale - 2, scale - 2);
  }
  ctx.restore();

  if (options.showCoords && scale >= 8) {
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillStyle = options.dark ? '#ced5df' : '#5b5247';
    ctx.textAlign = 'center';
    for (let x = Math.ceil(startX / 10) * 10; x < endX; x += 10) {
      const px = view.offsetX + (x + 0.5) * scale;
      if (px > 0 && px < size.width) ctx.fillText(String(x + 1), px, Math.max(12, view.offsetY - 5));
    }
    ctx.textAlign = 'right';
    for (let y = Math.ceil(startY / 10) * 10; y < endY; y += 10) {
      const py = view.offsetY + (y + 0.5) * scale + 4;
      if (py > 0 && py < size.height) ctx.fillText(String(y + 1), Math.max(18, view.offsetX - 5), py);
    }
  }
}

function drawPatternAt(ctx, pattern, opts) {
  const cellPx = opts.cellPx;
  const ox = opts.ox ?? 0;
  const oy = opts.oy ?? 0;
  const shape = opts.beadShape ?? 'square';
  ctx.fillStyle = '#fffdf8';
  ctx.fillRect(ox, oy, pattern.width * cellPx, pattern.height * cellPx);
  for (let y = 0; y < pattern.height; y++) {
    for (let x = 0; x < pattern.width; x++) {
      const idx = pattern.cells[y * pattern.width + x];
      if (idx === EMPTY) continue;
      const color = pattern.palette.colors[idx];
      if (!color) continue;
      drawCell(ctx, ox + x * cellPx, oy + y * cellPx, cellPx, color, shape);
    }
  }
  if (opts.showGrid !== false && cellPx >= 3) {
    ctx.beginPath();
    ctx.strokeStyle = opts.gridColor ?? 'rgba(0,0,0,0.18)';
    ctx.lineWidth = Number(opts.gridWidth) > 0 ? Number(opts.gridWidth) : 1;
    for (let x = 0; x <= pattern.width; x++) { ctx.moveTo(ox + x * cellPx + 0.5, oy); ctx.lineTo(ox + x * cellPx + 0.5, oy + pattern.height * cellPx); }
    for (let y = 0; y <= pattern.height; y++) { ctx.moveTo(ox, oy + y * cellPx + 0.5); ctx.lineTo(ox + pattern.width * cellPx, oy + y * cellPx + 0.5); }
    ctx.stroke();
  }
  const boardMinor = Number(opts.boardMinor ?? 0);
  if (boardMinor > 0) {
    ctx.beginPath();
    ctx.strokeStyle = opts.boardMinorColor ?? 'rgba(92,63,35,0.32)';
    ctx.lineWidth = Number(opts.boardMinorWidth) > 0 ? Number(opts.boardMinorWidth) : Math.max(1, Math.min(2, cellPx * 0.06));
    for (let x = 0; x <= pattern.width; x += boardMinor) { ctx.moveTo(ox + x * cellPx, oy); ctx.lineTo(ox + x * cellPx, oy + pattern.height * cellPx); }
    for (let y = 0; y <= pattern.height; y += boardMinor) { ctx.moveTo(ox, oy + y * cellPx); ctx.lineTo(ox + pattern.width * cellPx, oy + y * cellPx); }
    ctx.stroke();
  }
  const boardMajor = Number(opts.boardMajor ?? 0);
  if (boardMajor > 0) {
    ctx.beginPath();
    ctx.strokeStyle = opts.boardMajorColor ?? 'rgba(60,40,20,0.7)';
    ctx.lineWidth = Number(opts.boardMajorWidth) > 0 ? Number(opts.boardMajorWidth) : Math.max(2, Math.min(5, cellPx * 0.12));
    for (let x = 0; x <= pattern.width; x += boardMajor) { ctx.moveTo(ox + x * cellPx, oy); ctx.lineTo(ox + x * cellPx, oy + pattern.height * cellPx); }
    for (let y = 0; y <= pattern.height; y += boardMajor) { ctx.moveTo(ox, oy + y * cellPx); ctx.lineTo(ox + pattern.width * cellPx, oy + y * cellPx); }
    ctx.stroke();
  }
  if (opts.showCodes && cellPx >= 12) {
    ctx.font = `${Math.max(7, Math.floor(cellPx * 0.33))}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let y = 0; y < pattern.height; y++) {
      for (let x = 0; x < pattern.width; x++) {
        const idx = pattern.cells[y * pattern.width + x];
        if (idx === EMPTY) continue;
        const color = pattern.palette.colors[idx];
        if (!color) continue;
        ctx.fillStyle = readableTextColor(color.rgb);
        ctx.fillText(displayCode(pattern.palette, color), ox + x * cellPx + cellPx / 2, oy + y * cellPx + cellPx / 2, cellPx * 0.92);
      }
    }
  }
}

export function makeExportCanvas(pattern, opts = {}) {
  const cellPx = Number(opts.cellPx ?? 20);
  const margin = 36;
  const legend = opts.legend !== false;
  const legendWidth = legend ? 360 : 0;
  const w = margin * 2 + pattern.width * cellPx + legendWidth;
  const h = Math.max(margin * 2 + pattern.height * cellPx, legend ? margin * 2 + Math.min(1200, 78 + pattern.metrics.countList.length * 23) : 0);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fbfaf7';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#2b251f';
  ctx.font = '18px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.fillText(`${pattern.palette.label ?? pattern.palette.id} · ${pattern.width}×${pattern.height}`, margin, 24);
  drawPatternAt(ctx, pattern, { ...opts, cellPx, ox: margin, oy: margin });
  if (legend) {
    const lx = margin + pattern.width * cellPx + 28;
    let y = margin;
    ctx.fillStyle = '#2b251f';
    ctx.font = 'bold 16px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillText('用豆统计', lx, y);
    y += 28;
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    for (const item of pattern.metrics.countList) {
      if (y > h - 20) break;
      ctx.fillStyle = item.hex;
      ctx.fillRect(lx, y - 14, 18, 18);
      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      ctx.strokeRect(lx, y - 14, 18, 18);
      ctx.fillStyle = '#2b251f';
      const itemCode = displayCode(pattern.palette, pattern.palette.colors[item.index]);
      ctx.fillText(`${itemCode.padEnd(6, ' ')} ${String(item.count).padStart(5, ' ')}颗`, lx + 26, y);
      y += 22;
    }
  }
  return canvas;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
}

export function patternToSvg(pattern, opts = {}) {
  const cell = Number(opts.cellPx ?? 18);
  const margin = 32;
  const legend = opts.legend !== false;
  const legendWidth = legend ? 340 : 0;
  const width = margin * 2 + pattern.width * cell + legendWidth;
  const height = Math.max(margin * 2 + pattern.height * cell, legend ? margin * 2 + 70 + pattern.metrics.countList.length * 22 : 0);
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push(`<rect width="100%" height="100%" fill="#fbfaf7"/>`);
  parts.push(`<text x="${margin}" y="22" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="16" fill="#2b251f">${esc(pattern.palette.label ?? pattern.palette.id)} · ${pattern.width}×${pattern.height}</text>`);
  parts.push(`<rect x="${margin}" y="${margin}" width="${pattern.width * cell}" height="${pattern.height * cell}" fill="#fffdf8"/>`);
  const shape = opts.beadShape ?? 'square';
  for (let y = 0; y < pattern.height; y++) {
    for (let x = 0; x < pattern.width; x++) {
      const idx = pattern.cells[y * pattern.width + x];
      if (idx === EMPTY) continue;
      const color = pattern.palette.colors[idx];
      if (!color) continue;
      const cx = margin + x * cell;
      const cy = margin + y * cell;
      if (shape === 'round') parts.push(`<circle cx="${cx + cell / 2}" cy="${cy + cell / 2}" r="${cell * 0.39}" fill="${color.hex}"/>`);
      else parts.push(`<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" fill="${color.hex}"/>`);
    }
  }
  if (opts.showGrid !== false) {
    const gridStroke = opts.gridColor ?? 'rgba(0,0,0,0.18)';
    const gridW = Number(opts.gridWidth) > 0 ? Number(opts.gridWidth) : 1;
    parts.push(`<g stroke="${gridStroke}" stroke-width="${gridW}">`);
    for (let x = 0; x <= pattern.width; x++) parts.push(`<line x1="${margin + x * cell}" y1="${margin}" x2="${margin + x * cell}" y2="${margin + pattern.height * cell}"/>`);
    for (let y = 0; y <= pattern.height; y++) parts.push(`<line x1="${margin}" y1="${margin + y * cell}" x2="${margin + pattern.width * cell}" y2="${margin + y * cell}"/>`);
    parts.push(`</g>`);
  }
  const boardMinor = Number(opts.boardMinor ?? 0);
  if (boardMinor > 0) {
    const minorStroke = opts.boardMinorColor ?? 'rgba(92,63,35,0.32)';
    const minorW = Number(opts.boardMinorWidth) > 0 ? Number(opts.boardMinorWidth) : Math.max(1, Math.min(2, cell * 0.06));
    parts.push(`<g stroke="${minorStroke}" stroke-width="${minorW}">`);
    for (let x = 0; x <= pattern.width; x += boardMinor) parts.push(`<line x1="${margin + x * cell}" y1="${margin}" x2="${margin + x * cell}" y2="${margin + pattern.height * cell}"/>`);
    for (let y = 0; y <= pattern.height; y += boardMinor) parts.push(`<line x1="${margin}" y1="${margin + y * cell}" x2="${margin + pattern.width * cell}" y2="${margin + y * cell}"/>`);
    parts.push(`</g>`);
  }
  const boardMajor = Number(opts.boardMajor ?? 0);
  if (boardMajor > 0) {
    const majorStroke = opts.boardMajorColor ?? 'rgba(60,40,20,0.7)';
    const majorW = Number(opts.boardMajorWidth) > 0 ? Number(opts.boardMajorWidth) : Math.max(2, Math.min(5, cell * 0.12));
    parts.push(`<g stroke="${majorStroke}" stroke-width="${majorW}">`);
    for (let x = 0; x <= pattern.width; x += boardMajor) parts.push(`<line x1="${margin + x * cell}" y1="${margin}" x2="${margin + x * cell}" y2="${margin + pattern.height * cell}"/>`);
    for (let y = 0; y <= pattern.height; y += boardMajor) parts.push(`<line x1="${margin}" y1="${margin + y * cell}" x2="${margin + pattern.width * cell}" y2="${margin + y * cell}"/>`);
    parts.push(`</g>`);
  }
  if (opts.showCodes && cell >= 11) {
    parts.push(`<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${Math.max(7, cell * 0.32)}" text-anchor="middle" dominant-baseline="central">`);
    for (let y = 0; y < pattern.height; y++) {
      for (let x = 0; x < pattern.width; x++) {
        const idx = pattern.cells[y * pattern.width + x];
        if (idx === EMPTY) continue;
        const color = pattern.palette.colors[idx];
        if (!color) continue;
        parts.push(`<text x="${margin + x * cell + cell / 2}" y="${margin + y * cell + cell / 2}" fill="${readableTextColor(color.rgb)}">${esc(displayCode(pattern.palette, color))}</text>`);
      }
    }
    parts.push(`</g>`);
  }
  if (legend) {
    const lx = margin + pattern.width * cell + 28;
    let y = margin;
    parts.push(`<text x="${lx}" y="${y}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="16" font-weight="700" fill="#2b251f">用豆统计</text>`);
    y += 28;
    parts.push(`<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="12" fill="#2b251f">`);
    for (const item of pattern.metrics.countList) {
      parts.push(`<rect x="${lx}" y="${y - 14}" width="18" height="18" fill="${item.hex}" stroke="rgba(0,0,0,0.25)"/>`);
      parts.push(`<text x="${lx + 26}" y="${y}">${esc(displayCode(pattern.palette, pattern.palette.colors[item.index]))} ${item.count}颗</text>`);
      y += 22;
    }
    parts.push(`</g>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}

export function printableHtml(pattern, opts = {}) {
  const svg = patternToSvg(pattern, { ...opts, cellPx: Number(opts.cellPx ?? 16), showCodes: true, legend: true });
  const counts = pattern.metrics.countList.map((c) => `<tr><td><span class="sw" style="background:${c.hex}"></span>${esc(displayCode(pattern.palette, pattern.palette.colors[c.index]))}</td><td>${esc(c.name)}</td><td>${c.count}</td><td>${c.hex}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${esc(pattern.palette.label ?? '拼豆图纸')}</title><style>
  body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#fbfaf7;color:#2b251f;margin:24px}.sheet{break-inside:avoid}svg{max-width:100%;height:auto;border:1px solid #e4d8c8;background:white}table{border-collapse:collapse;margin-top:20px}td,th{border:1px solid #dccfbf;padding:6px 9px}.sw{display:inline-block;width:16px;height:16px;border:1px solid #999;vertical-align:-3px;margin-right:6px}@media print{body{margin:8mm}button{display:none}}
  </style><button onclick="print()">打印</button><h1>${esc(pattern.palette.label ?? pattern.palette.id)}</h1><p>${pattern.width}×${pattern.height}，${pattern.metrics.beadCount}颗，${pattern.metrics.colorCount}色，施工复杂度 ${pattern.metrics.complexity}/100。</p><div class="sheet">${svg}</div><h2>用豆统计</h2><table><thead><tr><th>色号</th><th>名称</th><th>颗数</th><th>HEX</th></tr></thead><tbody>${counts}</tbody></table></html>`;
}

