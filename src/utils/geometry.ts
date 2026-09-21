/**
 * 几何工具：面积 / 质心 / 包围盒 / 点在多边形内 / 凸包 /
 * 主轴角（方位角）/ 相似变换 / SVG 拟合变换。
 * 纯函数，无副作用，不依赖三方库，不使用 any。
 */

import type { BBox, FloorTransform } from '../types/cad';

/** 二维点（元组，UTM 米或图纸局部坐标） */
export type Pt = [number, number];

/** 鞋带公式求多边形面积（绝对值，单位平方） */
export function polygonArea(pts: Pt[]): number {
  const n = pts.length;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** 多边形面积加权质心 */
export function polygonCentroid(pts: Pt[]): Pt {
  const n = pts.length;
  if (n === 0) return [0, 0];
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const cross = p[0] * q[1] - q[0] * p[1];
    a += cross;
    cx += (p[0] + q[0]) * cross;
    cy += (p[1] + q[1]) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    const s = pts.reduce<Pt>((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
    return [s[0] / n, s[1] / n];
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

/** 由点集计算包围盒 */
export function bounds(pts: Pt[]): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

/** 射线法判断点是否在多边形内 */
export function pointInPolygon(pt: Pt, poly: Pt[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersect =
      a[1] > pt[1] !== b[1] > pt[1] &&
      pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0];
    if (intersect) inside = !inside;
  }
  return inside;
}

export function dist2(a: Pt, b: Pt): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/**
 * Andrew 单调链凸包（返回逆时针外轮廓）。
 * 用于由房间顶点估算楼栋外轮廓。
 */
export function convexHull(points: Pt[]): Pt[] {
  const pts = points
    .slice()
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const uniq: Pt[] = [];
  for (const p of pts) {
    if (!uniq.length || uniq[uniq.length - 1][0] !== p[0] || uniq[uniq.length - 1][1] !== p[1]) {
      uniq.push(p);
    }
  }
  if (uniq.length <= 2) return uniq;

  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Pt[] = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * 主轴方位角（度，正北顺时针）。
 * 基于点集协方差矩阵的主特征方向估算楼栋朝向。
 */
export function principalAxisAngle(points: Pt[]): number {
  const n = points.length;
  if (n < 2) return 0;
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p[0];
    cy += p[1];
  }
  cx /= n;
  cy /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let deg = (theta * 180) / Math.PI;
  if (deg < 0) deg += 180;
  return deg;
}

/** 相似变换：先旋转，再缩放，再平移 */
export function transformPoint(p: Pt, t: FloorTransform): Pt {
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  const rx = p[0] * c - p[1] * s;
  const ry = p[0] * s + p[1] * c;
  return [rx * t.scale + t.offset[0], ry * t.scale + t.offset[1]];
}

export function transformPolygon(poly: Pt[], t: FloorTransform): Pt[] {
  return poly.map((p) => transformPoint(p, t));
}

/** 相似变换的面积缩放系数（= scale²） */
export function areaScale(t: FloorTransform): number {
  return t.scale * t.scale;
}

/**
 * 把局部坐标映射到目标 viewBox（保留纵横比、居中，并翻转 Y 使图纸正向朝上）。
 * 调用方对每个点计算：
 *   sx = offsetX + (x - minX) * scale
 *   sy = offsetY + (maxY - y) * scale   // 翻转 Y
 */
export function fitTransform(
  bbox: BBox,
  viewWidth: number,
  viewHeight: number,
  pad = 28,
): { scale: number; offsetX: number; offsetY: number } {
  const w = Math.max(bbox.maxX - bbox.minX, 1e-6);
  const h = Math.max(bbox.maxY - bbox.minY, 1e-6);
  const scale = Math.min((viewWidth - pad * 2) / w, (viewHeight - pad * 2) / h);
  const offsetX = (viewWidth - w * scale) / 2;
  const offsetY = (viewHeight - h * scale) / 2;
  return { scale, offsetX, offsetY };
}

export function projectPoint(
  pt: Pt,
  bbox: BBox,
  t: { scale: number; offsetX: number; offsetY: number },
): Pt {
  return [
    t.offsetX + (pt[0] - bbox.minX) * t.scale,
    t.offsetY + (bbox.maxY - pt[1]) * t.scale,
  ];
}
