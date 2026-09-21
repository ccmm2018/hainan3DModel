import { describe, expect, it } from 'vitest';
import {
  azimuth,
  bounds,
  centroid,
  convexHull,
  fitTransform,
  isSelfIntersecting,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  principalAxisAngle,
  shoelace,
  simplifyDedup,
  transformPoint,
  type Pt,
} from '../geometry';

describe('geometry', () => {
  const square: Pt[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];

  it('polygonArea 计算闭合多边形面积', () => {
    expect(polygonArea(square)).toBe(100);
    expect(polygonArea([[0, 0], [1, 0], [1, 1]])).toBeCloseTo(0.5);
    expect(polygonArea([[0, 0]])).toBe(0);
  });

  it('shoelace 返回有向（带符号）面积，绝对值即面积', () => {
    // 逆时针为正
    expect(shoelace(square)).toBeCloseTo(100);
    // 顺时针为负
    const cw = square.slice().reverse();
    expect(shoelace(cw)).toBeCloseTo(-100);
    // 面积 = |shoelace|
    expect(polygonArea(square)).toBeCloseTo(Math.abs(shoelace(square)));
  });

  it('centroid 质心分母为 6|A|（直角三角形手算校验）', () => {
    // 直角三角 (0,0)(10,0)(0,10)：面积 50，几何质心 (10/3, 10/3)
    const tri: Pt[] = [
      [0, 0],
      [10, 0],
      [0, 10],
    ];
    const c = centroid(tri);
    expect(c[0]).toBeCloseTo(10 / 3);
    expect(c[1]).toBeCloseTo(10 / 3);
    // polygonCentroid 为 centroid 别名，结果一致
    const c2 = polygonCentroid(tri);
    expect(c2[0]).toBeCloseTo(c[0]);
    expect(c2[1]).toBeCloseTo(c[1]);
  });

  it('polygonCentroid 返回质心', () => {
    const c = polygonCentroid(square);
    expect(c[0]).toBeCloseTo(5);
    expect(c[1]).toBeCloseTo(5);
  });

  it('azimuth 取最长边方向（atan2(dx,dy)，正北=0 顺时针）', () => {
    // 长边水平朝东的矩形 → 90°
    const eastRect: Pt[] = [
      [0, 0],
      [100, 0],
      [100, 10],
      [0, 10],
    ];
    const a = azimuth(eastRect);
    expect(a).toBeCloseTo(90);
    // 长边朝北的矩形 → 0°
    const northRect: Pt[] = [
      [0, 0],
      [0, 100],
      [10, 100],
      [10, 0],
    ];
    expect(azimuth(northRect)).toBeCloseTo(0);
    // 结果归一化到 [0,360)
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(360);
  });

  it('isSelfIntersecting 检测自交（非相邻边求交）', () => {
    // 蝴蝶结自交
    const bowtie: Pt[] = [
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 10],
    ];
    expect(isSelfIntersecting(bowtie)).toBe(true);
    // 正常矩形不自交
    expect(isSelfIntersecting(square)).toBe(false);
    // 点数不足 4 不自交
    expect(isSelfIntersecting([[0, 0], [10, 0], [0, 10]])).toBe(false);
  });

  it('simplifyDedup 去除相邻重复点（含闭合首末重复）', () => {
    const dup: Pt[] = [
      [0, 0],
      [0, 0],
      [5, 0],
      [5, 0],
      [5, 5],
    ];
    expect(simplifyDedup(dup)).toEqual([
      [0, 0],
      [5, 0],
      [5, 5],
    ]);
    const closing: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    expect(simplifyDedup(closing).length).toBe(4);
    // 容差生效
    expect(
      simplifyDedup(
        [
          [0, 0],
          [0, 1e-9],
        ],
        1e-4,
      ).length,
    ).toBe(1);
  });

  it('pointInPolygon 判断内外', () => {
    expect(pointInPolygon([5, 5], square)).toBe(true);
    expect(pointInPolygon([15, 5], square)).toBe(false);
    expect(pointInPolygon([5, -1], square)).toBe(false);
  });

  it('convexHull 返回逆时针外轮廓', () => {
    const pts: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [5, 5],
    ];
    const hull = convexHull(pts);
    expect(hull.length).toBe(4);
  });

  it('principalAxisAngle 返回有限角度', () => {
    const pts: Pt[] = [
      [0, 0],
      [10, 1],
      [20, 0],
      [10, -1],
    ];
    const a = principalAxisAngle(pts);
    expect(Number.isFinite(a)).toBe(true);
  });

  it('transformPoint 应用相似变换（旋转+缩放+平移）', () => {
    const t = { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 };
    const p = transformPoint([0, 0], t);
    expect(p[0]).toBeCloseTo(440000);
    expect(p[1]).toBeCloseTo(4100000);
    const q = transformPoint([1000, 0], t);
    expect(q[0]).toBeCloseTo(440001);
  });

  it('fitTransform 保持纵横比并居中', () => {
    const b = bounds(square);
    const t = fitTransform(b, 200, 200, 0);
    expect(t.scale).toBeCloseTo(20);
    expect(t.offsetX).toBeCloseTo(0);
  });
});
