import { describe, expect, it } from 'vitest';
import {
  fuzzyMatchBuilding,
  matchLabels,
  readBuildingFingerprint,
  angleDiffDeg,
  matchBuildings,
} from '../matcher';
import type { Pt } from '../geometry';
import type { BuildingDataMap, BuildingProps } from '../../data/buildingData';

describe('matcher', () => {
  it('matchLabels 命中房间内文字，远处文字返回 null', () => {
    const rooms = [
      { polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] as Pt[], centroid: [5, 5] as Pt },
      { polygon: [[100, 100], [110, 100], [110, 110], [100, 110]] as Pt[], centroid: [105, 105] as Pt },
    ];
    const texts = [
      { pos: [5, 5] as Pt, text: '101' },
      { pos: [500, 500] as Pt, text: '孤立文字' },
    ];
    const res = matchLabels(rooms, texts);
    expect(res[0]).toBe('101');
    expect(res[1]).toBeNull();
  });

  it('fuzzyMatchBuilding 支持精确 / 大小写 / 包含匹配', () => {
    const candidates = ['实验楼', '教学楼', '图书馆'];
    expect(fuzzyMatchBuilding('教学楼', candidates)).toBe('教学楼');
    expect(fuzzyMatchBuilding('教学', candidates)).toBe('教学楼');
    expect(fuzzyMatchBuilding('教', candidates)).toBe('教学楼');
    expect(fuzzyMatchBuilding('不存在', candidates)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 楼栋匹配：指纹（中心 / 面积 / 方位）三维几何比对
// ---------------------------------------------------------------------------
function bld(name: string, c: [number, number], area: number, az: number): BuildingProps {
  return { name, centerUtm: c, footprintArea: area, azimuth: az };
}

const FP = { centerUtm: [440000, 4100000] as [number, number], area: 1000, azimuth: 90 };

describe('matcher - 楼栋匹配', () => {
  it('angleDiffDeg 处理环绕（350° 与 10° 差 20°）', () => {
    expect(angleDiffDeg(350, 10)).toBeCloseTo(20);
    expect(angleDiffDeg(90, 92)).toBeCloseTo(2);
    expect(angleDiffDeg(0, 180)).toBeCloseTo(180);
  });

  it('readBuildingFingerprint 字段齐全返回指纹，缺字段返回 null', () => {
    expect(readBuildingFingerprint(bld('A', [1, 2], 100, 30))).toEqual({
      centerUtm: [1, 2],
      area: 100,
      azimuth: 30,
    });
    expect(readBuildingFingerprint({ name: 'B' })).toBeNull();
    expect(readBuildingFingerprint({ name: 'C', centerUtm: [1, 2] })).toBeNull();
  });

  it('strong：三项全满足且唯一候选', () => {
    const buildings: BuildingDataMap = {
      A: bld('A', [440000, 4100000], 1000, 90),
      B: bld('B', [450000, 4100000], 5000, 10),
    };
    const r = matchBuildings(FP, buildings);
    expect(r.status).toBe('strong');
    expect(r.candidates).toEqual(['A']);
  });

  it('weak：仅满足 1~2 项', () => {
    // 中心 OK、方位 OK，但面积差 33%（>10% 不合格）
    const buildings: BuildingDataMap = { A: bld('A', [440000, 4100000], 1500, 90) };
    const r = matchBuildings(FP, buildings);
    expect(r.status).toBe('weak');
    expect(r.candidates).toEqual(['A']);
  });

  it('weak：多个楼栋同时满足三项', () => {
    const buildings: BuildingDataMap = {
      A: bld('A', [440000, 4100000], 1000, 90),
      B: bld('B', [440010, 4100005], 1005, 91),
    };
    const r = matchBuildings(FP, buildings);
    expect(r.status).toBe('weak');
    expect(r.candidates.slice().sort()).toEqual(['A', 'B']);
  });

  it('none ①：中心距离 >10000m（可能非 UTM）', () => {
    const buildings: BuildingDataMap = {
      A: bld('A', [460000, 4100000], 5000, 130), // 中心差 20000，面积差大，方位差大
    };
    const r = matchBuildings(FP, buildings);
    expect(r.status).toBe('none');
    expect(r.candidates).toHaveLength(0);
    expect(r.reasons[0]).toContain('坐标系可能不是 UTM');
  });

  it('none ②：面积差异 >50%', () => {
    // 中心 5000m（>50 不合格但 ≤10000），面积差 60%，方位 40°
    const buildings: BuildingDataMap = { A: bld('A', [445000, 4100000], 2600, 130) };
    const r = matchBuildings(FP, buildings);
    expect(r.status).toBe('none');
    expect(r.reasons[0]).toContain('可能画错');
  });

  it('none ③：方位角差异 >30°', () => {
    // 中心 5000m，面积差 30%（>10 不OK ≤50），方位 40°
    const buildings: BuildingDataMap = { A: bld('A', [445000, 4100000], 1300, 130) };
    const r = matchBuildings(FP, buildings);
    expect(r.status).toBe('none');
    expect(r.reasons[0]).toContain('方位角');
  });

  it('none ④：均未满足且不属于①②③', () => {
    // 中心 5000m（>50 不OK ≤10000），面积差 13%（>10 不OK ≤50），方位 10°（>5 ≤30）
    const buildings: BuildingDataMap = { A: bld('A', [445000, 4100000], 1150, 100) };
    const r = matchBuildings(FP, buildings);
    expect(r.status).toBe('none');
    expect(r.reasons[0]).toContain('手动指定');
  });

  it('none：所有楼栋都未录入指纹', () => {
    const buildings: BuildingDataMap = { A: { name: 'A' }, B: { name: 'B', height: 30 } };
    const r = matchBuildings(FP, buildings);
    expect(r.status).toBe('none');
    expect(r.reasons[0]).toContain('尚未录入指纹');
  });

  it('房间闭合轮廓不参与匹配（仅用楼层外轮廓指纹）', () => {
    const buildings: BuildingDataMap = { A: bld('A', [440000, 4100000], 1000, 90) };
    const r = matchBuildings(FP, buildings);
    expect(r.status).toBe('strong');
  });
});
