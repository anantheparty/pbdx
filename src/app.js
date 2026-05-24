import { PALETTES } from './palettes.js';
import { EMPTY, readableTextColor, normalizePalette, displayCode } from './color.js';
import { imageBlobToElement, generatePatternFromImage, computeMetrics } from './quantize.js';
import { parsePattern, serializePattern, downloadText, downloadBlob, exportCountsCsv, parseAnyPaletteFile } from './format.js';
import { fitView, renderPatternCanvas, cellAtPoint, makeExportCanvas, patternToSvg, printableHtml } from './render.js';

const $ = (id) => document.getElementById(id);

const state = {
  palettes: [...PALETTES],
  image: null,
  imageName: '',
  imageAspect: 1,
  pattern: null,
  selectedColorIndex: EMPTY,
  selectedCell: null,
  currentTool: 'brush',
  view: { scale: 8, offsetX: 20, offsetY: 20 },
  undo: [],
  redo: [],
  isPainting: false,
  dirtyDuringStroke: false,
  countsSort: 'count-desc',
  replaceTargetIndex: null,
  patternDirty: false,
};

const els = {};
for (const id of [
  'paletteSelect', 'imageInput', 'sampleBtn', 'importPatternBtn', 'patternInput', 'importPaletteBtn', 'paletteInput',
  'widthInput', 'heightInput', 'lockAspect', 'fitMode', 'backgroundMode', 'alphaThreshold', 'whiteCutoff',
  'maxColors', 'coherence', 'smoothPasses', 'minIsland', 'cleanupPasses', 'edgeProtect', 'mergeMaxDelta', 'ditherMode', 'ditherStrength',
  'metric', 'includeSpecial', 'generateBtn', 'progressBar', 'progressText', 'patternCanvas', 'paletteSearch', 'paletteGrid',
  'countsTable', 'metricsCards', 'selectedColorChip', 'selectedCellInfo', 'showGrid', 'showCodes', 'showCoords', 'showErrors',
  'highlightSelected', 'boardMajor', 'boardMinor', 'beadShape', 'zoomInBtn', 'zoomOutBtn', 'fitBtn', 'undoBtn', 'redoBtn', 'eraseBtn', 'brushBtn', 'panBtn', 'pickerBtn',
  'exportPbdxBtn', 'exportPngBtn', 'exportSvgBtn', 'exportCsvBtn', 'exportHtmlBtn', 'exportCellPx', 'previewImage', 'statusLine',
  'autoRegenerate', 'zoomSensitivity', 'pinchSensitivity', 'countsSort', 'applyReplaceBtn',
  'replaceTargetBtn', 'replaceTargetPopover', 'replaceTargetSearch', 'replaceTargetGrid',
  'sidebarToggleBtn', 'suppressRegenPrompt',
]) els[id] = $(id);

function toast(message, tone = 'info') {
  const box = document.createElement('div');
  box.className = `toast ${tone}`;
  box.textContent = message;
  document.body.appendChild(box);
  requestAnimationFrame(() => box.classList.add('show'));
  setTimeout(() => {
    box.classList.remove('show');
    setTimeout(() => box.remove(), 260);
  }, 2600);
}

function setProgress(text, ratio = null) {
  els.progressText.textContent = text;
  if (ratio == null) {
    els.progressBar.removeAttribute('value');
  } else {
    els.progressBar.value = Math.round(ratio * 100);
  }
}

function refreshPaletteSelect() {
  els.paletteSelect.innerHTML = '';
  for (const p of state.palettes) {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = `${p.label} · ${p.colors.length}色`;
    option.title = p.notes ?? '';
    els.paletteSelect.appendChild(option);
  }
  if (!els.paletteSelect.value) els.paletteSelect.value = state.palettes[0].id;
}

function currentPalette() {
  return state.palettes.find((p) => p.id === els.paletteSelect.value) ?? state.palettes[0];
}

function collectParams() {
  return {
    width: Number(els.widthInput.value),
    height: Number(els.heightInput.value),
    fitMode: els.fitMode.value,
    backgroundMode: els.backgroundMode.value,
    alphaThreshold: Number(els.alphaThreshold.value),
    whiteCutoff: Number(els.whiteCutoff.value),
    maxColors: Number(els.maxColors.value),
    coherence: Number(els.coherence.value),
    smoothPasses: Number(els.smoothPasses.value),
    minIsland: Number(els.minIsland.value),
    cleanupPasses: Number(els.cleanupPasses.value),
    edgeProtect: Number(els.edgeProtect.value),
    mergeMaxDelta: Number(els.mergeMaxDelta.value),
    ditherMode: els.ditherMode.value,
    ditherStrength: Number(els.ditherStrength.value),
    metric: els.metric.value,
    includeSpecial: els.includeSpecial.checked,
    includeTransparent: false,
    sourceName: state.imageName,
  };
}

function bindRange(id, suffix = '') {
  const input = els[id];
  const out = $(`${id}Value`);
  const update = () => { if (out) out.textContent = `${input.value}${suffix}`; };
  input.addEventListener('input', update);
  update();
}

