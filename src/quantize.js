import { EMPTY, colorDistance, preparePalette, rgbToLab, weightedLabDistance } from './color.js';

const BAYER_4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
].map((v) => (v + 0.5) / 16 - 0.5);

function tick() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function safeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export async function imageBlobToElement(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function drawSourceToImageData(image, params) {
  const width = Math.max(1, Number(params.width) || 64);
  const height = Math.max(1, Number(params.height) || 64);
  const canvas = safeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const background = params.backgroundMode === 'white' ? '#ffffff' : params.backgroundMode === 'black' ? '#000000' : null;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.clearRect(0, 0, width, height);
  }

  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  let sx = 0; let sy = 0; let sw = iw; let sh = ih;
  let dx = 0; let dy = 0; let dw = width; let dh = height;
  const fit = params.fitMode ?? 'contain';
  if (fit === 'contain') {
    const scale = Math.min(width / iw, height / ih);
    dw = Math.max(1, Math.round(iw * scale));
    dh = Math.max(1, Math.round(ih * scale));
    dx = Math.floor((width - dw) / 2);
    dy = Math.floor((height - dh) / 2);
  } else if (fit === 'cover') {
    const scale = Math.max(width / iw, height / ih);
    sw = width / scale;
    sh = height / scale;
    sx = (iw - sw) / 2;
    sy = (ih - sh) / 2;
  }
  ctx.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
  return ctx.getImageData(0, 0, width, height);
}

function isWhiteCandidate(rgb, alpha, params) {
  if (alpha < (params.alphaThreshold ?? 12)) return true;
  const threshold = Number(params.whiteCutoff ?? 0);
  if (threshold > 0) {
    const d = Math.sqrt((255 - rgb[0]) ** 2 + (255 - rgb[1]) ** 2 + (255 - rgb[2]) ** 2);
    if (d < threshold) return true;
  }
  return false;
}

function buildEmptyMask(data, width, height, params) {
  const total = width * height;
  const emptyMask = new Uint8Array(total);
  const candidate = new Uint8Array(total);
  const threshold = Number(params.whiteCutoff ?? 0);
  const alphaThreshold = Number(params.alphaThreshold ?? 12);

  for (let i = 0; i < total; i++) {
    const p = i * 4;
    const alpha = data[p + 3];
    if (alpha < alphaThreshold) {
      emptyMask[i] = 1;
      candidate[i] = 1;
      continue;
    }
    if (threshold > 0) {
      const rgb = [data[p], data[p + 1], data[p + 2]];
      candidate[i] = isWhiteCandidate(rgb, alpha, params) ? 1 : 0;
    }
  }
  if (threshold <= 0) return emptyMask;

  // 施工图常见需求是抠掉白底，但不要吞掉角色内部高光。
  // 因此默认只清理“与画布边缘连通”的近白区域；确实想全局删白时可传 whiteRemovalMode:'global'。
  if (params.whiteRemovalMode === 'global') {
    for (let i = 0; i < total; i++) if (candidate[i]) emptyMask[i] = 1;
    return emptyMask;
  }

  const queue = new Int32Array(total);
  let head = 0; let tail = 0;
  const push = (i) => {
    if (i < 0 || i >= total || !candidate[i] || emptyMask[i]) return;
    emptyMask[i] = 1;
    queue[tail++] = i;
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    const y = Math.floor(i / width);
    if (x > 0) push(i - 1);
    if (x + 1 < width) push(i + 1);
    if (y > 0) push(i - width);
    if (y + 1 < height) push(i + width);
  }
  return emptyMask;
}

function nearestColorsForLab(lab, activeColors, options, topK = 4) {
  const bestIdx = new Array(topK).fill(EMPTY);
  const bestDist = new Array(topK).fill(Infinity);
  for (let i = 0; i < activeColors.length; i++) {
    const color = activeColors[i];
    const d = colorDistance(lab, color.lab, options);
    for (let k = 0; k < topK; k++) {
      if (d < bestDist[k]) {
        for (let j = topK - 1; j > k; j--) { bestDist[j] = bestDist[j - 1]; bestIdx[j] = bestIdx[j - 1]; }
        bestDist[k] = d;
        bestIdx[k] = color.sourceIndex;
        break;
      }
    }
  }
  return { indexes: bestIdx, distances: bestDist };
}

