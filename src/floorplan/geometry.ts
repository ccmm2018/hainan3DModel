/**
 * 平面图几何工具：面积 / 质心 / 包围盒 / 点在多边形内 / 坐标归一化。
 * 纯函数，无副作用，不依赖三方库。
 */

import type { ParsedRoom, RoomVertex } from './types';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 鞋带公式求多边形面积（绝对值，单位平方） */
export function polygonArea(pts: RoomVertex[]): number {
  const n = pts.length;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** 多边形质心（面积加权） */
export function polygonCentroid(pts: RoomVertex[]): RoomVertex {
  const n = pts.length;
  if (n === 0) return { x: 0, y: 0 };
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    const sum = pts.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return { x: sum.x / n, y: sum.y / n };
  }
  a *= 0.5;
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

/** 由房间集合计算原始坐标包围盒 */
export function computeBounds(rooms: ParsedRoom[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rooms) {
    for (const p of r.polygon) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

/** 射线法判断点是否在多边形内 */
export function pointInPolygon(pt: RoomVertex, poly: RoomVertex[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersect =
      a.y > pt.y !== b.y > pt.y &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function dist2(a: RoomVertex, b: RoomVertex): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * 把局部坐标映射到目标 viewBox（保留纵横比、居中，并翻转 Y 使图纸正向朝上）。
 * 返回 { scale, offsetX, offsetY }，调用方对每个点计算：
 *   sx = offsetX + (x - minX) * scale
 *   sy = offsetY + (maxY - y) * scale   // 翻转 Y
 */
export function fitTransform(
  bounds: Bounds,
  viewWidth: number,
  viewHeight: number,
  pad = 28,
): { scale: number; offsetX: number; offsetY: number } {
  const w = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const h = Math.max(bounds.maxY - bounds.minY, 1e-6);
  const scale = Math.min((viewWidth - pad * 2) / w, (viewHeight - pad * 2) / h);
  const offsetX = (viewWidth - w * scale) / 2;
  const offsetY = (viewHeight - h * scale) / 2;
  return { scale, offsetX, offsetY };
}

export function projectPoint(
  pt: RoomVertex,
  bounds: Bounds,
  t: { scale: number; offsetX: number; offsetY: number },
): RoomVertex {
  return {
    x: t.offsetX + (pt.x - bounds.minX) * t.scale,
    y: t.offsetY + (bounds.maxY - pt.y) * t.scale,
  };
}