function updateMetricCards() {
  const m = state.pattern?.metrics;
  if (!m) {
    els.metricsCards.innerHTML = '<div class="emptyHint">还没有图纸喵。</div>';
    return;
  }
  els.metricsCards.innerHTML = `
    <div class="metric"><b>${m.beadCount}</b><span>总颗数</span></div>
    <div class="metric"><b>${m.colorCount}</b><span>用色数</span></div>
    <div class="metric"><b>${m.complexity}</b><span>复杂度/100</span></div>
    <div class="metric"><b>${m.components}</b><span>色块数</span></div>
    <div class="metric"><b>${m.isolated}</b><span>疑似孤豆</span></div>
    <div class="metric"><b>${m.avgRun.toFixed(1)}</b><span>平均横向连放</span></div>`;
}

function rgbToHueDeg(rgb) {
  const r = rgb[0] / 255; const g = rgb[1] / 255; const b = rgb[2] / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-6) return -1 + (max);
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return h;
}

function sortedCountList() {
  if (!state.pattern) return [];
  const list = state.pattern.metrics.countList.slice();
  const mode = state.countsSort;
  if (mode === 'count-asc') list.sort((a, b) => a.count - b.count);
  else if (mode === 'code') list.sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
  else if (mode === 'hue') list.sort((a, b) => rgbToHueDeg(a.rgb) - rgbToHueDeg(b.rgb));
  else list.sort((a, b) => b.count - a.count);
  return list;
}

function updateCountsTable() {
  if (!state.pattern) {
    els.countsTable.innerHTML = '<div class="emptyHint">生成后这里显示每个色号要买/要倒多少。</div>';
    return;
  }
  const palette = state.pattern.palette;
  const rows = sortedCountList().map((item) => {
    const selected = item.index === state.selectedColorIndex ? ' selected' : '';
    const code = displayCode(palette, palette.colors[item.index]);
    return `<button class="countRow${selected}" data-index="${item.index}" title="点击选为画笔">
      <span class="swatch" style="background:${item.hex}"></span>
      <span class="code">${code}</span>
      <span class="count">${item.count}颗</span>
    </button>`;
  }).join('');
  els.countsTable.innerHTML = rows || '<div class="emptyHint">这个图纸没有实心豆。</div>';
  for (const row of els.countsTable.querySelectorAll('.countRow')) {
    row.addEventListener('click', () => selectColor(Number(row.dataset.index)));
  }
}

function renderReplaceTargetButton() {
  const btn = els.replaceTargetBtn;
  if (!btn) return;
  const palette = state.pattern?.palette ?? currentPalette();
  const idx = state.replaceTargetIndex;
  if (idx === null || idx === undefined) {
    btn.innerHTML = '<span class="chipSwatch empty"></span><b>选目标色</b>';
    return;
  }
  if (idx === EMPTY) {
    btn.innerHTML = '<span class="chipSwatch empty"></span><b>空格 / 留空</b>';
    return;
  }
  const c = palette.colors[idx];
  if (!c) {
    state.replaceTargetIndex = null;
    btn.innerHTML = '<span class="chipSwatch empty"></span><b>选目标色</b>';
    return;
  }
  btn.innerHTML = `<span class="chipSwatch" style="background:${c.hex}"></span><b>${displayCode(palette, c)}</b><em>${c.hex}</em>`;
}

function renderReplaceTargetPopover() {
  if (!els.replaceTargetGrid) return;
  const palette = state.pattern?.palette ?? currentPalette();
  const query = (els.replaceTargetSearch?.value ?? '').trim().toLowerCase();
  const grid = els.replaceTargetGrid;
  grid.innerHTML = '';
  const mkBtn = (className, swatchHtml, label, onClick, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `paletteSwatch ${className}`;
    if (title) b.title = title;
    b.innerHTML = `${swatchHtml}<b>${label}</b>`;
    b.addEventListener('click', onClick);
    return b;
  };
  if (!query || '空格留空empty'.includes(query)) {
    grid.appendChild(mkBtn(
      state.replaceTargetIndex === EMPTY ? 'selected' : '',
      '<span class="chipSwatch empty" style="width:18px;height:18px"></span>',
      '空格',
      () => { setReplaceTarget(EMPTY); closeReplaceTargetPopover(); },
      '空格 / 留空',
    ));
  }
  for (let i = 0; i < palette.colors.length; i++) {
    const c = palette.colors[i];
    const text = `${c.code} ${c.name ?? ''} ${c.hex}`.toLowerCase();
    if (query && !text.includes(query)) continue;
    grid.appendChild(mkBtn(
      state.replaceTargetIndex === i ? 'selected' : '',
      `<span style="background:${c.hex}"></span>`,
      displayCode(palette, c),
      () => { setReplaceTarget(i); closeReplaceTargetPopover(); },
      `${c.code} ${c.name ?? ''} ${c.hex}`,
    ));
  }
}

