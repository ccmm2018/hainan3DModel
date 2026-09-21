import { describe, expect, it } from 'vitest';
import {
  buildDefaultTransform,
  computeFloorOutline,
  detectCoordSource,
  detectUnit,
  estimateFingerprint,
} from '../coordinate';
import type { Pt } from '../geometry';

describe('coordinate', () => {
  it('detectCoordSource 按坐标量级判断', () => {
    expect(detectCoordSource([[440000, 4100000]] as Pt[])).toBe('utm');
    expect(detectCoordSource([[0, 0], [5000, 4000]] as Pt[])).toBe('local');
  });

  it('detectUnit 处理 $INSUNITS 与跨度启发式', () => {
    expect(detectUnit(4, 11000)).toBe('mm');
    expect(detectUnit(6, 100)).toBe('m');
    expect(detectUnit(undefined, 50)).toBe('m');
    expect(detectUnit(undefined, 5000)).toBe('mm');
    expect(detectUnit(undefined, 0)).toBe('unknown');
  });

  it('buildDefaultTransform local+mm → scale 0.001', () => {
    const t = buildDefaultTransform('local', 'mm');
    expect(t.scale).toBeCloseTo(0.001);
    expect(t.rotation).toBe(0);
  });

  it('estimateFingerprint 从 UTM 顶点估算楼栋指纹', () => {
    const pts: Pt[] = [
      [440000, 4100000],
      [440100, 4100000],
      [440100, 4100100],
      [440000, 4100100],
    ];
    const fp = estimateFingerprint(pts);
    expect(fp.centerUtm).toBeDefined();
    expect(fp.centerUtm![0]).toBeCloseTo(440050);
    expect(fp.centerUtm![1]).toBeCloseTo(4100050);
    expect(fp.footprintArea).toBeCloseTo(10000);
    expect(typeof fp.azimuth).toBe('number');
  });

  it('computeFloorOutline 由房间顶点求凸包', () => {
    const polys: Pt[][] = [
      [[440000, 4100000], [440100, 4100000], [440100, 4100100], [440000, 4100100]],
    ];
    const t = buildDefaultTransform('utm', 'm');
    const outline = computeFloorOutline(polys, t);
    expect(outline.length).toBe(4);
  });
});
