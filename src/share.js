// 紧凑分享格式：
//   [0..3]   magic "BPS1"
//   [4]      bpp (1..16) —— 每像素位数，等于 ceil(log2(色卡色数 + 1))
//   [5..6]   width  (uint16 BE)
//   [7..8]   height (uint16 BE)
//   [9]      palette_id 长度（UTF-8 字节数，1..255）
//   [10..]   palette_id (UTF-8)
//   [...]    像素数据，bit-packed，big-bit-first；0 代表空格，n>0 代表 palette.colors[n-1]
//
// 整个字节流 deflate-raw 压缩后再 base64url 编码。色卡颜色本身不入流，
// 接收方需要有相同 id 的色卡（内置色卡都满足，自定义色卡需要先导入）。

const MAGIC = [0x42, 0x50, 0x53, 0x31]; // 'BPS1'

function bppFor(numColors) {
  let bits = 1;
  while ((1 << bits) - 1 < numColors) bits++;
  return Math.max(1, Math.min(16, bits));
}

export function isShareSupported() {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持压缩（需要 iOS 16.4+ / Chrome 80+ / Firefox 113+）');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持解压（需要 iOS 16.4+ / Chrome 80+ / Firefox 113+）');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function bytesToBase64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const bin = atob(padded + '='.repeat(padLen));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function encodePatternToShareCode(pattern) {
  const { width, height, cells, palette } = pattern;
  if (!palette || !palette.id) throw new Error('图纸缺少色卡 id');
  const idBytes = new TextEncoder().encode(palette.id);
  if (idBytes.length > 255) throw new Error('色卡 id 太长');
  const bpp = bppFor(palette.colors.length);
  const totalPx = width * height;
  const bodyLen = Math.ceil((totalPx * bpp) / 8);
  const headerLen = 4 + 1 + 2 + 2 + 1 + idBytes.length;
  const buf = new Uint8Array(headerLen + bodyLen);
  let off = 0;
  for (const b of MAGIC) buf[off++] = b;
  buf[off++] = bpp;
  buf[off++] = (width >>> 8) & 0xff; buf[off++] = width & 0xff;
  buf[off++] = (height >>> 8) & 0xff; buf[off++] = height & 0xff;
  buf[off++] = idBytes.length;
  buf.set(idBytes, off); off += idBytes.length;

  let bitBuf = 0;
  let bitCount = 0;
  for (let i = 0; i < totalPx; i++) {
    const v = cells[i];
    const enc = v < 0 ? 0 : v + 1;
    bitBuf = ((bitBuf << bpp) | enc) >>> 0;
    bitCount += bpp;
    while (bitCount >= 8) {
      bitCount -= 8;
      buf[off++] = (bitBuf >>> bitCount) & 0xff;
      bitBuf &= bitCount === 0 ? 0 : (1 << bitCount) - 1;
    }
  }
  if (bitCount > 0) {
    buf[off++] = (bitBuf << (8 - bitCount)) & 0xff;
  }

  const compressed = await deflateRaw(buf);
  return bytesToBase64Url(compressed);
}

export async function decodeShareCode(code, paletteLookup) {
  const bytes = base64UrlToBytes(code);
  let raw;
  try {
    raw = await inflateRaw(bytes);
  } catch {
    throw new Error('分享数据解压失败');
  }
  let off = 0;
  if (raw.length < 10) throw new Error('分享数据太短');
  for (let i = 0; i < 4; i++) {
    if (raw[off++] !== MAGIC[i]) throw new Error('不是有效的分享数据');
  }
  const bpp = raw[off++];
  if (bpp < 1 || bpp > 16) throw new Error(`不支持的位深: ${bpp}`);
  const width = (raw[off++] << 8) | raw[off++];
  const height = (raw[off++] << 8) | raw[off++];
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
    throw new Error(`非法尺寸 ${width}×${height}`);
  }
  const idLen = raw[off++];
  if (off + idLen > raw.length) throw new Error('色卡 id 越界');
  const paletteId = new TextDecoder().decode(raw.subarray(off, off + idLen));
  off += idLen;
  const palette = paletteLookup(paletteId);
  if (!palette) {
    const err = new Error(`找不到色卡 "${paletteId}"，请先在本地导入`);
    err.paletteId = paletteId;
    throw err;
  }

  const totalPx = width * height;
  const cells = new Int16Array(totalPx);
  const mask = (1 << bpp) - 1;
  let bitBuf = 0;
  let bitCount = 0;
  for (let i = 0; i < totalPx; i++) {
    while (bitCount < bpp) {
      if (off >= raw.length) throw new Error('像素数据被截断');
      bitBuf = ((bitBuf << 8) | raw[off++]) >>> 0;
      bitCount += 8;
    }
    bitCount -= bpp;
    const enc = (bitBuf >>> bitCount) & mask;
    bitBuf &= bitCount === 0 ? 0 : (1 << bitCount) - 1;
    cells[i] = enc === 0 ? -1 : enc - 1;
  }
  return { width, height, palette, cells };
}