function setReplaceTarget(index) {
  state.replaceTargetIndex = index;
  renderReplaceTargetButton();
}

function openReplaceTargetPopover() {
  if (!els.replaceTargetPopover) return;
  els.replaceTargetPopover.hidden = false;
  if (els.replaceTargetSearch) els.replaceTargetSearch.value = '';
  renderReplaceTargetPopover();
  els.replaceTargetSearch?.focus();
}

function closeReplaceTargetPopover() {
  if (els.replaceTargetPopover) els.replaceTargetPopover.hidden = true;
}

function toggleReplaceTargetPopover() {
  if (!els.replaceTargetPopover) return;
  if (els.replaceTargetPopover.hidden) openReplaceTargetPopover();
  else closeReplaceTargetPopover();
}

function refreshReplaceTarget() {
  const palette = state.pattern?.palette ?? currentPalette();
  if (state.replaceTargetIndex !== null && state.replaceTargetIndex !== undefined
      && state.replaceTargetIndex !== EMPTY && !palette.colors[state.replaceTargetIndex]) {
    state.replaceTargetIndex = null;
  }
  renderReplaceTargetButton();
  if (els.replaceTargetPopover && !els.replaceTargetPopover.hidden) renderReplaceTargetPopover();
}

function updatePaletteGrid() {
  const palette = state.pattern?.palette ?? currentPalette();
  const query = els.paletteSearch.value.trim().toLowerCase();
  const used = new Set(state.pattern?.metrics?.countList?.map((x) => x.index) ?? []);
  const colors = palette.colors.map((c, index) => ({ ...c, index })).filter((c) => {
    const text = `${c.code} ${c.name ?? ''} ${c.hex}`.toLowerCase();
    return !query || text.includes(query);
  });
  els.paletteGrid.innerHTML = '';
  for (const color of colors) {
    const btn = document.createElement('button');
    btn.className = `paletteSwatch ${state.selectedColorIndex === color.index ? 'selected' : ''} ${used.has(color.index) ? 'used' : ''}`;
    btn.style.setProperty('--swatch', color.hex);
    btn.title = `${color.code} ${color.name ?? ''} ${color.hex}`;
    btn.innerHTML = `<span style="background:${color.hex}"></span><b>${displayCode(palette, color)}</b>`;
    btn.addEventListener('click', () => selectColor(color.index));
    els.paletteGrid.appendChild(btn);
  }
}

function updateSelectedChip() {
  if (state.selectedColorIndex === EMPTY) {
    els.selectedColorChip.innerHTML = '<span class="chipSwatch empty"></span><b>空格/橡皮</b>';
    return;
  }
  const palette = state.pattern?.palette ?? currentPalette();
  const c = palette.colors[state.selectedColorIndex];
  if (!c) {
    els.selectedColorChip.innerHTML = '<span class="chipSwatch empty"></span><b>未选择</b>';
    return;
  }
  els.selectedColorChip.innerHTML = `<span class="chipSwatch" style="background:${c.hex}"></span><b>${displayCode(palette, c)}</b><em>${c.hex}</em>`;
}

function selectColor(index) {
  state.selectedColorIndex = index;
  state.currentTool = index === EMPTY ? 'erase' : 'brush';
  updateToolButtons();
  updateSelectedChip();
  updatePaletteGrid();
  updateCountsTable();
  if (els.highlightSelected?.checked) render();
}

function updateToolButtons() {
  for (const [tool, el] of [['brush', els.brushBtn], ['pan', els.panBtn], ['picker', els.pickerBtn], ['erase', els.eraseBtn]]) {
    el.classList.toggle('active', state.currentTool === tool);
  }
}

function render() {
  renderPatternCanvas(els.patternCanvas, state.pattern, state.view, {
    showGrid: els.showGrid.checked,
    showCodes: els.showCodes.checked,
    showCoords: els.showCoords.checked,
    highlightErrors: els.showErrors.checked,
    highlightSelected: els.highlightSelected.checked,
    selectedColorIndex: state.selectedColorIndex,
    boardMajor: Number(els.boardMajor.value),
    boardMinor: Number(els.boardMinor.value),
    beadShape: els.beadShape.value,
    selectedCell: state.selectedCell,
  });
}

function refreshAll() {
  if (state.pattern) state.pattern.metrics = computeMetrics(state.pattern.cells, state.pattern.width, state.pattern.height, state.pattern.palette);
  updateMetricCards();
  updateCountsTable();
  updatePaletteGrid();
  updateSelectedChip();
  refreshReplaceTarget();
  render();
}

