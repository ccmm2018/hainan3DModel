/**
 * 房间顶面文字的「按可用宽度自适应」纯函数。
 *
 * 背景：2.5D 拆出的子房顶面很窄，房号/名称/面积都是单行 SVG <text>（不换行）。
 * 固定字号会让长文本溢出到隔壁房间，一味缩小又会看不清。这里按「先缩字号到可读下限、
 * 仍放不下再逐字截断加省略号」的策略，让文字始终落在房间顶面内且尽量可读。
 *
 * 纯函数、无 DOM 依赖，便于单元测试。宽度只是估算（SVG 字体度量无法脱离 DOM 精确测量），
 * 故对中文按 1em、数字/字母按 0.5~0.7em 的保守估值，宁可略早截断也不溢出。
 */

export interface FitResult {
  /** 最终显示的文本（可能被截断并加 …） */
  text: string;
  /** 最终字号 */
  size: number;
  /** 是否发生了截断（用于决定是否提示可看完整内容） */
  truncated: boolean;
  /** 原始完整文本 */
  full: string;
}

/** 单字符宽度（em 为单位）的保守估算：中日韩全角按 1em，ASCII 按字形宽度打折 */
function charWidthEm(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  // 全角：CJK 统一表意、假名、韩文、全角标点、CJK 兼容（含 ㎡ U+33A1）、emoji
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff))
  ) {
    return 1;
  }
  if (/[ilIj.,:'!|`]/.test(ch)) return 0.34;
  if (/[ft\-\/()\s]/.test(ch)) return 0.46;
  if (/[0-9]/.test(ch)) return 0.58;
  if (/[A-Z]/.test(ch)) return 0.7;
  return 0.56;
}

/** 估算一行文本在给定字号下的像素宽度 */
export function estimateTextWidth(text: string, size: number): number {
  let em = 0;
  for (const ch of text ?? '') em += charWidthEm(ch);
  return em * size;
}

/**
 * 把一行文字塞进 maxWidth：优先在原字号放不下时逐步缩小到 minSize；
 * 到 minSize 仍放不下则逐字截断并在末尾加省略号 …（省略号本身也计入宽度）。
 *
 * @param text 原始文本
 * @param maxWidth 可用像素宽（房间顶面宽减去左右留白）
 * @param baseSize 期望字号（房间高度算出的基准）
 * @param minSize 可读下限字号（再小看不见，宁可截断）
 */
export function fitLabelText(
  text: string,
  maxWidth: number,
  baseSize: number,
  minSize: number,
): FitResult {
  const full = text ?? '';
  if (!full) return { text: '', size: baseSize, truncated: false, full: '' };
  if (!(maxWidth > 0)) return { text: full, size: baseSize, truncated: false, full };

  // 原字号就放得下：原样返回
  if (estimateTextWidth(full, baseSize) <= maxWidth) {
    return { text: full, size: baseSize, truncated: false, full };
  }

  // 有效下限：minSize 是「缩小时的下限」，不该把本就比它还小的 baseSize 反向放大。
  // （5 行压缩排版时 baseSize 可能小于默认 minSize，若用 Math.max(minSize, size) 会被撑大、重新溢出。）
  const effMin = Math.min(baseSize, minSize);

  // 逐步缩小找能放下的最大字号（0.5px 步进，够细且终止确定）
  let size = baseSize;
  while (size > effMin && estimateTextWidth(full, size) > maxWidth) {
    size -= 0.5;
  }
  size = Math.max(effMin, size);
  if (estimateTextWidth(full, size) <= maxWidth) {
    return { text: full, size, truncated: false, full };
  }

  // 到下限仍放不下：逐字截断 + 省略号
  let out = '';
  for (const ch of full) {
    if (estimateTextWidth(out + ch + '…', effMin) > maxWidth) break;
    out += ch;
  }
  return { text: out ? out + '…' : '…', size: effMin, truncated: true, full };
}

export interface VerticalLayout {
  /** 相邻行中心的竖向像素距离 */
  gap: number;
  /** 第 1 行（房间号）字号 */
  sizeNumber: number;
  /** 副行（名称/部门/面积/未分配）字号 */
  sizeOther: number;
}

/**
 * 房间顶面「多行文字」的垂直排版：按顶面屏幕高度与行数，算出能塞进顶面的行距与字号。
 *
 * 4 行（房号/名称/部门/面积）是基准布局，沿用原算法；当「使用面积<建筑面积」时会多出
 * 第 5 行「未分配 X㎡」，若仍用 4 行的行距，文字块总高会从 3×gap 变成 4×gap、顶出房间。
 * 因此在 5 行时压缩行距与字号，使文字块总高与 4 行相当，始终落在顶面内且垂直居中。
 *
 * @param roomHpx 顶面在屏幕上的竖向像素高度
 * @param lineCount 行数（4 或 5）
 * @param isSub 是否拆出的子房（字号/行距再收一档）
 */
export function fitVerticalLayout(roomHpx: number, lineCount: number, isSub = false): VerticalLayout {
  const h = Math.max(0, roomHpx || 0);
  const baseGap = Math.max(h * 0.21, 8);
  const subGap = isSub ? 0.78 : 1;
  const subFont = isSub ? 0.82 : 1;

  // 4 行及以下：完全沿用原算法，避免影响既有显示。
  if (lineCount <= 4) {
    return {
      gap: baseGap * subGap,
      sizeNumber: Math.min(Math.max(baseGap * 0.95, 10), 16) * subFont,
      sizeOther: Math.min(Math.max(baseGap * 0.62, 7.5), 11) * subFont,
    };
  }

  // 5 行：目标让 5 行文字块总高（4×gap + 字号）不超过原 4 行总高（3×baseGap + 字号）。
  // 取 0.72 的行距系数即可达到；再用 roomHpx 额外兜一层上限，防止极小顶面仍溢出。
  const byRows = baseGap * 0.72;
  const byHeight = (h * 0.9) / (lineCount - 1);
  const gap = Math.min(byRows, byHeight) * subGap;
  return {
    gap,
    sizeNumber: Math.min(Math.max(gap * 0.95, 8.5), 14) * subFont,
    sizeOther: Math.min(Math.max(gap * 0.62, 6.5), 10) * subFont,
  };
}
