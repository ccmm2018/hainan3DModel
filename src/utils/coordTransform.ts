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
 */

import proj4 from 'proj4';

// ---------------------------------------------------------------------------
// proj4 投影定义
// ---------------------------------------------------------------------------
proj4.defs(
  'EPSG:3857',
  '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
);
proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs');

export const WGS84 = 'EPSG:4326';
export const WEB_MERCATOR = 'EPSG:3857';

// ---------------------------------------------------------------------------
// WGS84 <-> GCJ-02（火星坐标）转换
// 标准算法，参考 GCJ-02 偏移模型
// ---------------------------------------------------------------------------
const PI = Math.PI;
const A = 6378245.0; // 长半轴
const EE = 0.00669342162296594323; // 偏心率平方

function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320.0 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret =
    300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/** WGS84 经纬度 → GCJ-02 经纬度（高德坐标系） */
export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}

/** GCJ-02 经纬度 → WGS84 经纬度 */
export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat];
  const [wlng, wlat] = wgs84ToGcj02(lng, lat);
  return [lng * 2 - wlng, lat * 2 - wlat];
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
    Math.pow(dlng * 111320 * Math.cos((lat * PI) / 180), 2) +
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
export function normalizeGeoJSONToGcj02(geojson: any): any {
  if (!geojson || typeof geojson !== 'object') return geojson;
  const clone = JSON.parse(JSON.stringify(geojson));

  const transformCoords = (coords: any): any => {
    // 叶子节点：[lng, lat] 或 [lng, lat, z]
    if (Array.isArray(coords) && typeof coords[0] === 'number') {
      const [lng, lat, ...rest] = coords as number[];
      const [glng, glat] = wgs84ToGcj02(lng, lat);
      return [glng, glat, ...rest];
    }
    if (Array.isArray(coords)) return coords.map((c) => transformCoords(c));
    return coords;
  };

  const walk = (obj: any): void => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.type === 'FeatureCollection' && Array.isArray(obj.features)) {
      obj.features.forEach(walk);
    } else if (obj.type === 'Feature') {
      walk(obj.geometry);
    } else if (obj.type === 'GeometryCollection' && Array.isArray(obj.geometries)) {
      obj.geometries.forEach(walk);
    } else if (obj.coordinates) {
      obj.coordinates = transformCoords(obj.coordinates);
    }
  };

  walk(clone);
  return clone;
}