function applyColorReplace() {
  if (!state.pattern) { toast('还没有图纸。', 'warn'); return; }
  const src = state.selectedColorIndex;
  if (state.replaceTargetIndex === null || state.replaceTargetIndex === undefined) {
    toast('先选一个目标色号。', 'warn'); return;
  }
  const tgt = state.replaceTargetIndex;
  if (src === tgt) { toast('源色和目标色一样，没什么可替换的。', 'warn'); return; }
  const palette = state.pattern.palette;
  if (tgt !== EMPTY && !palette.colors[tgt]) { toast('目标色号无效。', 'error'); return; }
  const cells = state.pattern.cells;
  let changed = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i] === src) changed++;
  if (!changed) { toast('图中没有这个色号。', 'warn'); return; }
  pushUndo();
  for (let i = 0; i < cells.length; i++) if (cells[i] === src) cells[i] = tgt;
  const srcLabel = src === EMPTY ? '空格' : (displayCode(palette, palette.colors[src]) || String(src));
  const tgtLabel = tgt === EMPTY ? '空格' : displayCode(palette, palette.colors[tgt]);
  state.selectedColorIndex = tgt;
  refreshAll();
  toast(`已把 ${srcLabel} 替换为 ${tgtLabel}（${changed} 格）。可撤销。`, 'ok');
}

async function setImageFromBlob(blob, name = 'image') {
  state.image = await imageBlobToElement(blob);
  state.imageName = name;
  state.imageAspect = (state.image.naturalWidth || state.image.width) / (state.image.naturalHeight || state.image.height);
  els.previewImage.src = URL.createObjectURL(blob);
  els.previewImage.hidden = false;
  if (els.lockAspect.checked) {
    const w = Number(els.widthInput.value) || 96;
    els.heightInput.value = Math.max(1, Math.round(w / state.imageAspect));
  }
  els.statusLine.textContent = `已载入：${name} · ${state.image.naturalWidth}×${state.image.naturalHeight}`;
  scheduleAutoRegenerate();
}

function updateHeightFromWidth() {
  if (!els.lockAspect.checked || !state.imageAspect) return;
  els.heightInput.value = Math.max(1, Math.round(Number(els.widthInput.value) / state.imageAspect));
}

function updateWidthFromHeight() {
  if (!els.lockAspect.checked || !state.imageAspect) return;
  els.widthInput.value = Math.max(1, Math.round(Number(els.heightInput.value) * state.imageAspect));
}

async function generate(opts = {}) {
  try {
    if (!state.image) {
      toast('先上传图片，或者点”加载示例图”。', 'warn');
      return;
    }
    if (!opts.auto && state.patternDirty && !els.suppressRegenPrompt?.checked) {
      const ok = window.confirm('重新生成会丢弃当前的手动修改 / 导入图纸，确定继续吗？\n\n（可以在左侧”参数修改后自动重新生成”下方勾选”重新生成前不再弹确认”来关闭此提示。）');
      if (!ok) return;
    }
    els.generateBtn.disabled = true;
    setProgress('开始生成', 0.02);
    const palette = currentPalette();
    const pattern = await generatePatternFromImage(state.image, palette, collectParams(), (text, ratio) => setProgress(text, ratio));
    state.pattern = pattern;
    state.undo = [];
    state.redo = [];
    state.selectedCell = null;
    const firstColor = pattern.metrics.countList[0]?.index ?? EMPTY;
    state.selectedColorIndex = firstColor;
    state.view = fitView(pattern, els.patternCanvas);
    setProgress('完成，可以编辑/导出啦', 1);
    state.patternDirty = false;
    refreshAll();
    toast('图纸生成好了。已经做了色域匹配、色块平滑和孤豆清理。', 'ok');
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), 'error');
    setProgress('生成失败', 0);
  } finally {
    els.generateBtn.disabled = false;
  }
}

function pushUndo() {
  if (!state.pattern) return;
  state.undo.push(new Int16Array(state.pattern.cells));
  if (state.undo.length > 40) state.undo.shift();
  state.redo = [];
  state.patternDirty = true;
  updateUndoRedo();
}

function updateUndoRedo() {
  els.undoBtn.disabled = !state.undo.length;
  els.redoBtn.disabled = !state.redo.length;
}

function undo() {
  if (!state.pattern || !state.undo.length) return;
  state.redo.push(new Int16Array(state.pattern.cells));
  state.pattern.cells = state.undo.pop();
  refreshAll();
  updateUndoRedo();
}

function redo() {
  if (!state.pattern || !state.redo.length) return;
  state.undo.push(new Int16Array(state.pattern.cells));
  state.pattern.cells = state.redo.pop();
  refreshAll();
  updateUndoRedo();
}

function paintCell(hit, colorIndex = state.selectedColorIndex) {
  if (!state.pattern || !hit) return false;
  const old = state.pattern.cells[hit.index];
  if (old === colorIndex) return false;
  state.pattern.cells[hit.index] = colorIndex;
  state.selectedCell = { x: hit.x, y: hit.y };
  const pal = state.pattern.palette;
  const c = colorIndex === EMPTY ? '空格' : displayCode(pal, pal.colors[colorIndex]) || colorIndex;
  els.selectedCellInfo.textContent = `(${hit.x + 1}, ${hit.y + 1}) → ${c}`;
  return true;
}

