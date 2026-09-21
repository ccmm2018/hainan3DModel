/**
 * 坐标转换工具
 *
 * 目标：让「QGIS 导出的地理数据 / GLB 模型」能够正确对齐到「高德底图」。
 *
 * 关键背景：
 * 1. 高德地图 JS API 2.0 的底图使用 GCJ-02 坐标系（火星坐标）。
 * 2. QGIS / 标准地理数据通常使用 WGS84（EPSG:4326）或 Web Mercator（EPSG:3857）。
 * 3. 若直接把 WGS84 经纬度当作 GCJ-02 使用，会产生约几十～几百米的偏移。
 *
 * 完整坐标管线：
 *   WGS84 (lng,lat)
 *     └─ wgs84ToGcj02 ──> GCJ-02 (lng,lat)        ← 供高德地图使用
 *     └─ epsg4326To3857 ─> EPSG:3857 (x,y 米)     ← Web Mercator 米制坐标
 *     └─ 相减锚点 ───────> Three.js 局部坐标 (dx,dy 米)  ← 放置 GLB 模型
 *
 * 注：WGS84→GCJ-02 的核心算法集中在 coordinate.ts（CAD 模块与地图模块共用单一实现），
 *     本文件仅做 re-export 并补充 proj4 相关的 UTM49N / Web Mercator 转换。
 */

import proj4 from 'proj4';
import { wgs84ToGcj02 } from './coordinate';

export { wgs84ToGcj02 };

// ---------------------------------------------------------------------------
// proj4 投影定义
// ---------------------------------------------------------------------------
proj4.defs(
  'EPSG:3857',
  '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
);
proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs');
// UTM Zone 49N（WGS84 基准，单位米）—— 本项目 DXF 理想坐标
proj4.defs(
  'UTM49N',
  '+proj=utm +zone=49 +datum=WGS84 +units=m +no_defs',
);

export const WGS84 = 'EPSG:4326';
export const WEB_MERCATOR = 'EPSG:3857';
export const UTM_49N = 'UTM49N';

// ---------------------------------------------------------------------------
// GCJ-02 互转
// ---------------------------------------------------------------------------

/** GCJ-02 经纬度 → WGS84 经纬度 */
export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return [lng, lat];
  const [wlng, wlat] = wgs84ToGcj02(lng, lat);
  return [lng * 2 - wlng, lat * 2 - wlat];
}

/** GCJ-02 经纬度（高德）→ UTM Zone 49N（米）。用于把地图上点选的锚点换算回图纸配准坐标。 */
export function gcj02ToUtm49n(lng: number, lat: number): [number, number] {
  const [wlng, wlat] = gcj02ToWgs84(lng, lat);
  return proj4(WGS84, UTM_49N, [wlng, wlat]);
}

// ---------------------------------------------------------------------------
// EPSG:4326 (WGS84) <-> EPSG:3857 (Web Mercator 米)
// ---------------------------------------------------------------------------

/** WGS84 经纬度 → Web Mercator 米制坐标 [x, y] */
export function epsg4326To3857(lng: number, lat: number): [number, number] {
  const [x, y] = proj4(WGS84, WEB_MERCATOR, [lng, lat]);
  return [x, y];
}

/** Web Mercator 米制坐标 [x, y] → WGS84 经纬度 */
export function epsg3857To4326(x: number, y: number): [number, number] {
  const [lng, lat] = proj4(WEB_MERCATOR, WGS84, [x, y]);
  return [lng, lat];
}

// ---------------------------------------------------------------------------
// 高层组合管线
// ---------------------------------------------------------------------------

/**
 * 将 EPSG:3857 绝对坐标转换为「相对锚点的 Three.js 局部坐标」（米）。
 *
 * 用法：QGIS 数据导出为 EPSG:3857（Web Mercator 米制）后，
 * 用锚点（WGS84 经纬度）作为原点，计算相对偏移，得到可直接用于
 * Three.js 场景的局部米制坐标。
 *
 * @param x EPSG:3857 的 x（米）
 * @param y EPSG:3857 的 y（米）
 * @param anchorWgs84 锚点 WGS84 [lng, lat]
 * @returns 相对锚点的局部坐标 [dx, dy]（米）
 */
export function epsg3857ToLocal(
  x: number,
  y: number,
  anchorWgs84: [number, number],
): [number, number] {
  const [ax, ay] = epsg4326To3857(anchorWgs84[0], anchorWgs84[1]);
  return [x - ax, y - ay];
}