function selectWorkingPalette(labs, emptyMask, activeColors, params, progress) {
  const maxColors = Number(params.maxColors ?? 0);
  if (!maxColors || maxColors >= activeColors.length) return activeColors;
  const counts = new Map();
  const errors = new Map();
  for (let i = 0; i < emptyMask.length; i++) {
    if (emptyMask[i]) continue;
    const lab = [labs[i * 3], labs[i * 3 + 1], labs[i * 3 + 2]];
    const nearest = nearestColorsForLab(lab, activeColors, params, 1);
    const idx = nearest.indexes[0];
    counts.set(idx, (counts.get(idx) ?? 0) + 1);
    errors.set(idx, (errors.get(idx) ?? 0) + nearest.distances[0]);
  }
  const byIndex = new Map(activeColors.map((c) => [c.sourceIndex, c]));
  const selected = [...counts.entries()]
    .map(([idx, count]) => ({ idx, count, avgError: (errors.get(idx) ?? 0) / count }))
    .sort((a, b) => {
      const scoreA = a.count * (1 + Math.min(2, a.avgError / 28));
      const scoreB = b.count * (1 + Math.min(2, b.avgError / 28));
      return scoreB - scoreA;
    })
    .slice(0, Math.max(2, maxColors))
    .map((x) => byIndex.get(x.idx))
    .filter(Boolean);
  progress?.(`已选择 ${selected.length} 个施工色`, 0.22);
  return selected.length ? selected : activeColors.slice(0, maxColors);
}

function assignNearest(labs, emptyMask, width, height, activeColors, params, progress) {
  const total = width * height;
  const cells = new Int16Array(total);
  cells.fill(EMPTY);
  const topChoices = new Int16Array(total * 4);
  topChoices.fill(EMPTY);
  const errors = new Float32Array(total);
  if (params.ditherMode === 'floyd') {
    // Error diffusion in RGB-ish Lab neighborhood. It is intentionally separate from smoothing.
    const errL = new Float32Array(total);
    const errA = new Float32Array(total);
    const errB = new Float32Array(total);
    const strength = Number(params.ditherStrength ?? 0.35);
    for (let y = 0; y < height; y++) {
      const xStart = params.serpentineDither === false || y % 2 === 0 ? 0 : width - 1;
      const xEnd = params.serpentineDither === false || y % 2 === 0 ? width : -1;
      const step = xStart < xEnd ? 1 : -1;
      for (let x = xStart; x !== xEnd; x += step) {
        const i = y * width + x;
        if (emptyMask[i]) continue;
        const lab = [labs[i * 3] + errL[i] * strength, labs[i * 3 + 1] + errA[i] * strength, labs[i * 3 + 2] + errB[i] * strength];
        const nearest = nearestColorsForLab(lab, activeColors, params, 4);
        const chosen = nearest.indexes[0];
        cells[i] = chosen;
        errors[i] = nearest.distances[0];
        for (let k = 0; k < 4; k++) topChoices[i * 4 + k] = nearest.indexes[k];
        const chosenColor = activeColors.find((c) => c.sourceIndex === chosen);
        const dl = lab[0] - chosenColor.lab[0];
        const da = lab[1] - chosenColor.lab[1];
        const db = lab[2] - chosenColor.lab[2];
        const push = (xx, yy, factor) => {
          if (xx < 0 || xx >= width || yy < 0 || yy >= height) return;
          const ni = yy * width + xx;
          if (emptyMask[ni]) return;
          errL[ni] += dl * factor; errA[ni] += da * factor; errB[ni] += db * factor;
        };
        if (step === 1) {
          push(x + 1, y, 7 / 16); push(x - 1, y + 1, 3 / 16); push(x, y + 1, 5 / 16); push(x + 1, y + 1, 1 / 16);
        } else {
          push(x - 1, y, 7 / 16); push(x + 1, y + 1, 3 / 16); push(x, y + 1, 5 / 16); push(x - 1, y + 1, 1 / 16);
        }
      }
    }
    return { cells, topChoices, errors };
  }

  const ditherStrength = params.ditherMode === 'bayer' ? Number(params.ditherStrength ?? 0.18) : 0;
  for (let i = 0; i < total; i++) {
    if (emptyMask[i]) continue;
    const x = i % width;
    const y = Math.floor(i / width);
    const noise = ditherStrength ? BAYER_4[(y & 3) * 4 + (x & 3)] * 18 * ditherStrength : 0;
    const lab = [labs[i * 3] + noise, labs[i * 3 + 1], labs[i * 3 + 2]];
    const nearest = nearestColorsForLab(lab, activeColors, params, 4);
    cells[i] = nearest.indexes[0];
    errors[i] = nearest.distances[0];
    for (let k = 0; k < 4; k++) topChoices[i * 4 + k] = nearest.indexes[k];
    if (i % 5000 === 0) progress?.('正在匹配色号', 0.25 + (i / total) * 0.22);
  }
  return { cells, topChoices, errors };
}

