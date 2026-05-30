// 分辨率扫描：在 [minW, maxW] 整数范围内全量扫描，找出"特殊点"——
// 即虽然分辨率更小，但失真分数（cell 内 Lab 标准差均值）反而比某些更大邻居更低的尺寸。
// 用 Summed-Area-Table，所以扫描整个区间在 1 秒内可完成。

import { rgbToLab } from './color.js';

const WORK_LONG_EDGE = 384; // 太大的源图先下采样到这个长边，避免内存爆炸

export async function analyzeResolutions(image, options = {}) {
  const minW = Math.max(4, Math.floor(options.minW ?? 24));
  const maxW = Math.max(minW + 1, Math.floor(options.maxW ?? 192));
  const window = Math.max(2, Math.floor(options.window ?? 12));

  const srcW = image.naturalWidth || image.width;
  const srcH = image.naturalHeight || image.height;
  if (!srcW || !srcH) throw new Error('源图尺寸无效');
  const srcAspect = srcW / srcH;

  // 把源图下采样到工作尺寸
  const long = Math.max(srcW, srcH);
  const sf = Math.min(1, WORK_LONG_EDGE / long);
  const workW = Math.max(1, Math.round(srcW * sf));
  const workH = Math.max(1, Math.round(srcH * sf));

  const cv = document.createElement('canvas');
  cv.width = workW;
  cv.height = workH;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, workW, workH);
  const id = ctx.getImageData(0, 0, workW, workH);

  // 像素 → Lab
  const N = workW * workH;
  const L = new Float32Array(N);
  const A = new Float32Array(N);
  const B = new Float32Array(N);
  const data = id.data;
  for (let i = 0; i < N; i++) {
    const off = i * 4;
    const lab = rgbToLab([data[off], data[off + 1], data[off + 2]]);
    L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2];
  }

  // 6 个 SAT：L, A, B 和 L², A², B²
  const ww = workW + 1;
  const buildSAT = (values, sq) => {
    const sat = new Float64Array(ww * (workH + 1));
    for (let y = 1; y <= workH; y++) {
      let rowSum = 0;
      for (let x = 1; x <= workW; x++) {
        const v = values[(y - 1) * workW + (x - 1)];
        rowSum += sq ? v * v : v;
        sat[y * ww + x] = sat[(y - 1) * ww + x] + rowSum;
      }
    }
    return sat;
  };
  const satL = buildSAT(L, false);
  const satA = buildSAT(A, false);
  const satB = buildSAT(B, false);
  const satL2 = buildSAT(L, true);
  const satA2 = buildSAT(A, true);
  const satB2 = buildSAT(B, true);

  const rect = (sat, x1, y1, x2, y2) =>
    sat[y2 * ww + x2] - sat[y1 * ww + x2] - sat[y2 * ww + x1] + sat[y1 * ww + x1];

  const all = [];
  for (let W = minW; W <= maxW; W++) {
    const H = Math.max(1, Math.round(W / srcAspect));
    let sum = 0;
    let count = 0;
    for (let cy = 0; cy < H; cy++) {
      const y1 = Math.floor(cy * workH / H);
      const y2 = Math.min(workH, Math.floor((cy + 1) * workH / H));
      if (y2 <= y1) continue;
      for (let cx = 0; cx < W; cx++) {
        const x1 = Math.floor(cx * workW / W);
        const x2 = Math.min(workW, Math.floor((cx + 1) * workW / W));
        if (x2 <= x1) continue;
        const n = (x2 - x1) * (y2 - y1);
        const mL = rect(satL, x1, y1, x2, y2) / n;
        const mA = rect(satA, x1, y1, x2, y2) / n;
        const mB = rect(satB, x1, y1, x2, y2) / n;
        const vL = Math.max(0, rect(satL2, x1, y1, x2, y2) / n - mL * mL);
        const vA = Math.max(0, rect(satA2, x1, y1, x2, y2) / n - mA * mA);
        const vB = Math.max(0, rect(satB2, x1, y1, x2, y2) / n - mB * mB);
        sum += Math.sqrt(vL + vA + vB);
        count++;
      }
    }
    const score = count > 0 ? sum / count : 0;
    all.push({ width: W, height: H, score, beadCount: W * H });
  }

  // 每个点向前看 window 个邻居，统计有多少更大但更差的——即"smaller beats larger"
  for (let i = 0; i < all.length; i++) {
    let beats = 0;
    let minRightScore = Infinity;
    const end = Math.min(all.length, i + 1 + window);
    for (let j = i + 1; j < end; j++) {
      if (all[i].score < all[j].score) beats++;
      if (all[j].score < minRightScore) minRightScore = all[j].score;
    }
    all[i].beats = beats;
    // 当前点相对前方窗口最小值有多少优势（仅在为正时有意义）
    all[i].advantage = isFinite(minRightScore) ? Math.max(0, minRightScore - all[i].score) : 0;
  }

  const special = all.filter((p) => p.beats > 0);

  // 划算 = 击败数 × 优势分 ÷ 用豆数^0.4
  for (const p of special) {
    p.efficiency = (p.beats + 0.5) * (p.advantage + 0.05) / Math.pow(p.beadCount, 0.4);
  }
  special.sort((a, b) => b.efficiency - a.efficiency);

  return { all, special, minW, maxW, window, workW, workH, srcAspect };
}