function pickCell(hit) {
  if (!state.pattern || !hit) return;
  selectColor(hit.colorIndex);
  state.selectedCell = { x: hit.x, y: hit.y };
  const pal = state.pattern.palette;
  const c = hit.colorIndex === EMPTY ? '空格' : displayCode(pal, pal.colors[hit.colorIndex]) || hit.colorIndex;
  els.selectedCellInfo.textContent = `拾取 (${hit.x + 1}, ${hit.y + 1})：${c}`;
  render();
}

function setupCanvasEvents() {
  const canvas = els.patternCanvas;
  let pointer = null;
  let spaceDown = false;

  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') { spaceDown = true; canvas.classList.add('panning'); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  });
  window.addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; canvas.classList.remove('panning'); } });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    if (!state.pattern) return;
    canvas.setPointerCapture(e.pointerId);
    const pan = state.currentTool === 'pan' || e.button === 1 || e.button === 2 || spaceDown;
    pointer = {
      pan,
      startX: e.clientX,
      startY: e.clientY,
      ox: state.view.offsetX,
      oy: state.view.offsetY,
      painted: false,
      pushed: false,
    };
    if (!pan) {
      const hit = cellAtPoint(state.pattern, state.view, e.clientX, e.clientY, canvas);
      if (!hit) return;
      if (state.currentTool === 'picker' || e.altKey) {
        pickCell(hit);
      } else {
        if (!pointer.pushed) { pushUndo(); pointer.pushed = true; }
        const color = state.currentTool === 'erase' ? EMPTY : state.selectedColorIndex;
        pointer.painted = paintCell(hit, color) || pointer.painted;
        render();
      }
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!state.pattern || !pointer) return;
    if (pointer.pan) {
      state.view.offsetX = pointer.ox + (e.clientX - pointer.startX);
      state.view.offsetY = pointer.oy + (e.clientY - pointer.startY);
      render();
      return;
    }
    if (state.currentTool === 'picker') return;
    const hit = cellAtPoint(state.pattern, state.view, e.clientX, e.clientY, canvas);
    if (!hit) return;
    const color = state.currentTool === 'erase' ? EMPTY : state.selectedColorIndex;
    pointer.painted = paintCell(hit, color) || pointer.painted;
    render();
  });
  canvas.addEventListener('pointerup', () => {
    if (pointer?.painted && state.pattern) refreshAll();
    pointer = null;
  });
  canvas.addEventListener('wheel', (e) => {
    if (!state.pattern) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const isPinch = e.ctrlKey && Math.abs(e.deltaY) < 25;
    const isZoom = isPinch || e.ctrlKey || e.metaKey;
    if (isZoom) {
      const beforeX = (mx - state.view.offsetX) / state.view.scale;
      const beforeY = (my - state.view.offsetY) / state.view.scale;
      let factor;
      if (isPinch) {
        const sens = Number(els.pinchSensitivity?.value) || 1.80;
        factor = Math.pow(sens, -e.deltaY / 15);
      } else {
        const sens = Number(els.zoomSensitivity?.value) || 1.08;
        factor = Math.pow(sens, -e.deltaY / 100);
      }
      state.view.scale = Math.max(1.5, Math.min(80, state.view.scale * factor));
      state.view.offsetX = mx - beforeX * state.view.scale;
      state.view.offsetY = my - beforeY * state.view.scale;
    } else {
      state.view.offsetX -= e.deltaX;
      state.view.offsetY -= e.deltaY;
    }
    render();
  }, { passive: false });
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let pinchAnchor = null;
  let pinchPanStart = null;
  const activeTouches = new Map();
  const touchMid = () => {
    const pts = [...activeTouches.values()];
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  };
  const touchDist = () => {
    const pts = [...activeTouches.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  };
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length < 2) return;
    e.preventDefault();
    activeTouches.clear();
    for (const t of e.touches) activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
    pinchStartDist = touchDist();
    pinchStartScale = state.view.scale;
    const rect = canvas.getBoundingClientRect();
    const mid = touchMid();
    pinchAnchor = { mx: mid.x - rect.left, my: mid.y - rect.top };
    pinchPanStart = { mid, ox: state.view.offsetX, oy: state.view.offsetY };
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    if (activeTouches.size < 2 || e.touches.length < 2) return;
    e.preventDefault();
    for (const t of e.touches) activeTouches.set(t.identifier, { x: t.clientX, y: t.clientY });
    const rect = canvas.getBoundingClientRect();
    const mid = touchMid();
    const dist = touchDist();
    const sens = Number(els.pinchSensitivity?.value) || 1.80;
    const k = Math.max(0.2, Math.min(1.4, 0.3 + (sens - 1.10) / 1.90 * 0.9));
    const attenuated = Math.pow(dist / pinchStartDist, k);
    const scale = Math.max(1.5, Math.min(80, pinchStartScale * attenuated));
    const beforeX = (pinchAnchor.mx - pinchPanStart.ox) / pinchStartScale;
    const beforeY = (pinchAnchor.my - pinchPanStart.oy) / pinchStartScale;
    const dxPan = mid.x - pinchPanStart.mid.x;
    const dyPan = mid.y - pinchPanStart.mid.y;
    state.view.scale = scale;
    state.view.offsetX = (pinchAnchor.mx - beforeX * scale) + dxPan;
    state.view.offsetY = (pinchAnchor.my - beforeY * scale) + dyPan;
    render();
  }, { passive: false });
  const endTouch = (e) => {
    for (const t of e.changedTouches) activeTouches.delete(t.identifier);
    if (activeTouches.size < 2) { pinchStartDist = 0; pinchAnchor = null; pinchPanStart = null; }
  };
  canvas.addEventListener('touchend', endTouch);
  canvas.addEventListener('touchcancel', endTouch);
}