const NEIGHBORS_8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];
const NEIGHBORS_4 = [[0, -1], [-1, 0], [1, 0], [0, 1]];

function getLabAt(labs, i) {
  return [labs[i * 3], labs[i * 3 + 1], labs[i * 3 + 2]];
}

function smoothAssignments(cells, topChoices, labs, width, height, paletteInfo, params, progress) {
  const passes = Math.max(0, Math.min(10, Number(params.smoothPasses ?? 2)));
  const coherence = Number(params.coherence ?? 3);
  if (!passes || coherence <= 0) return cells;
  const total = width * height;
  let current = new Int16Array(cells);
  const activeSourceIndexes = new Set(paletteInfo.colors.map((c) => c.sourceIndex));
  const edgeProtect = Number(params.edgeProtect ?? 6);
  const edgeScale = Math.max(5, 42 - edgeProtect * 3.2);
  const smoothPenalty = coherence * 0.95;
  const candidateBuffer = new Int16Array(20);

  for (let pass = 0; pass < passes; pass++) {
    const prev = current;
    current = new Int16Array(prev);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (prev[i] === EMPTY) continue;
        let nCandidates = 0;
        const pushCandidate = (idx) => {
          if (idx === EMPTY || !activeSourceIndexes.has(idx)) return;
          for (let k = 0; k < nCandidates; k++) if (candidateBuffer[k] === idx) return;
          candidateBuffer[nCandidates++] = idx;
        };
        pushCandidate(prev[i]);
        for (let k = 0; k < 4; k++) pushCandidate(topChoices[i * 4 + k]);
        for (const [dx, dy] of NEIGHBORS_8) {
          const xx = x + dx; const yy = y + dy;
          if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
          pushCandidate(prev[yy * width + xx]);
        }
        const sourceLab = getLabAt(labs, i);
        let best = prev[i];
        let bestCost = Infinity;
        for (let c = 0; c < nCandidates; c++) {
          const cand = candidateBuffer[c];
          const candLab = paletteInfo.labByIndex[cand];
          if (!candLab) continue;
          let cost = colorDistance(sourceLab, candLab, params);
          let neighborPenalty = 0;
          for (const [dx, dy] of NEIGHBORS_8) {
            const xx = x + dx; const yy = y + dy;
            if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
            const ni = yy * width + xx;
            if (prev[ni] === EMPTY) continue;
            const sourceEdge = weightedLabDistance(sourceLab, getLabAt(labs, ni), { lightness: 0.8, chroma: 0.65 });
            const w = Math.exp(-sourceEdge / edgeScale);
            if (cand !== prev[ni]) neighborPenalty += w;
          }
          cost += neighborPenalty * smoothPenalty;
          if (cost < bestCost) { bestCost = cost; best = cand; }
        }
        current[i] = best;
      }
    }
    progress?.(`块面优化 ${pass + 1}/${passes}`, 0.50 + ((pass + 1) / passes) * 0.24);
  }
  return current;
}

