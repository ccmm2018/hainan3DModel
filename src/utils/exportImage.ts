/**
 * 打印/导出工具：截图标注叠加、灰度、旋转、PNG/PDF 下载
 */

import { jsPDF } from 'jspdf';

export interface ExportLabel {
  /** 标注文本（可多行，用 \n 分隔） */
  text: string;
  /** 屏幕坐标（CSS 像素） */
  x: number;
  y: number;
}

export interface ExportOptions {
  /** 是否叠加显示标注 */
  overlay: boolean;
  /** 是否显示颜色（否则转灰度） */
  showColors: boolean;
  /** 字号（px） */
  fontSize: number;
  /** 旋转角度（度） */
  rotation: number;
}

/** 将截图 + 标注合成为最终 canvas（含灰度、旋转） */
export async function composeExport(
  imageUrl: string,
  labels: ExportLabel[],
  opts: ExportOptions,
  containerSize?: { width: number; height: number },
): Promise<HTMLCanvasElement> {
  // 1. 加载截图
  const img = await loadImage(imageUrl);
  // 截图分辨率为 drawingBuffer（CSS 尺寸 × pixelRatio），据此把 CSS 坐标缩放到图像坐标
  const scale = containerSize && containerSize.width > 0 ? img.width / containerSize.width : 1;

  let canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  let ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  // 2. 灰度
  if (!opts.showColors) {
    canvas = grayscale(canvas);
    ctx = canvas.getContext('2d')!;
  }

  // 3. 叠加标注
  if (opts.overlay) {
    const fs = Math.max(8, opts.fontSize * scale);
    for (const label of labels) {
      drawLabel(ctx, label.text, label.x * scale, label.y * scale, fs);
    }
  }

  // 4. 旋转
  if (opts.rotation % 360 !== 0) {
    canvas = rotateCanvas(canvas, opts.rotation);
  }

  return canvas;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function grayscale(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(source, 0, 0);
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = gray;
    d[i + 1] = gray;
    d[i + 2] = gray;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fontSize: number): void {
  const lines = text.split('\n');
  const lineHeight = fontSize * 1.35;
  const paddingX = 6;
  const paddingY = 4;

  ctx.font = `${fontSize}px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif`;
  ctx.textBaseline = 'top';

  // 计算文本宽度
  let maxWidth = 0;
  for (const line of lines) {
    maxWidth = Math.max(maxWidth, ctx.measureText(line).width);
  }
  const boxW = maxWidth + paddingX * 2;
  const boxH = lineHeight * lines.length + paddingY * 2;

  // 半透明背景 + 边框
  ctx.fillStyle = 'rgba(10, 18, 32, 0.78)';
  ctx.fillRect(x - boxW / 2, y - boxH - 6, boxW, boxH);
  ctx.strokeStyle = 'rgba(120, 160, 210, 0.6)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x - boxW / 2, y - boxH - 6, boxW, boxH);

  // 文本
  ctx.fillStyle = '#eaf2ff';
  lines.forEach((line, i) => {
    ctx.fillText(line, x - maxWidth / 2, y - boxH - 6 + paddingY + i * lineHeight);
  });
}

function rotateCanvas(source: HTMLCanvasElement, degrees: number): HTMLCanvasElement {
  const rad = (degrees * Math.PI) / 180;
  const w = source.width;
  const h = source.height;
  const newW = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
  const newH = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(newW);
  canvas.height = Math.ceil(newH);
  const ctx = canvas.getContext('2d')!;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(source, -w / 2, -h / 2);
  return canvas;
}

/** 下载 PNG */
export function downloadCanvasAsPng(canvas: HTMLCanvasElement, filename: string): void {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `${filename}.png`;
  a.click();
}

/** 生成 PDF 并下载 */
export function downloadCanvasAsPdf(
  canvas: HTMLCanvasElement,
  filename: string,
  paperSize: 'A4' | 'A3',
): void {
  const format = paperSize === 'A3' ? 'a3' : 'a4';
  const orientation = canvas.width >= canvas.height ? 'landscape' : 'portrait';
  const pdf = new jsPDF({ orientation, unit: 'mm', format });

  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 10;
  const availW = pageW - margin * 2;
  const availH = pageH - margin * 2;
  const imgRatio = canvas.width / canvas.height;
  let w = availW;
  let h = availW / imgRatio;
  if (h > availH) {
    h = availH;
    w = availH * imgRatio;
  }
  const x = (pageW - w) / 2;
  const y = (pageH - h) / 2;

  const imgData = canvas.toDataURL('image/jpeg', 0.92);
  pdf.addImage(imgData, 'JPEG', x, y, w, h);
  pdf.save(`${filename}.pdf`);
}
