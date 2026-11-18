/**
 * measureMath —— 首页测距 / 测面的核心算法（纯函数，无地图/Three 依赖）
 *
 * 从 MapScene 抽出，目的是让这两个决定「量得准不准」的公式可以被单元测试
 * 用已知经纬度基准直接锁住，避免算法被改动后无人察觉。
 *
 * 坐标均为 GCJ-02 经纬度 [lng, lat]，输出为米 / 平方米。
 */
import area from '@turf/area';

export type LngLat = [number, number];

/**
 * 两点间测地距离（米）——Haversine 球面公式。
 * 自包含实现，不依赖 AMap 不存在的 map.getDistance。
 * 球面模型相对地球椭球有约 0.5% 固有偏差，校园尺度（几十至几百米）可忽略。
 */
export function haversineDistance(a: LngLat, b: LngLat): number {
  const R = 6378137; // 地球半径（米）
  const rad = Math.PI / 180;
  const lat1 = a[1] * rad;
  const lat2 = b[1] * rad;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * 经纬度环围成的球面多边形面积（平方米）。
 * ring 首尾相同与否均可（未闭合时自动补首点）。点数不足 3 个返回 0。
 * 底层用 @turf/area（业界标准测地面积算法）。
 */
export function polygonArea(ring: LngLat[]): number {
  if (ring.length < 3) return 0;
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closed =
    first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
  return area({ type: 'Polygon', coordinates: [closed] }) as number;
}
