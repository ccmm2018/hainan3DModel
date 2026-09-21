import { describe, expect, it } from 'vitest';
import {
  applyTransform,
  buildDefaultTransform,
  computeFloorOutline,
  decodeDxf,
  detectCoordSource,
  estimateFingerprint,
  inferUnit,
} from '../coordinate';
import type { BBox, FloorTransform } from '../../types/cad';
import type { Pt } from '../geometry';

describe('coordinate', () => {
  it('detectCoordSource 按坐标量级判断', () => {
    expect(detectCoordSource([[440000, 4100000]] as Pt[])).toBe('utm');
    expect(detectCoordSource([[0, 0], [5000, 4000]] as Pt[])).toBe('local');
  });

  it('inferUnit 处理 $INSUNITS 与跨度启发式', () => {
    const m = (maxX: number, maxY = maxX): BBox => ({ minX: 0, minY: 0, maxX, maxY });
    // $INSUNITS 优先
    expect(inferUnit({ '$INSUNITS': '6' }, m(11))).toBe('m');
    expect(inferUnit({ '$INSUNITS': '4' }, m(11))).toBe('mm');
    // 缺失：跨度 10~2000 → m；10000~200000 → mm；其余 unknown
    expect(inferUnit({}, m(50))).toBe('m');
    expect(inferUnit({}, m(50000))).toBe('mm');
    expect(inferUnit({}, m(5000))).toBe('unknown');
    expect(inferUnit({}, m(0))).toBe('unknown');
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

  it('applyTransform 实现 scale·R·p + offset', () => {
    const t: FloorTransform = { offset: [10, 20], rotation: 0, scale: 2 };
    expect(applyTransform([3, 4], t)).toEqual([16, 28]);
    // 旋转 90°：R·[1,0] = [0,1]
    const r: FloorTransform = { offset: [0, 0], rotation: Math.PI / 2, scale: 1 };
    const out = applyTransform([1, 0], r);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(1);
  });

  it('decodeDxf 自动识别 UTF-8 与 UTF-16LE BOM', async () => {
    const u8 = new TextEncoder().encode('hello楼');
    expect(await decodeDxf(u8.buffer)).toBe('hello楼');
    // UTF-16LE BOM FF FE + "hi"
    const u16 = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    expect(await decodeDxf(u16.buffer)).toBe('hi');
  });
});
