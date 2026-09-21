/**
 * 几何工具：面积 / 质心 / 包围盒 / 点在多边形内 / 自交检测 /
 * 方位角 / 相似变换 / SVG 拟合变换 / 去重。
 * 纯函数，无副作用，不依赖三方库，不使用 any。
 */

import type { BBox, FloorTransform } from '../types/cad';

/** 二维点（元组，UTM 米或图纸局部坐标） */
export type Pt = [number, number];

/**
 * 鞋带公式：有向（带符号）面积。
 * 逆时针为正、顺时针为负；取绝对值即多边形面积（见 polygonArea）。
 * 注意：返回值是「2 倍有向面积」（A = ½Σ(xᵢyᵢ₊₁ − xᵢ₊₁yᵢ)），函数内已除以 2。
 */
export function shoelace(pts: Pt[]): number {
  const n = pts.length;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** 多边形面积（有向面积的绝对值，单位平方） */
export function polygonArea(pts: Pt[]): number {
  return Math.abs(shoelace(pts));
}

/**
 * 多边形面积加权质心。
 *
 * 易错点：分母是 6·|A|（A 为鞋带「有向面积」，已含 ½），不是 3·A。
 * 推导：Cx = ⅙A · Σ(xᵢ+xᵢ₊₁)(xᵢyᵢ₊₁ − xᵢ₊₁yᵢ)，Cy 同理（y 部分）；
 * 循环中累加的 cross 之和为「2·有向面积」，因此先 ×½ 得到有向面积 A，
 * 再以 6·|A| 归一。切勿把 2·A 直接代入写成 6·(2A)=12A，也不要误用 3A。
 */
export function centroid(pts: Pt[]): Pt {
  const n = pts.length;
  if (n === 0) return [0, 0];
  // 退化（<3 点）无面积，退化为算术平均
  if (n < 3) {
    const s = pts.reduce<Pt>((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
    return [s[0] / n, s[1] / n];
  }
  let cx = 0;
  let cy = 0;
  let sumCross = 0; // 累加为 2·有向面积
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const cross = p[0] * q[1] - q[0] * p[1];
    sumCross += cross;
    cx += (p[0] + q[0]) * cross;
    cy += (p[1] + q[1]) * cross;
  }
  // 有向面积 A = ½·Σcross；分母用 6·|A|（不是 3A）
  const A = sumCross / 2;
  const denom = 6 * Math.abs(A);
  if (denom < 1e-12) {
    const s = pts.reduce<Pt>((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
    return [s[0] / n, s[1] / n];
  }
  return [cx / denom, cy / denom];
}

/** polygonCentroid 的兼容别名（面积加权质心，分母 6·|A|） */
export const polygonCentroid = centroid;

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

/** 射线法判断点是否在多边形内（多边形无需预闭合，函数内部按首尾相连处理） */
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
 * 用于由房间顶点估算楼栋外轮廓（coordinate.ts 的凸包指纹）。
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
 * 两条线段是否「真相交」（交叉，不含共线端点接触）。
 * 用于 isSelfIntersecting 的非相邻边判定。
 * 采用跨立实验：p1p2 跨立 p3p4 且 p3p4 跨立 p1p2。
 */
function segProperIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const cross = (o: Pt, a: Pt, b: Pt): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

/**
 * 多边形是否自交（校验阶段使用）。
 * 检查所有「非相邻」边对是否真相交；相邻边共享顶点、首尾边（第 0 条与第 n-1 条）
 * 也视为相邻，均跳过。
 */
export function isSelfIntersecting(pts: Pt[]): boolean {
  const n = pts.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = pts[i];
    const a2 = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // 跳过相邻边（共享顶点 i+1）以及环绕的首尾边（第 0 与第 n-1 条）
      if (j === i + 1) continue;
      if (i === 0 && j === n - 1) continue;
      const b1 = pts[j];
      const b2 = pts[(j + 1) % n];
      if (segProperIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/**
 * 顶点去重：相邻重复点（双向坐标差 < eps）剔除。
 * removeClosing=true（默认）时，额外剔除「首末闭合重复点」；
 * 解析器在端点软闭合吸附之后调用时应传 false，否则会破坏已闭合的环。
 */
export function simplifyDedup(pts: Pt[], eps = 1e-4, removeClosing = true): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last) {
      out.push(p);
      continue;
    }
    if (Math.abs(p[0] - last[0]) < eps && Math.abs(p[1] - last[1]) < eps) continue;
    out.push(p);
  }
  // 闭合环常见：末点与首点重合，去掉末点
  if (removeClosing && out.length > 1) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.abs(f[0] - l[0]) < eps && Math.abs(f[1] - l[1]) < eps) out.pop();
  }
  return out;
}

/**
 * 方位角（度，[0,360)）。
 * 取「最长边」方向，atan2(dx, dy)（注意参数顺序是 dx 在前、dy 在后）：
 *   正北(0,1) → 0°，正东(1,0) → 90°，正南(0,-1) → 180°，正西(-1,0) → 270°，
 *   即「以正北为 0、顺时针」。结果归一化到 [0,360)。
 */
export function azimuth(pts: Pt[]): number {
  const n = pts.length;
  if (n < 2) return 0;
  let best = 0;
  let bestLen2 = -1;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const len2 = dx * dx + dy * dy;
    if (len2 > bestLen2) {
      bestLen2 = len2;
      best = Math.atan2(dx, dy); // atan2(dx, dy)：正北为 0，顺时针
    }
  }
  let deg = (best * 180) / Math.PI;
  deg %= 360;
  if (deg < 0) deg += 360;
  return deg;
}

/**
 * 主轴方位角（度，正北顺时针）。
 * 基于点集协方差矩阵的主特征方向估算楼栋朝向（与 azimuth 的最长边法互为补充）。
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
