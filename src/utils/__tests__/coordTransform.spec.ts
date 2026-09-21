import { describe, expect, it } from 'vitest';
import proj4 from 'proj4';
import { utm49nToWgs84, utm49nToGcj02, wgs84ToGcj02, bboxUtm49nCenterToGcj02 } from '../coordTransform';

describe('UTM Zone 49N 坐标转换', () => {
  it('UTM49N ↔ WGS84 往返一致（米 → 经纬度 → 米）', () => {
    const lng = 110.15;
    const lat = 20.05;
    const [e, n] = proj4('EPSG:4326', 'UTM49N', [lng, lat]) as [number, number];
    const [bl, ba] = utm49nToWgs84(e, n);
    expect(bl).toBeCloseTo(lng, 4);
    expect(ba).toBeCloseTo(lat, 4);
  });

  it('UTM49N → GCJ-02 与 WGS84 → GCJ-02 一致', () => {
    const e = 440000;
    const n = 4100000;
    const [lng, lat] = utm49nToWgs84(e, n);
    const [gl1, ga1] = utm49nToGcj02(e, n);
    const [gl2, ga2] = wgs84ToGcj02(lng, lat);
    expect(gl1).toBeCloseTo(gl2, 6);
    expect(ga1).toBeCloseTo(ga2, 6);
  });

  it('bbox 中心点转换（海南海口附近的 UTM 坐标 → GCJ-02 仍在海南）', () => {
    const [e, n] = proj4('EPSG:4326', 'UTM49N', [110.2, 20.0]) as [number, number];
    const [lng, lat] = bboxUtm49nCenterToGcj02({ minX: e, minY: n, maxX: e, maxY: n });
    const [wgl, wga] = wgs84ToGcj02(110.2, 20.0);
    expect(lng).toBeCloseTo(wgl, 5);
    expect(lat).toBeCloseTo(wga, 5);
    expect(lng).toBeGreaterThan(109);
    expect(lng).toBeLessThan(111);
    expect(lat).toBeGreaterThan(19);
    expect(lat).toBeLessThan(21);
  });
});