function cleanupIslands(cells, labs, width, height, paletteInfo, params, progress) {
  const minIsland = Math.max(0, Math.min(120, Number(params.minIsland ?? 2)));
  const passes = Math.max(0, Math.min(6, Number(params.cleanupPasses ?? 1)));
  if (!minIsland || !passes) return cells;
  const mergeMaxDelta = Math.max(0, Number(params.mergeMaxDelta ?? 0));
  let current = new Int16Array(cells);
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const component = [];
  const borderColors = new Map();

  for (let pass = 0; pass < passes; pass++) {
    visited.fill(0);
    let changed = 0;
    for (let start = 0; start < total; start++) {
      if (visited[start] || current[start] === EMPTY) continue;
      const color = current[start];
      let head = 0; let tail = 0;
      queue[tail++] = start;
      visited[start] = 1;
      component.length = 0;
      borderColors.clear();
      while (head < tail) {
        const i = queue[head++];
        component.push(i);
        const x = i % width;
        const y = Math.floor(i / width);
        for (const [dx, dy] of NEIGHBORS_4) {
          const xx = x + dx; const yy = y + dy;
          if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
          const ni = yy * width + xx;
          const nc = current[ni];
          if (nc === color && !visited[ni]) { visited[ni] = 1; queue[tail++] = ni; }
          else if (nc !== color && nc !== EMPTY) borderColors.set(nc, (borderColors.get(nc) ?? 0) + 1);
        }
      }
      if (component.length <= minIsland && borderColors.size) {
        const selfLab = paletteInfo.labByIndex[color];
        let bestColor = color;
        let bestCost = Infinity;
        let bestPaletteDist = Infinity;
        for (const [candidate, borderCount] of borderColors.entries()) {
          const candLab = paletteInfo.labByIndex[candidate];
          if (!candLab) continue;
          const paletteDist = selfLab ? colorDistance(selfLab, candLab, params) : 0;
          if (mergeMaxDelta > 0 && paletteDist > mergeMaxDelta) continue;
          let colorCost = 0;
          for (const i of component) colorCost += colorDistance(getLabAt(labs, i), candLab, params);
          colorCost /= component.length;
          const boundaryBonus = borderCount * (Number(params.coherence ?? 3) * 0.6);
          const cost = colorCost - boundaryBonus;
          if (cost < bestCost) { bestCost = cost; bestColor = candidate; bestPaletteDist = paletteDist; }
        }
        if (bestColor !== color && bestPaletteDist !== Infinity) {
          for (const i of component) current[i] = bestColor;
          changed += component.length;
        }
      }
    }
    progress?.(`清理孤豆 ${pass + 1}/${passes}（${changed}格）`, 0.75 + ((pass + 1) / passes) * 0.12);
    if (!changed) break;
  }
  return current;
}

function recomputeErrors(cells, labs, paletteInfo, params) {
  const errors = new Float32Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const idx = cells[i];
    if (idx === EMPTY) continue;
    const lab = paletteInfo.labByIndex[idx];
    if (!lab) continue;
    errors[i] = colorDistance(getLabAt(labs, i), lab, params);
  }
  return errors;
}

export function computeMetrics(cells, width, height, palette) {
  const total = width * height;
  const counts = new Map();
  let beadCount = 0;
  let isolated = 0;
  let transitions = 0;
  let runs = 0;
  let runTotal = 0;
  for (let i = 0; i < total; i++) {
    const idx = cells[i];
    if (idx !== EMPTY) { counts.set(idx, (counts.get(idx) ?? 0) + 1); beadCount++; }
  }
  for (let y = 0; y < height; y++) {
    let runColor = EMPTY;
    let runLen = 0;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const color = cells[i];
      if (color !== EMPTY) {
        let same4 = 0;
        for (const [dx, dy] of NEIGHBORS_4) {
          const xx = x + dx; const yy = y + dy;
          if (xx >= 0 && xx < width && yy >= 0 && yy < height && cells[yy * width + xx] === color) same4++;
        }
        if (same4 <= 1) isolated++;
      }
      if (color !== runColor) {
        if (runColor !== EMPTY && runLen) { runs++; runTotal += runLen; }
        runColor = color;
        runLen = color === EMPTY ? 0 : 1;
      } else if (color !== EMPTY) runLen++;
      if (x + 1 < width && color !== EMPTY && cells[i + 1] !== EMPTY && color !== cells[i + 1]) transitions++;
      if (y + 1 < height && color !== EMPTY && cells[i + width] !== EMPTY && color !== cells[i + width]) transitions++;
    }
    if (runColor !== EMPTY && runLen) { runs++; runTotal += runLen; }
  }

  // Connected components
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let components = 0;
  let smallComponents = 0;
  for (let start = 0; start < total; start++) {
    if (visited[start] || cells[start] === EMPTY) continue;
    components++;
    const color = cells[start];
    let head = 0; let tail = 0; let size = 0;
    queue[tail++] = start; visited[start] = 1;
    while (head < tail) {
      const i = queue[head++]; size++;
      const x = i % width;
      const y = Math.floor(i / width);
      for (const [dx, dy] of NEIGHBORS_4) {
        const xx = x + dx; const yy = y + dy;
        if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
        const ni = yy * width + xx;
        if (!visited[ni] && cells[ni] === color) { visited[ni] = 1; queue[tail++] = ni; }
      }
    }
    if (size <= 3) smallComponents++;
  }
  const avgRun = runs ? runTotal / runs : 0;
  const transitionRatio = beadCount ? transitions / Math.max(1, beadCount * 2) : 0;
  const isolatedRatio = beadCount ? isolated / beadCount : 0;
  const componentRatio = beadCount ? components / beadCount : 0;
  const colorCount = counts.size;
  const complexity = Math.round(Math.min(100, Math.max(0,
    transitionRatio * 55 + isolatedRatio * 75 + componentRatio * 90 + colorCount * 0.28 - Math.min(18, avgRun * 1.1)
  )));
  const countList = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([index, count]) => ({
    index,
    code: palette.colors[index]?.code ?? String(index),
    name: palette.colors[index]?.name ?? palette.colors[index]?.code ?? String(index),
    hex: palette.colors[index]?.hex ?? '#000000',
    rgb: palette.colors[index]?.rgb ?? [0, 0, 0],
    count,
  }));
  return { beadCount, colorCount, isolated, components, smallComponents, avgRun, transitions, complexity, countList };
}