function applyPreset(kind) {
  const preset = {
    faithful: { maxColors: 88, coherence: 1.2, smoothPasses: 1, minIsland: 1, cleanupPasses: 1, edgeProtect: 9, mergeMaxDelta: 12, ditherMode: 'none', ditherStrength: 0.12 },
    balanced: { maxColors: 52, coherence: 3.2, smoothPasses: 2, minIsland: 2, cleanupPasses: 1, edgeProtect: 7, mergeMaxDelta: 18, ditherMode: 'none', ditherStrength: 0.18 },
    easy: { maxColors: 36, coherence: 5.6, smoothPasses: 4, minIsland: 5, cleanupPasses: 2, edgeProtect: 7, mergeMaxDelta: 26, ditherMode: 'none', ditherStrength: 0.12 },
    lowcolor: { maxColors: 22, coherence: 4.4, smoothPasses: 3, minIsland: 4, cleanupPasses: 2, edgeProtect: 6, mergeMaxDelta: 30, ditherMode: 'none', ditherStrength: 0.12 },
    pixel: { maxColors: 64, coherence: 0.5, smoothPasses: 0, minIsland: 0, cleanupPasses: 0, edgeProtect: 10, mergeMaxDelta: 0, ditherMode: 'bayer', ditherStrength: 0.26 },
  }[kind];
  for (const [k, v] of Object.entries(preset)) {
    if (els[k]) {
      if (els[k].type === 'checkbox') els[k].checked = !!v;
      else els[k].value = v;
      els[k].dispatchEvent(new Event('input'));
      els[k].dispatchEvent(new Event('change'));
    }
  }
}

function filenameBase() {
  const raw = state.imageName || state.pattern?.source?.name || 'bead-pattern';
  return raw.replace(/\.[^.]+$/, '').replace(/[^\w\-\u4e00-\u9fa5]+/g, '-').slice(0, 80) || 'bead-pattern';
}

function exportPbdx() {
  if (!state.pattern) return toast('还没有图纸。', 'warn');
  downloadText(`${filenameBase()}.pbdx`, serializePattern(state.pattern), 'application/json;charset=utf-8');
}

function exportPng() {
  if (!state.pattern) return toast('还没有图纸。', 'warn');
  const canvas = makeExportCanvas(state.pattern, {
    cellPx: Number(els.exportCellPx.value),
    showGrid: els.showGrid.checked,
    showCodes: els.showCodes.checked,
    boardMajor: Number(els.boardMajor.value),
    boardMinor: Number(els.boardMinor.value),
    beadShape: els.beadShape.value,
    legend: true,
  });
  canvas.toBlob((blob) => downloadBlob(`${filenameBase()}-pattern.png`, blob), 'image/png');
}

function exportSvg() {
  if (!state.pattern) return toast('还没有图纸。', 'warn');
  const svg = patternToSvg(state.pattern, {
    cellPx: Number(els.exportCellPx.value),
    showGrid: els.showGrid.checked,
    showCodes: els.showCodes.checked,
    boardMajor: Number(els.boardMajor.value),
    boardMinor: Number(els.boardMinor.value),
    beadShape: els.beadShape.value,
    legend: true,
  });
  downloadText(`${filenameBase()}-pattern.svg`, svg, 'image/svg+xml;charset=utf-8');
}

function exportHtml() {
  if (!state.pattern) return toast('还没有图纸。', 'warn');
  const html = printableHtml(state.pattern, {
    cellPx: Math.min(22, Number(els.exportCellPx.value)),
    showGrid: els.showGrid.checked,
    boardMajor: Number(els.boardMajor.value),
    boardMinor: Number(els.boardMinor.value),
    beadShape: els.beadShape.value,
  });
  downloadText(`${filenameBase()}-overview-print.html`, html, 'text/html;charset=utf-8');
}

function exportCsv() {
  if (!state.pattern) return toast('还没有图纸。', 'warn');
  downloadText(`${filenameBase()}-counts.csv`, exportCountsCsv(state.pattern), 'text/csv;charset=utf-8');
}

