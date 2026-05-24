export const EMPTY = -1;

export function clamp(value, min = 0, max = 255) {
  return Math.min(max, Math.max(min, value));
}

export function hexToRgb(hex) {
  const clean = String(hex).trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) throw new Error(`Invalid hex color: ${hex}`);
  return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
}

export function rgbToHex(rgb) {
  return '#' + rgb.map((v) => clamp(Math.round(v)).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function srgbChannelToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function xyzPivot(t) {
  return t > 0.008856 ? Math.cbrt(t) : 7.787037 * t + 16 / 116;
}

export function rgbToXyz(rgb) {
  const r = srgbChannelToLinear(rgb[0]);
  const g = srgbChannelToLinear(rgb[1]);
  const b = srgbChannelToLinear(rgb[2]);
  return [
    (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) * 100,
    (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) * 100,
    (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) * 100,
  ];
}

export function rgbToLab(rgb) {
  const [x, y, z] = rgbToXyz(rgb);
  const fx = xyzPivot(x / 95.047);
  const fy = xyzPivot(y / 100.0);
  const fz = xyzPivot(z / 108.883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function weightedLabDistance(labA, labB, weights = {}) {
  const wL = weights.lightness ?? 1;
  const wA = weights.chroma ?? 1;
  const wB = weights.chroma ?? 1;
  const dL = (labA[0] - labB[0]) * wL;
  const da = (labA[1] - labB[1]) * wA;
  const db = (labA[2] - labB[2]) * wB;
  return Math.sqrt(dL * dL + da * da + db * db);
}

function degToRad(d) { return (d * Math.PI) / 180; }
function radToDeg(r) { return (r * 180) / Math.PI; }

// CIEDE2000, D65 Lab input. Used for perceptual palette matching.
export function deltaE2000(lab1, lab2, weights = {}) {
  const L1 = lab1[0]; const a1 = lab1[1]; const b1 = lab1[2];
  const L2 = lab2[0]; const a2 = lab2[1]; const b2 = lab2[2];
  const kL = 1 / (weights.lightness ?? 1);
  const kC = 1 / (weights.chroma ?? 1);
  const kH = 1 / (weights.chroma ?? 1);

  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);
  const h1p = C1p === 0 ? 0 : (radToDeg(Math.atan2(b1, a1p)) + 360) % 360;
  const h2p = C2p === 0 ? 0 : (radToDeg(Math.atan2(b2, a2p)) + 360) % 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else if (h2p <= h1p) dhp = h2p - h1p + 360;
  else dhp = h2p - h1p - 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(degToRad(dhp / 2));

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp;
  if (C1p * C2p === 0) hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
  else hbarp = (h1p + h2p - 360) / 2;

  const T = 1
    - 0.17 * Math.cos(degToRad(hbarp - 30))
    + 0.24 * Math.cos(degToRad(2 * hbarp))
    + 0.32 * Math.cos(degToRad(3 * hbarp + 6))
    - 0.20 * Math.cos(degToRad(4 * hbarp - 63));
  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const RC = 2 * Math.sqrt(Math.pow(Cbarp, 7) / (Math.pow(Cbarp, 7) + Math.pow(25, 7)));
  const SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin(degToRad(2 * dTheta)) * RC;
  const lTerm = dLp / (kL * SL);
  const cTerm = dCp / (kC * SC);
  const hTerm = dHp / (kH * SH);
  return Math.sqrt(lTerm * lTerm + cTerm * cTerm + hTerm * hTerm + RT * cTerm * hTerm);
}

export function colorDistance(labA, labB, options = {}) {
  return options.metric === 'de2000'
    ? deltaE2000(labA, labB, options)
    : weightedLabDistance(labA, labB, options);
}

export function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((x) => {
    const v = x / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function readableTextColor(rgb) {
  return relativeLuminance(rgb) > 0.58 ? '#1b1b1b' : '#ffffff';
}

export function displayCode(palette, color) {
  const code = color?.code ?? '';
  const prefix = palette?.hidePrefix;
  if (prefix && typeof code === 'string' && code.startsWith(prefix)) {
    const rest = code.slice(prefix.length);
    if (rest) return rest;
  }
  return code;
}

export function preparePalette(palette, options = {}) {
  const exclude = new Set(options.excludeCodes ?? []);
  const includeSpecial = !!options.includeSpecial;
  const includeTransparent = !!options.includeTransparent;
  const colors = palette.colors
    .map((color, index) => ({
      ...color,
      sourceIndex: index,
      rgb: color.rgb ?? hexToRgb(color.hex),
      lab: rgbToLab(color.rgb ?? hexToRgb(color.hex)),
    }))
    .filter((color) => {
      if (exclude.has(color.code)) return false;
      if (color.transparent && !includeTransparent) return false;
      if ((color.kind === 'special' || color.family === 'P' || color.family === 'Q' || color.family === 'R' || color.family === 'Y' || color.family === 'ZG') && !includeSpecial && options.paletteId !== 'mard_264_compat') {
        // For extended palettes, keep special series only when explicitly allowed. The 264 compat palette already represents its chosen special subset.
        return false;
      }
      return true;
    });
  const byIndex = new Map(colors.map((color) => [color.sourceIndex, color]));
  const labByIndex = [];
  const rgbByIndex = [];
  for (const color of colors) {
    labByIndex[color.sourceIndex] = color.lab;
    rgbByIndex[color.sourceIndex] = color.rgb;
  }
  return { colors, byIndex, labByIndex, rgbByIndex };
}

export function clonePalette(palette) {
  return JSON.parse(JSON.stringify(palette));
}

export function normalizePalette(raw, fallbackId = 'custom_palette') {
  const palette = Array.isArray(raw) ? { colors: raw } : raw;
  if (!palette || !Array.isArray(palette.colors)) throw new Error('色卡必须是 { colors: [...] } 或颜色数组。');
  const colors = palette.colors.map((c, idx) => {
    const code = String(c.code ?? c.id ?? `C${idx + 1}`).trim();
    const rgb = c.rgb ? c.rgb.map(Number) : hexToRgb(c.hex);
    const hex = c.hex ? rgbToHex(hexToRgb(c.hex)) : rgbToHex(rgb);
    return {
      code,
      name: String(c.name ?? code),
      hex,
      rgb,
      transparent: !!c.transparent,
      family: c.family ?? (code.match(/^[A-Za-z]+/)?.[0]?.toUpperCase() ?? 'C'),
      kind: c.kind ?? (c.transparent ? 'transparent' : 'solid'),
    };
  });
  return {
    id: palette.id ?? fallbackId,
    label: palette.label ?? palette.name ?? '自定义色卡',
    standard: palette.standard ?? 'CUSTOM',
    beadSizeMm: palette.beadSizeMm ?? null,
    source: palette.source ?? 'Imported by user',
    notes: palette.notes ?? '',
    defaultExcludeTransparent: palette.defaultExcludeTransparent ?? true,
    colors,
  };
}

export function parsePaletteCsv(text) {
  const rows = text.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const cells = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { current += '"'; i++; }
        else quoted = !quoted;
      } else if (ch === ',' && !quoted) {
        cells.push(current.trim()); current = '';
      } else current += ch;
    }
    cells.push(current.trim());
    return cells;
  });
  if (!rows.length) throw new Error('CSV为空。');
  const header = rows[0].map((x) => x.toLowerCase());
  const hasHeader = header.includes('code') || header.includes('hex') || header.includes('r');
  const data = hasHeader ? rows.slice(1) : rows;
  const idx = (name, fallback) => header.indexOf(name) >= 0 ? header.indexOf(name) : fallback;
  const codeI = hasHeader ? idx('code', 0) : 0;
  const nameI = hasHeader ? idx('name', -1) : -1;
  const hexI = hasHeader ? idx('hex', 1) : 1;
  const rI = hasHeader ? idx('r', -1) : -1;
  const gI = hasHeader ? idx('g', -1) : -1;
  const bI = hasHeader ? idx('b', -1) : -1;
  const colors = data.map((row, i) => {
    const code = row[codeI] || `C${i + 1}`;
    const name = nameI >= 0 ? row[nameI] : code;
    let rgb;
    if (hexI >= 0 && row[hexI]) rgb = hexToRgb(row[hexI]);
    else if (rI >= 0 && gI >= 0 && bI >= 0) rgb = [Number(row[rI]), Number(row[gI]), Number(row[bI])];
    else throw new Error('CSV需要 code,hex 或 code,r,g,b 列。');
    return { code, name, rgb, hex: rgbToHex(rgb) };
  });
  return normalizePalette({ id: `custom_${Date.now()}`, label: '导入色卡', colors });
}
