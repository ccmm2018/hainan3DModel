import { describe, it, expect } from 'vitest';
import {
  polygonArea,
  centroid,
  pointInPolygon,
  classifyRing,
  azimuth,
  type Pt,
} from '../geometry';

describe('面积与质心（已知几何）', () => {
  it('矩形 4×3 → 面积 12，质心 (2, 1.5)', () => {
    const rect: Pt[] = [[0, 0], [4, 0], [4, 3], [0, 3]];
    expect(polygonArea(rect)).toBeCloseTo(12, 6);
    const c = centroid(rect);
    expect(c[0]).toBeCloseTo(2, 6);
    expect(c[1]).toBeCloseTo(1.5, 6);
  });

  it('单位正方形 → 面积 1，质心 (0.5, 0.5)', () => {
    const sq: Pt[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(polygonArea(sq)).toBeCloseTo(1, 6);
    const c = centroid(sq);
    expect(c[0]).toBeCloseTo(0.5, 6);
    expect(c[1]).toBeCloseTo(0.5, 6);
  });

  it('三角形 (0,0)(2,0)(0,2) → 面积 2，质心 (2/3, 2/3)', () => {
    const tri: Pt[] = [[0, 0], [2, 0], [0, 2]];
    expect(polygonArea(tri)).toBeCloseTo(2, 6);
    const c = centroid(tri);
    expect(c[0]).toBeCloseTo(2 / 3, 6);
    expect(c[1]).toBeCloseTo(2 / 3, 6);
  });
});

describe('射线法点内外判定', () => {
  const sq: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];

  it('内部点判定为真', () => {
    expect(pointInPolygon([5, 5], sq)).toBe(true);
  });

  it('外部点判定为假', () => {
    expect(pointInPolygon([15, 5], sq)).toBe(false);
  });

  it('凹形（L 形）缺口内的点判定为假，实体内为真', () => {
    // L 形：实体为 x∈[0,6]、y∈[0,2] 的底条 + x∈[0,2]、y∈[2,6] 的左条；
    // 缺口位于 x∈[2,6]、y∈[2,6]（取 (4,4) 应落在缺口 → 外部）。
    const lShape: Pt[] = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]];
    expect(pointInPolygon([4, 4], lShape)).toBe(false);
    expect(pointInPolygon([1, 1], lShape)).toBe(true);
  });
});

describe('闭合三选一判定 (classifyRing)', () => {
  it('闭合环（首末重合）→ closed', () => {
    const ring: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    expect(classifyRing(ring)).toBe('closed');
  });

  it('开放环（首末不重合）→ open', () => {
    const open: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(classifyRing(open)).toBe('open');
  });

  it('自交环（蝴蝶结）→ self-intersect', () => {
    const bowtie: Pt[] = [[0, 0], [10, 10], [10, 0], [0, 10]];
    expect(classifyRing(bowtie)).toBe('self-intersect');
  });
});

describe('方位角 (azimuth)', () => {
  // 关键：环内「最长边」方向决定方位角，约定正北=0°、顺时针（atan2(dx, dy)）。
  it('最长边朝北 → 0°', () => {
    const p: Pt[] = [[0, 10], [3, 10], [3, 5], [1, 5], [1, 0], [0, 0]];
    expect(azimuth(p)).toBeCloseTo(0, 6);
  });

  it('最长边朝东 → 90°', () => {
    const p: Pt[] = [[0, 0], [10, 0], [10, 1], [1, 1], [1, 5], [0, 5]];
    expect(azimuth(p)).toBeCloseTo(90, 6);
  });

  it('最长边朝南 → 180°', () => {
    const p: Pt[] = [[0, 0], [1, 0], [1, 5], [3, 5], [3, 10], [0, 10]];
    expect(azimuth(p)).toBeCloseTo(180, 6);
  });

  it('最长边朝西 → 270°', () => {
    const p: Pt[] = [[0, 0], [1, 0], [1, 9], [10, 9], [10, 1], [0, 1]];
    expect(azimuth(p)).toBeCloseTo(270, 6);
  });
});
