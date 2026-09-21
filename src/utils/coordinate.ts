/**
 * 坐标来源 / 单位推断、相似变换、楼栋指纹估算。
 * 不使用 any。
 */

import type {
  BBox,
  BuildingFingerprint,
  CoordSource,
  FloorTransform,
  LengthUnit,
} from '../types/cad';
import {
  areaScale,
  bounds,
  convexHull,
  polygonArea,
  polygonCentroid,
  principalAxisAngle,
  transformPolygon,
  type Pt,
} from './geometry';

/**
 * 自动推断坐标来源。
 * 优先用单位判断：毫米 / 厘米图纸必然是局部坐标（local）。
 * 米制或未知时，按坐标量级判断：UTM 49N 东向约 2e5–9e5、北向约 3e6–4.6e6，
 * 命中该签名即视为 UTM；否则绝对值大于 1e5 也判 UTM，再否则为局部坐标。
 * （具体阈值与例外以「坐标」兼容规则为准，此处为默认启发式。）
 */
export function detectCoordSource(points: Pt[], unit: LengthUnit = 'unknown'): CoordSource {
  if (unit === 'mm' || unit === 'cm') return 'local';
  let maxAbs = 0;
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const [x, y] of points) {
    maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y));
    minE = Math.min(minE, x);
    maxE = Math.max(maxE, x);
    minN = Math.min(minN, y);
    maxN = Math.max(maxN, y);
  }
  const inUtm49N =
    minE > 1.5e5 && maxE < 1e6 && minN > 2.5e6 && maxN < 5e6;
  if (inUtm49N) return 'utm';
  return maxAbs > 1e5 ? 'utm' : 'local';
}

/**
 * 推断长度单位。
 * 优先用 DXF $INSUNITS：6=米，4=毫米，5=厘米，2=英尺，1=英寸。
 * 缺失时按坐标跨度启发式：跨度 > 1000 视为毫米图纸，否则视为米。
 */
export function detectUnit(insUnits: number | undefined, span: number): LengthUnit {
  switch (insUnits) {
    case 6:
      return 'm';
    case 4:
      return 'mm';
    case 5:
      return 'cm';
    case 1:
    case 2:
      // 英制：按英尺近似，统一以米为基准缩放（1 英尺 ≈ 0.3048 m）
      return 'm';
    default:
      break;
  }
  if (span > 1000) return 'mm';
  if (span <= 0 || !isFinite(span)) return 'unknown';
  return 'm';
}

/** 把单位换算为「米」的缩放系数 */
export function unitToScale(unit: LengthUnit): number {
  switch (unit) {
    case 'mm':
      return 0.001;
    case 'cm':
      return 0.01;
    case 'm':
      return 1;
    default:
      return 1;
  }
}

/** 依据坐标来源与单位构造默认相似变换（local+mm → 0.001，utm → 1） */
export function buildDefaultTransform(coordSource: CoordSource, unit: LengthUnit): FloorTransform {
  const scale = coordSource === 'utm' ? 1 : unitToScale(unit);
  return { offset: [0, 0], rotation: 0, scale };
}

/** 由全部房间顶点估算楼栋指纹（输入点须为 UTM 米） */
export function estimateFingerprint(points: Pt[]): BuildingFingerprint {
  if (points.length < 3) return {};
  const center = polygonCentroid(points);
  const outline = convexHull(points);
  const azimuth = principalAxisAngle(points);
  const footprintArea = polygonArea(outline);
  return {
    centerUtm: center,
    outline,
    azimuth,
    footprintArea,
  };
}

/** 由多房间局部坐标与变换，得到楼层外轮廓（UTM 米） */
export function computeFloorOutline(roomPolys: Pt[][], t: FloorTransform): Pt[] {
  const all: Pt[] = [];
  for (const poly of roomPolys) {
    for (const p of transformPolygon(poly, t)) all.push(p);
  }
  return convexHull(all);
}

/** 由多房间局部坐标与变换，得到楼层包围盒（UTM 米） */
export function computeFloorBounds(roomPolys: Pt[][], t: FloorTransform): BBox {
  const all: Pt[] = [];
  for (const poly of roomPolys) {
    for (const p of transformPolygon(poly, t)) all.push(p);
  }
  return bounds(all);
}

/**
 * 由「楼层外轮廓」多边形直接估算楼栋指纹（首选路径）。
 * 与 estimateFingerprint（基于全部房间顶点凸包）不同，本函数以楼层外轮廓线为准。
 */
export function fingerprintFromOutline(outline: Pt[]): BuildingFingerprint {
  if (outline.length < 3) return {};
  const center = polygonCentroid(outline);
  const azimuth = principalAxisAngle(outline);
  const footprintArea = polygonArea(outline);
  return {
    centerUtm: center,
    outline,
    azimuth,
    footprintArea,
  };
}

export { transformPolygon, areaScale };