async function importPatternFile(file) {
  const text = await file.text();
  const pattern = parsePattern(text);
  const existing = state.palettes.find((p) => p.id === pattern.palette.id);
  if (!existing) state.palettes.push(pattern.palette);
  refreshPaletteSelect();
  els.paletteSelect.value = pattern.palette.id;
  state.pattern = pattern;
  state.selectedColorIndex = pattern.metrics?.countList?.[0]?.index ?? EMPTY;
  state.view = fitView(pattern, els.patternCanvas);
  state.patternDirty = true;
  refreshAll();
  toast('已导入 .pbdx 图纸，可以继续编辑/导出了。', 'ok');
}

async function importPaletteFile(file) {
  const text = await file.text();
  const palette = parseAnyPaletteFile(file.name, text);
  palette.id = palette.id || `custom_${Date.now()}`;
  if (state.palettes.some((p) => p.id === palette.id)) palette.id = `${palette.id}_${Date.now()}`;
  state.palettes.push(palette);
  refreshPaletteSelect();
  els.paletteSelect.value = palette.id;
  updatePaletteGrid();
  toast(`已导入色卡：${palette.label}（${palette.colors.length}色）`, 'ok');
}

let autoRegenTimer = null;
function scheduleAutoRegenerate() {
  if (!els.autoRegenerate?.checked) return;
  if (!state.image) return;
  if (autoRegenTimer) clearTimeout(autoRegenTimer);
  autoRegenTimer = setTimeout(() => {
    autoRegenTimer = null;
    if (els.generateBtn.disabled) return;
    generate({ auto: true });
  }, 450);
}

const AUTO_REGEN_INPUTS = [
  'widthInput', 'heightInput', 'fitMode', 'backgroundMode', 'alphaThreshold', 'whiteCutoff',
  'maxColors', 'coherence', 'smoothPasses', 'minIsland', 'cleanupPasses', 'edgeProtect', 'mergeMaxDelta',
  'ditherMode', 'ditherStrength', 'metric', 'includeSpecial', 'paletteSelect',
];

function setupEvents() {
  els.imageInput.addEventListener('change', async () => {
    const file = els.imageInput.files?.[0];
    if (!file) return;
    try { await setImageFromBlob(file, file.name); }
    catch (err) { toast(err.message || String(err), 'error'); }
  });
  els.sampleBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('samples/sample.jpeg');
      const blob = await res.blob();
      await setImageFromBlob(blob, 'sample.jpeg');
      toast('示例图已载入。', 'ok');
    } catch (err) { toast(`加载示例失败：${err.message}`, 'error'); }
  });
  els.importPatternBtn.addEventListener('click', () => els.patternInput.click());
  els.patternInput.addEventListener('change', () => { const f = els.patternInput.files?.[0]; if (f) importPatternFile(f); els.patternInput.value = ''; });
  els.importPaletteBtn.addEventListener('click', () => els.paletteInput.click());
  els.paletteInput.addEventListener('change', () => { const f = els.paletteInput.files?.[0]; if (f) importPaletteFile(f); els.paletteInput.value = ''; });
  els.widthInput.addEventListener('input', updateHeightFromWidth);
  els.heightInput.addEventListener('input', updateWidthFromHeight);
  els.generateBtn.addEventListener('click', () => generate());
  els.paletteSelect.addEventListener('change', () => { updatePaletteGrid(); });
  els.paletteSearch.addEventListener('input', updatePaletteGrid);
  for (const id of ['showGrid', 'showCodes', 'showCoords', 'showErrors', 'highlightSelected', 'boardMajor', 'boardMinor', 'beadShape']) els[id].addEventListener('input', render);
  els.countsSort.addEventListener('change', () => { state.countsSort = els.countsSort.value; updateCountsTable(); });
  els.applyReplaceBtn.addEventListener('click', applyColorReplace);
  els.replaceTargetBtn?.addEventListener('click', (e) => { e.stopPropagation(); toggleReplaceTargetPopover(); });
  els.replaceTargetSearch?.addEventListener('input', renderReplaceTargetPopover);
  els.replaceTargetPopover?.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', (e) => {
    if (els.replaceTargetPopover && !els.replaceTargetPopover.hidden
        && !e.target.closest('.replaceTargetPicker')) {
      closeReplaceTargetPopover();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.replaceTargetPopover && !els.replaceTargetPopover.hidden) {
      closeReplaceTargetPopover();
    }
  });
  setupSideNav();
  setupSidebarToggle();
  els.zoomInBtn.addEventListener('click', () => { state.view.scale = Math.min(80, state.view.scale * 1.25); render(); });
  els.zoomOutBtn.addEventListener('click', () => { state.view.scale = Math.max(1.5, state.view.scale / 1.25); render(); });
  els.fitBtn.addEventListener('click', () => { if (state.pattern) state.view = fitView(state.pattern, els.patternCanvas); render(); });
  els.undoBtn.addEventListener('click', undo);
  els.redoBtn.addEventListener('click', redo);
  els.brushBtn.addEventListener('click', () => { state.currentTool = 'brush'; if (state.selectedColorIndex === EMPTY) state.selectedColorIndex = state.pattern?.metrics?.countList?.[0]?.index ?? 0; updateToolButtons(); updateSelectedChip(); });
  els.panBtn.addEventListener('click', () => { state.currentTool = 'pan'; updateToolButtons(); });
  els.pickerBtn.addEventListener('click', () => { state.currentTool = 'picker'; updateToolButtons(); });
  els.eraseBtn.addEventListener('click', () => selectColor(EMPTY));
  els.exportPbdxBtn.addEventListener('click', exportPbdx);
  els.exportPngBtn.addEventListener('click', exportPng);
  els.exportSvgBtn.addEventListener('click', exportSvg);
  els.exportCsvBtn.addEventListener('click', exportCsv);
  els.exportHtmlBtn.addEventListener('click', exportHtml);
  for (const btn of document.querySelectorAll('[data-preset]')) btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  for (const id of AUTO_REGEN_INPUTS) {
    const el = els[id];
    if (!el) continue;
    const evt = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, scheduleAutoRegenerate);
  }
  els.autoRegenerate.addEventListener('change', () => {
    if (els.autoRegenerate.checked && state.image && !state.pattern) scheduleAutoRegenerate();
  });
  const ro = new ResizeObserver(() => render());
  ro.observe(els.patternCanvas);
  setupCanvasEvents();
}

