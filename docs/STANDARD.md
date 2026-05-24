# 拼豆图纸标准草案（Bead Pattern Studio）

## 1. 基本概念

拼豆图纸不是无限色彩的图片，而是一个离散材料问题：每个格子只能选择某个色号的实体豆，或者不放豆。因此“221色”“264色”“291色”不是普通意义上的连续色域，而是某个品牌、商家或社区约定的色号集合。

一个色卡标准在本项目里定义为：

```ts
type PaletteColor = {
  code: string;          // 色号，例如 MA1 / A1 / P23
  name?: string;         // 可选名称
  hex: string;           // sRGB HEX，作为屏幕预览与匹配参考
  rgb: [number,number,number];
  transparent?: boolean; // 是否透明/空豆
  family?: string;       // A/B/C/P/ZG 等系列
  kind?: 'solid' | 'special' | 'transparent';
}

type PaletteSet = {
  id: string;
  label: string;
  standard: string;
  beadSizeMm?: number | null;
  source?: string;
  notes?: string;
  colors: PaletteColor[];
}
```

注意：RGB/HEX 是图纸生成的工程近似，不等于实际豆子的绝对物理颜色。实际效果会受豆子批次、熨烫程度、光线、拍摄白平衡和显示器影响。

## 2. 内置色卡

### ARTKAL-M-MINI-221-2025

- 2.6mm 小豆。
- 221 项，其中 MH1 是透明色，默认排除。
- 其余 220 项使用 Artkal 官方 RGB 表。

### MARD-221-BITBEAD

- MARD 基础 221 色。
- 包含 A-H 与 M 系列。
- 使用 Bitbead HEX 表。

### MARD-264-COMPAT-221-PQR15

- 本项目定义的 264 兼容集。
- 组成：MARD 221 + P1-P23 + Q1-Q5 + R1-R15。
- 这样做是因为市面“264色”常见，但商家公开的精确子集并不稳定；项目必须有可导入/导出的确定标准。
- 如果你的实物 264 色卡不同，应导入自定义色卡。

### MARD-291-BITBEAD

- MARD 扩展 291 色。
- 基础 221 + P/Q/R/T/Y/ZG 扩展系列。

## 3. 图纸生成流程

### 3.1 输入采样

1. 将图片按用户给定宽高缩放到 `W × H`。
2. `contain` 保留完整图，空余区域留空或填底色；`cover` 裁切铺满；`stretch` 强制拉伸。
3. 像素 alpha 低于阈值时标记为空格。
4. 可选：接近白色的像素作为“候选空格”。默认只把与画布边缘连通的候选空格标记为空，用于抠除白底，同时避免吞掉角色内部高光；如传入 `whiteRemovalMode: "global"`，则全局近白都置空。
5. 可选：预柔化，降低噪声和单颗散豆。

### 3.2 色差度量

默认使用 CIEDE2000；也可选择 Lab76 快速模式。所有颜色先从 sRGB 转换到 CIE Lab（D65 白点），再计算色差。

### 3.3 最大用色数

当 `maxColors > 0` 时：

1. 先用全色卡做一次近似匹配。
2. 按覆盖像素数和平均误差加权排序。
3. 选出前 `maxColors` 个施工色。
4. 再用这个子色卡重新匹配。

这一步是为了减少需要准备的豆子种类，也减少色号切换。

### 3.4 手工复杂度优化

初始量化后，项目使用近似 MRF（Markov Random Field）式的局部优化：

```text
cost(pixel, candidateColor)
= perceptualColorError(sourcePixel, candidateColor)
+ coherence * sum(neighborMismatchPenalty)
```

- `coherence` 越高，相同颜色越倾向形成大块。
- `edgeProtect` 用原图边缘强度削弱跨边缘的平滑，避免五官、轮廓糊掉。
- 候选色不是全色卡暴力搜索，而是“当前色 + 原图最近色 + 邻居色”，兼顾速度和块面连续性。

### 3.5 孤岛清理

对每个连通色块，如果面积小于 `minIsland`，尝试替换成周围边界颜色中综合代价最低的颜色。这样可以减少大量“隔一个换一个”的施工痛苦。

### 3.6 复杂度指标

复杂度是 0-100 的工程指标，越高越难摆：

- 颜色种类越多，复杂度越高。
- 色块连通分量越多，复杂度越高。
- 孤豆越多，复杂度越高。
- 横向平均连续长度越大，复杂度越低。

这个指标不是审美评分，是施工难度提示。

## 4. 图纸格式 .pbdx

`.pbdx` 是 JSON。它必须包含完整色卡，所以导入后不依赖外部色卡文件。

```ts
type BeadPatternX = {
  type: 'BeadPatternX';
  version: 1;
  createdAt: string;
  width: number;
  height: number;
  emptyIndex: -1;
  paletteId: string;
  palette: PaletteSet;
  cellsRle: [number, number][]; // [paletteIndex 或 -1, runLength]
  params: object;
  metrics: object;
  source?: object;
  notes?: string;
}
```

## 5. 导出建议

- 给自己施工：导出“施工页 HTML”，它会按板线间隔拆成分板页，并在每格里打印色号；总览 PNG/SVG 适合发布预览。
- 给别人二次编辑：导出 `.pbdx`。
- 统计采购：导出 CSV。
- 需要矢量排版：导出 SVG。
