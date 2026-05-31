// 识别模式：把外部像素画 / 拼豆图纸照片识别成 pattern
// - detectGridSize：在裁剪框内全量扫整数 cell 尺寸 × 几个偏移，按"格边对齐 + 格内同色"打分
// - sampleCellsToPattern：每个格子按环形 mask 取中位 Lab，吸附到色卡

import { rgbToLab, deltaE2000, rgbToHex } from './color.js';

const WORK_LONG_EDGE = 640; // 工作图最长边，越大越准但越慢

// 把源图（或裁剪框）抽到工作 canvas，返回 ImageData + 缩放比
function sampleSourceToWork(image, crop) {
  const srcW = image.naturalWidth || image.width;
  const srcH = image.naturalHeight || image.height;
  const sx = Math.max(0, Math.floor(crop.x));
  const sy = Math.max(0, Math.floor(crop.y));
  const sw = Math.max(1, Math.min(srcW - sx, Math.floor(crop.w)));
  const sh = Math.max(1, Math.min(srcH - sy, Math.floor(crop.h)));
  const long = Math.max(sw, sh);
  const sf = Math.min(1, WORK_LONG_EDGE / long);
  const workW = Math.max(1, Math.round(sw * sf));
  const workH = Math.max(1, Math.round(sh * sf));
  const cv = document.createElement('canvas');
  cv.width = workW;
  cv.height = workH;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, workW, workH);
  const id = ctx.getImageData(0, 0, workW, workH);
  return { id, workW, workH, srcCrop: { x: sx, y: sy, w: sw, h: sh } };
}

// 输入：image + 裁剪 + 搜索范围（cell 像素尺寸下限/上限，**在工作图尺度**自动换算）
// 返回：{ cellW, cellH, cols, rows, score }，cell 是工作图下的浮点像素尺寸
export function detectGridSize(image, crop, options = {}) {
  const { id, workW, workH } = sampleSourceToWork(image, crop);
  const data = id.data;

  // 灰度 + 水平/垂直梯度
  const N = workW * workH;
  const gray = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const off = i * 4;
    gray[i] = 0.299 * data[off] + 0.587 * data[off + 1] + 0.114 * data[off + 2];
  }
  const gx = new Float32Array(N);
  const gy = new Float32Array(N);
  for (let y = 0; y < workH; y++) {
    for (let x = 0; x < workW; x++) {
      const i = y * workW + x;
      const xm = x > 0 ? gray[i - 1] : gray[i];
      const xp = x + 1 < workW ? gray[i + 1] : gray[i];
      const ym = y > 0 ? gray[i - workW] : gray[i];
      const yp = y + 1 < workH ? gray[i + workW] : gray[i];
      gx[i] = Math.abs(xp - xm);
      gy[i] = Math.abs(yp - ym);
    }
  }
  // 投影到列/行
  const colEdge = new Float32Array(workW); // 在 x 列上的"竖边"强度（gx）
  const rowEdge = new Float32Array(workH);
  for (let y = 0; y < workH; y++) {
    for (let x = 0; x < workW; x++) {
      const i = y * workW + x;
      colEdge[x] += gx[i];
      rowEdge[y] += gy[i];
    }
  }

  // 用户给的拼豆"目标列数"范围（在裁剪框内的格数）
  // 默认让 cellPx 在工作图里落在 [4, workMin/4] 之间，足够覆盖常见像素画
  const minCols = Math.max(4, Math.floor(options.minCols ?? 8));
  const maxCols = Math.min(workW - 1, Math.floor(options.maxCols ?? Math.min(160, Math.floor(workW / 3))));

  // 对一维信号 sig，给定 cellPx (浮点) + offset，算"格边对齐度"
  // = 落在格边 ±1px 的能量 - 落在格中央 ±cellPx/4 的能量
  const lineScore = (sig, cellPx, offset) => {
    const L = sig.length;
    let edgeSum = 0;
    let mids = 0;
    let edgeN = 0;
    let midN = 0;
    const halfMid = Math.max(1, Math.floor(cellPx / 4));
    for (let k = 0; ; k++) {
      const pos = offset + k * cellPx;
      if (pos >= L) break;
      const p = Math.round(pos);
      for (let d = -1; d <= 1; d++) {
        const x = p + d;
        if (x >= 0 && x < L) { edgeSum += sig[x]; edgeN++; }
      }
      const midPos = Math.round(offset + (k + 0.5) * cellPx);
      for (let d = -halfMid; d <= halfMid; d++) {
        const x = midPos + d;
        if (x >= 0 && x < L) { mids += sig[x]; midN++; }
      }
    }
    if (!edgeN || !midN) return -Infinity;
    return edgeSum / edgeN - mids / midN;
  };

  // 在某个方向搜索最优 cellPx + offset
  const searchAxis = (sig, length) => {
    let best = { cellPx: 0, offset: 0, score: -Infinity, cells: 0 };
    // cellPx 从 length/maxCols 到 length/minCols 扫
    const lowPx = length / maxCols;
    const highPx = length / minCols;
    // 0.25 步长足够稳；offset 0..floor(cellPx) 整数步
    for (let cpx = lowPx; cpx <= highPx; cpx += 0.25) {
      const offMax = Math.min(Math.floor(cpx) + 1, length);
      for (let off = 0; off < offMax; off++) {
        const s = lineScore(sig, cpx, off);
        if (s > best.score) {
          best = { cellPx: cpx, offset: off, score: s, cells: Math.round((length - off) / cpx) };
        }
      }
    }
    return best;
  };

  const colBest = searchAxis(colEdge, workW);
  const rowBest = searchAxis(rowEdge, workH);

  // 把 offset 收缩到 [0, cellPx)：autodetect 找到的 offset 只是某一条网格线的位置，
  // 不一定是最左边那条。取模后得到第一条完整网格线的位置。
  const normLeft = (off, cpx) => {
    if (!cpx) return 0;
    let v = off % cpx;
    if (v < 0) v += cpx;
    return v;
  };
  const xStart = normLeft(colBest.offset, colBest.cellPx);
  const yStart = normLeft(rowBest.offset, rowBest.cellPx);
  const colsFit = Math.max(1, Math.floor((workW - xStart) / colBest.cellPx));
  const rowsFit = Math.max(1, Math.floor((workH - yStart) / rowBest.cellPx));

  // 换算回源图尺度
  const sxScale = crop.w / workW;
  const syScale = crop.h / workH;

  return {
    cols: colsFit,
    rows: rowsFit,
    cellWSrc: colBest.cellPx * sxScale,
    cellHSrc: rowBest.cellPx * syScale,
    offsetXSrc: xStart * sxScale,
    offsetYSrc: yStart * syScale,
    scoreX: colBest.score,
    scoreY: rowBest.score,
    workW,
    workH,
  };
}