function setupCanvasResizer() {
  const handle = document.getElementById('canvasResizer');
  const workspace = document.querySelector('.workspace');
  if (!handle || !workspace) return;
  const STORAGE_KEY = 'bps:canvasHeight';
  const MIN_PX = 240;
  const MAX_PX = 1400;
  const saved = Number(localStorage.getItem(STORAGE_KEY));
  if (saved >= MIN_PX && saved <= MAX_PX) workspace.style.setProperty('--canvas-height', `${saved}px`);
  let startY = 0;
  let startH = 0;
  let dragging = false;
  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizingCanvas');
    startY = e.clientY;
    startH = els.patternCanvas.parentElement.getBoundingClientRect().height;
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const h = Math.max(MIN_PX, Math.min(MAX_PX, startH + (e.clientY - startY)));
    workspace.style.setProperty('--canvas-height', `${h}px`);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('resizingCanvas');
    const h = parseFloat(workspace.style.getPropertyValue('--canvas-height'));
    if (h) localStorage.setItem(STORAGE_KEY, String(Math.round(h)));
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function init() {
  refreshPaletteSelect();
  for (const id of ['alphaThreshold', 'whiteCutoff', 'maxColors', 'coherence', 'smoothPasses', 'minIsland', 'cleanupPasses', 'edgeProtect', 'mergeMaxDelta', 'ditherStrength', 'zoomSensitivity', 'pinchSensitivity']) bindRange(id);
  setupEvents();
  setupCanvasResizer();
  updateToolButtons();
  updateUndoRedo();
  updateMetricCards();
  updateCountsTable();
  updatePaletteGrid();
  updateSelectedChip();
  refreshReplaceTarget();
  render();
}

function setupSidebarToggle() {
  const btn = els.sidebarToggleBtn;
  const shell = document.getElementById('appShell');
  if (!btn || !shell) return;
  const KEY = 'bps:sideHidden';
  const apply = (hidden) => {
    shell.classList.toggle('sideHidden', hidden);
    btn.setAttribute('title', hidden ? '显示左侧工具栏' : '隐藏左侧工具栏');
    btn.setAttribute('aria-label', hidden ? '显示左侧工具栏' : '隐藏左侧工具栏');
    btn.setAttribute('aria-expanded', String(!hidden));
    requestAnimationFrame(() => render());
  };
  apply(localStorage.getItem(KEY) === '1');
  btn.addEventListener('click', () => {
    const next = !shell.classList.contains('sideHidden');
    localStorage.setItem(KEY, next ? '1' : '0');
    apply(next);
  });
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
      e.preventDefault();
      btn.click();
    }
  });
}

function setupSideNav() {
  const nav = document.getElementById('sideNav');
  const sidePanel = document.querySelector('.sidePanel');
  if (!nav || !sidePanel) return;
  const links = [...nav.querySelectorAll('a[data-target]')];
  const sections = links.map((a) => document.getElementById(a.dataset.target)).filter(Boolean);
  for (const a of links) {
    a.addEventListener('click', (e) => {
      const target = document.getElementById(a.dataset.target);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveSection(a.dataset.target);
    });
  }
  function setActiveSection(id) {
    for (const a of links) a.classList.toggle('active', a.dataset.target === id);
  }
  let raf = 0;
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const navH = nav.getBoundingClientRect().height;
      const probe = sidePanel.getBoundingClientRect().top + navH + 8;
      let current = sections[0]?.id;
      for (const s of sections) {
        if (s.getBoundingClientRect().top - 1 <= probe) current = s.id;
      }
      if (current) setActiveSection(current);
    });
  };
  sidePanel.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  onScroll();
}

init();