/**
 * 完整管线：WGS84 经纬度 → GCJ-02 → （可选）Web Mercator。
 * 返回 GCJ-02 经纬度（供高德地图使用）。
 */
export function wgs84ToGcj02Full(lng: number, lat: number): [number, number] {
  return wgs84ToGcj02(lng, lat);
}

/**
 * 计算 WGS84 → GCJ-02 的偏移量（米），用于验证/调试对齐精度。
 */
export function wgs84Gcj02Offset(lng: number, lat: number): { dlng: number; dlat: number; meters: number } {
  const [glng, glat] = wgs84ToGcj02(lng, lat);
  const dlng = glng - lng;
  const dlat = glat - lat;
  // 粗略换算成米（1° 经度 ≈ 111320m × cos(lat)，1° 纬度 ≈ 110540m）
  const meters = Math.sqrt(
    Math.pow(dlng * 111320 * Math.cos((lat * Math.PI) / 180), 2) +
      Math.pow(dlat * 110540, 2),
  );
  return { dlng, dlat, meters };
}

/**
 * 将 GeoJSON（FeatureCollection / Feature / Geometry）中的坐标
 * 从 WGS84 统一转换为 GCJ-02（高德坐标系），使外部地理数据（QGIS 导出等）
 * 能与高德底图正确对齐。
 *
 * - 递归处理 Point / LineString / Polygon / Multi* 以及 GeometryCollection。
 * - 返回新的 GeoJSON 对象，不修改入参。
 * - 约定：本项目「数据源为 WGS84」，统一在此处转换为 GCJ-02；
 *   若数据源本身已是 GCJ-02，请勿重复转换。
 */
export function normalizeGeoJSONToGcj02(geojson: unknown): unknown {
  if (!geojson || typeof geojson !== 'object') return geojson;
  const clone = JSON.parse(JSON.stringify(geojson));

  const transformCoords = (coords: unknown): unknown => {
    // 叶子节点：[lng, lat] 或 [lng, lat, z]
    if (Array.isArray(coords) && typeof coords[0] === 'number') {
      const [lng, lat, ...rest] = coords as number[];
      const [glng, glat] = wgs84ToGcj02(lng, lat);
      return [glng, glat, ...rest];
    }
    if (Array.isArray(coords)) return coords.map((c) => transformCoords(c));
    return coords;
  };

  const walk = (obj: Record<string, unknown>): void => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.type === 'FeatureCollection' && Array.isArray(obj.features)) {
      obj.features.forEach((f) => walk(f as Record<string, unknown>));
    } else if (obj.type === 'Feature') {
      walk(obj.geometry as Record<string, unknown>);
    } else if (obj.type === 'GeometryCollection' && Array.isArray(obj.geometries)) {
      obj.geometries.forEach((g) => walk(g as Record<string, unknown>));
    } else if (obj.coordinates) {
      obj.coordinates = transformCoords(obj.coordinates) as unknown;
    }
  };

  walk(clone as Record<string, unknown>);
  return clone;
}

// ---------------------------------------------------------------------------
// UTM Zone 49N（WGS84，米）→ WGS84 经纬度 → GCJ-02（高德坐标系）
// 本项目 DXF 理想坐标：GCS_WGS_1984 + UTM Zone 49N，单位米，1:1，真实方位。
// 渲染定位到高德底图时，需经 WGS84 → GCJ-02 转换。
// ---------------------------------------------------------------------------

/** UTM Zone 49N 东向 / 北向（米）→ WGS84 经纬度 [lng, lat] */
export function utm49nToWgs84(easting: number, northing: number): [number, number] {
  const [lng, lat] = proj4(UTM_49N, WGS84, [easting, northing]);
  return [lng, lat];
}

/** UTM Zone 49N（米）→ GCJ-02 经纬度（高德坐标系） */
export function utm49nToGcj02(easting: number, northing: number): [number, number] {
  const [lng, lat] = utm49nToWgs84(easting, northing);
  return wgs84ToGcj02(lng, lat);
}

/** 由 UTM 包围盒中心点（米）换算 GCJ-02 经纬度 */
export function bboxUtm49nCenterToGcj02(bbox: {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}): [number, number] {
  return utm49nToGcj02((bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2);
}