// 从源图 + 裁剪 + cols/rows 网格 + 环形 mask 提取每个格的代表色
// mask: { outer: 0..1, inner: 0..1 }，相对 cell 半径
// 返回：{ cells: Int16Array, rgb: Array<[r,g,b]>（每个格的原始平均色，用于预览） }
export function sampleCellsToPattern(image, crop, grid, palette, mask = {}) {
  const { cols, rows } = grid;
  const offX = grid.offsetX ?? 0;
  const offY = grid.offsetY ?? 0;
  const cellW = (crop.w - offX) / cols;
  const cellH = (crop.h - offY) / rows;
  const outerR = Math.max(0.1, Math.min(1, mask.outer ?? 0.9));
  const innerR = Math.max(0, Math.min(outerR - 0.05, mask.inner ?? 0.35));

  // 工作 canvas：每个 cell 至少 8px 才能稳定取色；按需放大或下采样
  const targetCellPx = Math.max(10, Math.min(28, Math.round(Math.min(cellW, cellH))));
  const workW = Math.max(1, Math.round(targetCellPx * cols));
  const workH = Math.max(1, Math.round(targetCellPx * rows));
  const cv = document.createElement('canvas');
  cv.width = workW;
  cv.height = workH;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  // 把 crop 内的有效区域（去掉 offset）画到工作 canvas
  const sx = crop.x + offX;
  const sy = crop.y + offY;
  const sw = crop.w - offX;
  const sh = crop.h - offY;
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, workW, workH);
  const id = ctx.getImageData(0, 0, workW, workH);
  const data = id.data;

  // 调色板 → Lab cache
  const palLabs = palette.colors.map((c) => {
    const hex = c.hex.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return rgbToLab([r, g, b]);
  });

  const cells = new Int16Array(cols * rows);
  const avgRgb = new Array(cols * rows);
  const cellPxW = workW / cols;
  const cellPxH = workH / rows;

  // 收集环形内像素 → 取每个通道的中位数（抗中央字号干扰）
  const buf = new Float32Array(Math.ceil(cellPxW * cellPxH) * 3);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * cellPxW;
      const y0 = cy * cellPxH;
      const cx0 = x0 + cellPxW / 2;
      const cy0 = y0 + cellPxH / 2;
      const radX = cellPxW / 2;
      const radY = cellPxH / 2;
      const xStart = Math.floor(x0);
      const xEnd = Math.min(workW, Math.ceil(x0 + cellPxW));
      const yStart = Math.floor(y0);
      const yEnd = Math.min(workH, Math.ceil(y0 + cellPxH));
      let n = 0;
      let alphaSum = 0;
      let alphaCount = 0;
      for (let py = yStart; py < yEnd; py++) {
        for (let px = xStart; px < xEnd; px++) {
          const dx = (px + 0.5 - cx0) / radX;
          const dy = (py + 0.5 - cy0) / radY;
          const r2 = dx * dx + dy * dy;
          if (r2 > outerR * outerR) continue;
          if (r2 < innerR * innerR) continue;
          const off = (py * workW + px) * 4;
          const a = data[off + 3];
          alphaSum += a;
          alphaCount++;
          if (a < 16) continue;
          buf[n * 3 + 0] = data[off];
          buf[n * 3 + 1] = data[off + 1];
          buf[n * 3 + 2] = data[off + 2];
          n++;
        }
      }
      const meanAlpha = alphaCount ? alphaSum / alphaCount : 0;
      if (n < 3 || meanAlpha < 24) {
        cells[cy * cols + cx] = -1; // EMPTY
        avgRgb[cy * cols + cx] = [255, 255, 255];
        continue;
      }
      // 中位数（per-channel；近似但稳，足够躲过字号像素）
      const med = [0, 0, 0];
      for (let ch = 0; ch < 3; ch++) {
        const arr = new Float32Array(n);
        for (let i = 0; i < n; i++) arr[i] = buf[i * 3 + ch];
        arr.sort();
        med[ch] = arr[Math.floor(n / 2)];
      }
      avgRgb[cy * cols + cx] = [Math.round(med[0]), Math.round(med[1]), Math.round(med[2])];

      const lab = rgbToLab(med);
      let bestIdx = 0;
      let bestD = Infinity;
      for (let i = 0; i < palLabs.length; i++) {
        const d = deltaE2000(lab, palLabs[i]);
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      cells[cy * cols + cx] = bestIdx;
    }
  }

  return { cells, avgRgb, cols, rows };
}

