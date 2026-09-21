import { describe, expect, it } from 'vitest';
import {
  bounds,
  convexHull,
  fitTransform,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  principalAxisAngle,
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

  it('polygonCentroid 返回质心', () => {
    const c = polygonCentroid(square);
    expect(c[0]).toBeCloseTo(5);
    expect(c[1]).toBeCloseTo(5);
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
