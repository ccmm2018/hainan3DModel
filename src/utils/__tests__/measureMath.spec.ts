import { describe, it, expect } from 'vitest';
import { haversineDistance, polygonArea } from '../measureMath';

/**
 * 测距 / 测面算法基准回归测试（s504）。
 * 用「已知经纬度 → 已知真实距离/面积」对照，锁住 MapScene 首页量算的精度。
 * 理论值来源：WGS84 —— 纬度 1° ≈ 110574m；经度 1° ≈ 111320m×cos(纬度)。
 */
const CENTER: [number, number] = [110.280328, 19.75491]; // 校园中心
const RAD = Math.PI / 180;

describe('haversineDistance - 测距', () => {
  it('纬度方向 0.001° ≈ 110.574m（误差 <1%）', () => {
    const d = haversineDistance(CENTER, [CENTER[0], CENTER[1] + 0.001]);
    const theory = 0.001 * 110574;
    expect(d).toBeGreaterThan(theory * 0.99);
    expect(d).toBeLessThan(theory * 1.01);
  });

  it('经度方向 0.001° ≈ 111320m×cos(lat)（误差 <1%）', () => {
    const d = haversineDistance(CENTER, [CENTER[0] + 0.001, CENTER[1]]);
    const theory = 0.001 * 111320 * Math.cos(CENTER[1] * RAD);
    expect(d).toBeGreaterThan(theory * 0.99);
    expect(d).toBeLessThan(theory * 1.01);
  });

  it('构造的 100m 直线，实测落在 99~101m', () => {
    // 步长用椭球理论值 110574m/° 反推，算法用球面 111319m/°，
    // 固有偏差约 0.67%（实测 ≈100.67m），故容差取 1%
    const latStep = 100 / 110574;
    const d = haversineDistance([110.28, 19.75], [110.28, 19.75 + latStep]);
    expect(d).toBeGreaterThan(99);
    expect(d).toBeLessThan(101);
  });

  it('同点距离为 0，且 A→B 与 B→A 相等', () => {
    expect(haversineDistance(CENTER, CENTER)).toBe(0);
    const other: [number, number] = [110.29, 19.76];
    expect(haversineDistance(CENTER, other)).toBeCloseTo(haversineDistance(other, CENTER), 6);
  });
});

describe('polygonArea - 测面', () => {
  it('理论 100m×100m 正方形，实测落在 9900~10100㎡', () => {
    const lngStep = 100 / (111320 * Math.cos(CENTER[1] * RAD));
    const latStep = 100 / 110574;
    const ring: [number, number][] = [
      [CENTER[0], CENTER[1]],
      [CENTER[0] + lngStep, CENTER[1]],
      [CENTER[0] + lngStep, CENTER[1] + latStep],
      [CENTER[0], CENTER[1] + latStep],
      [CENTER[0], CENTER[1]],
    ];
    const a = polygonArea(ring);
    expect(a).toBeGreaterThan(9900);
    expect(a).toBeLessThan(10100);
  });

  it('0.001°×0.001° 矩形面积与理论值误差 <1%', () => {
    const ring: [number, number][] = [
      [CENTER[0], CENTER[1]],
      [CENTER[0] + 0.001, CENTER[1]],
      [CENTER[0] + 0.001, CENTER[1] + 0.001],
      [CENTER[0], CENTER[1] + 0.001],
      [CENTER[0], CENTER[1]],
    ];
    const theory =
      (0.001 * 111320 * Math.cos(CENTER[1] * RAD)) * (0.001 * 110574);
    const a = polygonArea(ring);
    expect(a).toBeGreaterThan(theory * 0.99);
    expect(a).toBeLessThan(theory * 1.01);
  });

  it('未闭合的点序也能自动闭合，面积与显式闭合一致', () => {
    const ring: [number, number][] = [
      [CENTER[0], CENTER[1]],
      [CENTER[0] + 0.001, CENTER[1]],
      [CENTER[0] + 0.001, CENTER[1] + 0.001],
      [CENTER[0], CENTER[1] + 0.001],
    ];
    const opened = polygonArea(ring);
    const closed = polygonArea([...ring, ring[0]]);
    expect(opened).toBeCloseTo(closed, 6);
  });

  it('点数不足 3 个返回 0', () => {
    expect(polygonArea([])).toBe(0);
    expect(polygonArea([[110, 20], [111, 21]])).toBe(0);
  });
});
