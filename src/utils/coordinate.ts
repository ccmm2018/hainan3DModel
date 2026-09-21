/**
 * DXF 编码探测、单位推断、局部↔UTM 相似变换、楼栋指纹估算、WGS84→GCJ-02 转换。
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

// ---------------------------------------------------------------------------
// 自动推断坐标来源。
// 优先用单位判断：毫米 / 厘米图纸必然是局部坐标（local）。
// 米制或未知时，按坐标量级判断：UTM 49N 东向约 2e5–9e5、北向约 3e6–4.6e6，
// 命中该签名即视为 UTM；否则绝对值大于 1e5 也判 UTM，再否则为局部坐标。
// （具体阈值与例外以「坐标」兼容规则为准，此处为默认启发式。）
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// 长度单位推断
// ---------------------------------------------------------------------------

/** DXF 头变量表（$INSUNITS 等，值均为字符串，如 { '$INSUNITS': '6' }）。 */
export type DxfHeaderVars = Record<string, string>;

/**
 * 推断长度单位。
 * $INSUNITS：6=米直接返回 'm'；4=毫米返回 'mm'。
 * 0/缺失：按图面跨度推断——单层楼跨度通常 10~500m；
 *   跨度在 10~2000 判 'm'；在 10000~200000 判 'mm'（自动 ×0.001）；其余 'unknown' 给 warn。
 */
export function inferUnit(header: DxfHeaderVars, bbox: BBox): LengthUnit {
  const ins = header['$INSUNITS'];
  if (ins === '6') return 'm';
  if (ins === '4') return 'mm';
  const span = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
  if (span >= 10 && span <= 2000) return 'm';
  if (span >= 10000 && span <= 200000) return 'mm';
  return 'unknown';
}

/** 把单位换算为「米」的缩放系数（mm→0.001 / cm→0.01 / m→1）；入库面积统一换算到 ㎡。[约束4] */
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

// ---------------------------------------------------------------------------
// DXF 文本解码（编码兼容）
// DXF 有三类编码：UTF-16LE（带 BOM FF FE）、UTF-8、GBK/GB2312（国内图纸主流）。
//   1) 前两字节 0xFF 0xFE → TextDecoder('utf-16le')
//   2) 否则 UTF-8 严格解码成功 → utf-8
//   3) 抛异常 → TextDecoder('gbk')（gbk 不可用时回退 UTF-8 + 替换字符并给 warn）
// ---------------------------------------------------------------------------
export async function decodeDxf(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf);
  // 1) UTF-16LE BOM
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf);
  }
  // 2) UTF-8 严格解码
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // 非合法 UTF-8，进入 GBK 回退
  }
  // 3) GBK 回退（不可用时回退宽松 UTF-8 并告警）
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    console.warn('[dxf] 当前运行环境不支持 GBK 解码，回退宽松 UTF-8（乱码字符以替换符显示）');
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
}

/** 单点相似变换（局部坐标 → UTM 米）：UTM = scale·R(rotation)·p + offset，R 为二维旋转矩阵。 */
export function applyTransform(p: Pt, t: FloorTransform): Pt {
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  const rx = t.scale * (p[0] * c - p[1] * s);
  const ry = t.scale * (p[0] * s + p[1] * c);
  return [rx + t.offset[0], ry + t.offset[1]];
}

// ---------------------------------------------------------------------------
// local → UTM 二维相似变换求解（最小配置：2 对同名锚点）
// ---------------------------------------------------------------------------

/**
 * 由两组同名锚点（各 2 个）求解二维相似变换。
 *
 * 约定：UTM_k = scale · R(rotation) · local_k + offset  （与 applyTransform 一致）。
 * 令 dL = local[1]-local[0]，dU = utm[1]-utm[0]，则：
 *   scale   = |dU| / |dL|
 *   rotation = atan2(dU) - atan2(dL)   （按同一旋转角对齐两向量方向）
 *   offset  = utm[0] - scale·R(local[0])
 *
 * 退化处理：若两组 local 点重合（|dL|≈0），无法求旋转/缩放，退化为「仅平移」
 * （取单点偏移 scale=1 rotation=0）。local/utm 数组不足 2 时抛错。
 */