// 给定一个 cell 在源图的位置，把它放大显示到目标 canvas 并叠加 mask 可视化
export function drawCellPreview(image, crop, grid, cellIdx, mask, targetCanvas, options = {}) {
  const { cols, rows } = grid;
  const offX = grid.offsetX ?? 0;
  const offY = grid.offsetY ?? 0;
  const cellW = (crop.w - offX) / cols;
  const cellH = (crop.h - offY) / rows;
  const cx = cellIdx % cols;
  const cy = Math.floor(cellIdx / cols);
  const sx = crop.x + offX + cx * cellW;
  const sy = crop.y + offY + cy * cellH;
  const ctx = targetCanvas.getContext('2d');
  const W = targetCanvas.width;
  const H = targetCanvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, sx, sy, cellW, cellH, 0, 0, W, H);
  // mask 可视化：环形外圈 / 内圈
  const outerR = Math.max(0.1, Math.min(1, mask.outer ?? 0.9));
  const innerR = Math.max(0, Math.min(outerR - 0.05, mask.inner ?? 0.35));
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(34, 144, 240, 0.95)';
  ctx.beginPath();
  ctx.ellipse(W / 2, H / 2, (W / 2) * outerR, (H / 2) * outerR, 0, 0, Math.PI * 2);
  ctx.stroke();
  if (innerR > 0) {
    ctx.strokeStyle = 'rgba(240, 76, 76, 0.95)';
    ctx.beginPath();
    ctx.ellipse(W / 2, H / 2, (W / 2) * innerR, (H / 2) * innerR, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // 把不参与采样的区域整体压暗
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';
  // 显示提取的颜色
  if (options.sampledRgb) {
    const sw = Math.min(36, W * 0.25);
    ctx.fillStyle = `rgb(${options.sampledRgb.join(',')})`;
    ctx.fillRect(4, H - sw - 4, sw, sw);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(4, H - sw - 4, sw, sw);
  }
  ctx.restore();
}

// 工具：根据 cellPx + offset 推出网格在裁剪框内的绝对位置（用于在裁剪 canvas 上画网格）
export function gridLinesForCrop(crop, grid) {
  const { cols, rows } = grid;
  const offX = grid.offsetX ?? 0;
  const offY = grid.offsetY ?? 0;
  const cellW = (crop.w - offX) / cols;
  const cellH = (crop.h - offY) / rows;
  const xs = [];
  const ys = [];
  for (let i = 0; i <= cols; i++) xs.push(offX + i * cellW);
  for (let j = 0; j <= rows; j++) ys.push(offY + j * cellH);
  return { xs, ys };
}

// 辅助：avg 颜色 → hex
export function avgRgbToHex(rgb) { return rgbToHex(rgb); }