export async function generatePatternFromImage(image, palette, rawParams, onProgress) {
  const params = {
    metric: 'de2000',
    lightness: 1,
    chroma: 1,
    maxColors: 48,
    smoothPasses: 2,
    coherence: 3,
    edgeProtect: 6,
    minIsland: 2,
    cleanupPasses: 1,
    ditherMode: 'none',
    ditherStrength: 0.2,
    includeSpecial: true,
    includeTransparent: false,
    backgroundMode: 'transparent',
    fitMode: 'contain',
    alphaThreshold: 12,
    whiteCutoff: 0,
    mergeMaxDelta: 18,
    ...rawParams,
    paletteId: palette.id,
  };
  onProgress?.('缩放原图', 0.05);
  const imageData = drawSourceToImageData(image, params);
  await tick();
  const { width, height, data } = imageData;
  const total = width * height;
  const labs = new Float32Array(total * 3);
  const emptyMask = buildEmptyMask(data, width, height, params);
  for (let i = 0; i < total; i++) {
    const p = i * 4;
    const rgb = [data[p], data[p + 1], data[p + 2]];
    const lab = rgbToLab(rgb);
    labs[i * 3] = lab[0]; labs[i * 3 + 1] = lab[1]; labs[i * 3 + 2] = lab[2];
  }
  onProgress?.('准备色卡', 0.15);
  const paletteInfoFull = preparePalette(palette, params);
  if (!paletteInfoFull.colors.length) throw new Error('当前色卡没有可用颜色。请允许特殊色/透明色，或更换色卡。');
  await tick();
  const activeColors = selectWorkingPalette(labs, emptyMask, paletteInfoFull.colors, params, onProgress);
  const paletteInfo = {
    colors: activeColors,
    labByIndex: [],
    rgbByIndex: [],
  };
  for (const color of activeColors) {
    paletteInfo.labByIndex[color.sourceIndex] = color.lab;
    paletteInfo.rgbByIndex[color.sourceIndex] = color.rgb;
  }
  onProgress?.('量化颜色', 0.25);
  const assigned = assignNearest(labs, emptyMask, width, height, activeColors, params, onProgress);
  await tick();
  let cells = assigned.cells;
  cells = smoothAssignments(cells, assigned.topChoices, labs, width, height, paletteInfo, params, onProgress);
  await tick();
  cells = cleanupIslands(cells, labs, width, height, paletteInfo, params, onProgress);
  const errors = recomputeErrors(cells, labs, paletteInfo, params);
  onProgress?.('统计用豆与复杂度', 0.93);
  const metrics = computeMetrics(cells, width, height, palette);
  const pattern = {
    width,
    height,
    cells,
    palette,
    params,
    metrics,
    errors,
    source: {
      width: image.naturalWidth || image.width,
      height: image.naturalHeight || image.height,
      name: params.sourceName ?? '',
    },
  };
  onProgress?.('完成', 1);
  return pattern;
}