export function solveSimilarityTransform(local: readonly [Pt, Pt], utm: readonly [Pt, Pt]): FloorTransform {
  if (!local || local.length < 2 || !utm || utm.length < 2) {
    throw new Error('solveSimilarityTransform 需要两组各 2 个同名锚点');
  }
  const [l0, l1] = local;
  const [u0, u1] = utm;
  const dl: Pt = [l1[0] - l0[0], l1[1] - l0[1]];
  const du: Pt = [u1[0] - u0[0], u1[1] - u0[1]];
  const lenL = Math.hypot(dl[0], dl[1]);
  const lenU = Math.hypot(du[0], du[1]);

  if (lenL < 1e-9) {
    // 退化：两组 local 点重合，无法解旋转/缩放，退化为仅平移
    return { offset: [u0[0] - l0[0], u0[1] - l0[1]], rotation: 0, scale: 1 };
  }

  const scale = lenU / lenL;
  const rotation = Math.atan2(du[1], du[0]) - Math.atan2(dl[1], dl[0]);
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const rx = scale * (l0[0] * c - l0[1] * s);
  const ry = scale * (l0[0] * s + l0[1] * c);
  return { offset: [u0[0] - rx, u0[1] - ry], rotation, scale };
}

/**
 * 两个多边形（同坐标系，如 UTM 米）的面积差异比，用作「重合度」近似指标。
 * 返回 |A-B| / max(A,B)，0 表示面积完全一致，1 表示完全不一致。
 * 非凸 / 任意多边形均适用（仅比较面积，不做交集求算，鲁棒且廉价）。
 * 当两者面积都极小（<1e-6）时返回 0。
 */
export function polygonAreaDiffRatio(a: Pt[], b: Pt[]): number {
  const A = polygonArea(a);
  const B = polygonArea(b);
  if (A < 1e-6 && B < 1e-6) return 0;
  return Math.abs(A - B) / Math.max(A, B);
}

/** 面积偏差阈值（规范：变换后外轮廓与 footprint 偏差 >20% 给红色警告） */
export const OVERLAP_DEVIATION_THRESHOLD = 0.2;

// ---------------------------------------------------------------------------
// WGS84 → GCJ-02（火星坐标，国测局加密偏移）
// 算法参考 GCJ-02 公开实现（Krasovsky 1940 椭球 + 非线性偏移模型）。
// 出处：国家测绘局 GCJ-02 坐标加密标准（常见工程实现：
//   https://en.wikipedia.org/wiki/Restrictions_on_geographic_data_in_China）。
// [约束6] 本转换仅在「渲染定位」时调用；数据库 / 内部存储统一存 UTM/WGS84，
//         禁止把 GCJ-02 写入持久化数据。
// ---------------------------------------------------------------------------
const GCJ_PI = Math.PI;
const GCJ_A = 6378245.0; // 长半轴
const GCJ_EE = 0.00669342162296594323; // 偏心率平方

function gcjOutOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function gcjTransformLat(x: number, y: number): number {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * GCJ_PI) + 20.0 * Math.sin(2.0 * x * GCJ_PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * GCJ_PI) + 40.0 * Math.sin((y / 3.0) * GCJ_PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * GCJ_PI) + 320.0 * Math.sin((y * GCJ_PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function gcjTransformLng(x: number, y: number): number {
  let ret =
    300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * GCJ_PI) + 20.0 * Math.sin(2.0 * x * GCJ_PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * GCJ_PI) + 40.0 * Math.sin((x / 3.0) * GCJ_PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * GCJ_PI) + 300.0 * Math.sin((x / 30.0) * GCJ_PI)) * 2.0) / 3.0;
  return ret;
}

/** WGS84 经纬度 → GCJ-02 经纬度（高德坐标系） */
export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (gcjOutOfChina(lng, lat)) return [lng, lat];
  let dLat = gcjTransformLat(lng - 105.0, lat - 35.0);
  let dLng = gcjTransformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * GCJ_PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * GCJ_PI);
  dLng = (dLng * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * GCJ_PI);
  return [lng + dLng, lat + dLat];
}

export { transformPolygon, areaScale };
