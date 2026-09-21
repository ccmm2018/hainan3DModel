import { describe, expect, it } from 'vitest';
import {
  applyTransform,
  polygonAreaDiffRatio,
  solveSimilarityTransform,
} from '../coordinate';
import type { FloorTransform } from '../../types/cad';
import type { Pt } from '../geometry';

describe('solveSimilarityTransform', () => {
  it('由 2 对同名锚点还原已知变换', () => {
    const t: FloorTransform = { offset: [123.4, 567.8], rotation: 0.37, scale: 0.42 };
    const local: [Pt, Pt] = [
      [0, 0],
      [10, 5],
    ];
    const utm: [Pt, Pt] = [applyTransform(local[0], t), applyTransform(local[1], t)];
    const r = solveSimilarityTransform(local, utm);
    expect(r.offset[0]).toBeCloseTo(t.offset[0], 6);
    expect(r.offset[1]).toBeCloseTo(t.offset[1], 6);
    expect(r.rotation).toBeCloseTo(t.rotation, 6);
    expect(r.scale).toBeCloseTo(t.scale, 6);
  });

  it('旋转 0、缩放 1 时退化为平移', () => {
    const t: FloorTransform = { offset: [5000, 4100000], rotation: 0, scale: 1 };
    const local: [Pt, Pt] = [
      [100, 200],
      [300, 400],
    ];
    const utm: [Pt, Pt] = [applyTransform(local[0], t), applyTransform(local[1], t)];
    const r = solveSimilarityTransform(local, utm);
    expect(r.scale).toBeCloseTo(1, 6);
    expect(r.rotation).toBeCloseTo(0, 6);
    expect(r.offset[0]).toBeCloseTo(5000, 6);
    expect(r.offset[1]).toBeCloseTo(4100000, 6);
  });

  it('local 两点重合时退化为仅平移', () => {
    const local: [Pt, Pt] = [
      [3, 3],
      [3, 3],
    ];
    const utm: [Pt, Pt] = [
      [100, 200],
      [100, 200],
    ];
    const r = solveSimilarityTransform(local, utm);
    expect(r.scale).toBe(1);
    expect(r.rotation).toBe(0);
    expect(r.offset[0]).toBeCloseTo(97, 6);
    expect(r.offset[1]).toBeCloseTo(197, 6);
  });

  it('不足 2 对锚点抛错', () => {
    expect(() =>
      solveSimilarityTransform([] as unknown as [Pt, Pt], [] as unknown as [Pt, Pt]),
    ).toThrow();
  });
});

describe('polygonAreaDiffRatio', () => {
  it('相同多边形偏差为 0', () => {
    const sq: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(polygonAreaDiffRatio(sq, sq)).toBeCloseTo(0);
  });

  it('面积翻倍时偏差约 0.5', () => {
    const a: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const b: Pt[] = [
      [0, 0],
      [14.142, 0],
      [14.142, 14.142],
      [0, 14.142],
    ]; // 面积 200
    expect(polygonAreaDiffRatio(a, b)).toBeCloseTo(0.5, 4);
  });

  it('偏差 >0.2 判定（用于红色警告阈值校验）', () => {
    const a: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const b: Pt[] = [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ]; // 偏差 (400-100)/400 = 0.75
    expect(polygonAreaDiffRatio(a, b)).toBeGreaterThan(0.2);
  });
});
