/**
 * 文本标签 ↔ 房间匹配，以及楼栋名模糊匹配。
 * 不使用 any。
 */

import { dist2, pointInPolygon, type Pt } from './geometry';
import type { BuildingDataMap, BuildingProps } from '../data/buildingData';

export interface LabelText {
  pos: Pt;
  text: string;
}

/**
 * 为每个房间匹配文字标签。
 * 仅采用「落在房间多边形内部」的文字，多个内部文字取离质心最近者；
 * 若房间内无任何文字，则该房间返回 null（避免把其它房间的标签误配过来）。
 * 返回与 rooms 等长的数组：命中文字为字符串，否则为 null。
 */
export function matchLabels(
  rooms: ReadonlyArray<{ polygon: Pt[]; centroid: Pt }>,
  texts: ReadonlyArray<LabelText>,
): (string | null)[] {
  return rooms.map((room) => {
    let best: string | null = null;
    let bestDist = Infinity;
    for (const t of texts) {
      if (!pointInPolygon(t.pos, room.polygon)) continue;
      const d = dist2(t.pos, room.centroid);
      if (d < bestDist) {
        bestDist = d;
        best = t.text;
      }
    }
    return best;
  });
}

/**
 * 模糊匹配楼栋名：精确 → 去空格 → 大小写不敏感 → 包含关系。
 * 用于导入时把用户选择的楼栋与 BuildingProps 主键对齐。
 */
export function fuzzyMatchBuilding(query: string, candidates: string[]): string | null {
  const q = query.trim();
  if (!q) return null;
  const ql = q.toLowerCase();
  for (const c of candidates) {
    if (c === q) return c;
  }
  for (const c of candidates) {
    if (c.toLowerCase() === ql) return c;
  }
  for (const c of candidates) {
    const cl = c.toLowerCase();
    if (cl.includes(ql) || ql.includes(cl)) return c;
  }
  return null;
}

/**
 * 为每个房间收集「落在多边形内部」的全部文字行（候选字段）。
 *
 * 与 matchLabels（只取最近一条）不同，本函数返回房间内所有文字行——
 * 因房间的 6 个字段可能是 6 个独立 TEXT，或 1 个 MTEXT 拆出的多行，
 * 每一行都是一条候选字段，需交给 parseRoomFields 按标签/位置解析。
 *
 * 若房间内无任何文字（宽松兼容），回退到「离质心最近的一条」，
 * 避免把多行标签整体丢给相邻房间。
 */
export function matchFieldLines(
  rooms: ReadonlyArray<{ polygon: Pt[]; centroid: Pt }>,
  texts: ReadonlyArray<LabelText>,
): string[][] {
  return rooms.map((room) => {
    const inside = texts
      .filter((t) => pointInPolygon(t.pos, room.polygon))
      .map((t) => t.text);
    if (inside.length > 0) return inside;

    let best: string | null = null;
    let bestDist = Infinity;
    for (const t of texts) {
      const d = dist2(t.pos, room.centroid);
      if (d < bestDist) {
        bestDist = d;
        best = t.text;
      }
    }
    return best ? [best] : [];
  });
}

// ---------------------------------------------------------------------------
// 楼栋匹配：指纹（中心 / 面积 / 方位）三维几何比对   [约束2]
// 指纹只取自「楼层外轮廓线」那 1 条闭合线；房间闭合轮廓是业务内容，永不参与匹配。
// ---------------------------------------------------------------------------

/** 匹配阈值（强匹配需三项全满足） */
export const MATCH_CENTER_M = 50; // 中心距离 ≤ 50m
export const MATCH_AREA_RATIO = 0.1; // 面积差异 ≤ 10%
export const MATCH_AZIMUTH_DEG = 5; // 方位角差异 ≤ 5°

/** none 诊断阈值（按优先级） */
const NONE_CENTER_M = 10000; // ① 中心距离 > 10000m
const NONE_AREA_RATIO = 0.5; // ② 面积差异 > 50%
const NONE_AZIMUTH_DEG = 30; // ③ 方位角差异 > 30°

/**
 * 楼栋指纹：由「楼层外轮廓线」那 1 条闭合线算出。
 * - centerUtm：轮廓质心（UTM 49N，米）
 * - area：轮廓面积（㎡）
 * - azimuth：轮廓主轴方位角（度，[0,360) 正北顺时针）
 */
export interface Fingerprint {
  centerUtm: [number, number];
  area: number;
  azimuth: number;
}

/** 单个楼栋的匹配明细 */
export interface BuildingMatch {
  /** 楼栋名（= BuildingProps.name = GLB 节点名） */
  name: string;
  /** 中心距离（米） */
  centerDist: number;
  /** 面积相对差异（0~1） */
  areaDiff: number;
  /** 方位角差异（度，[0,180]） */
  azimuthDiff: number;
  /** 三项指标的判定结果 */
  metrics: { center: boolean; area: boolean; azimuth: boolean };
  /** 综合相似度（0~100），由中心 / 面积 / 方位三项归一化加权得出，便于 UI 展示「相似度 98%」 */
  similarity: number;
}

/** 匹配结果 */
export interface MatchResult {
  /** strong：三项全满足且唯一候选；weak：满足 1~2 项或存在多个候选；none：全不满足 */
  status: 'strong' | 'weak' | 'none';
  /** 命中楼栋名（strong 1 个；weak 1 或多个；none 为空） */
  candidates: string[];
  /** 候选楼栋匹配明细 */
  matches: BuildingMatch[];
  /** 诊断原因（none 时按优先级给 1 条；weak 时给出未满足项说明） */
  reasons: string[];
  /** 最佳候选相似度（0~100），用于 UI 展示「相似度 98%」；无候选时为 undefined */
  score?: number;
}

/** 从 BuildingProps 索引签名读取楼栋指纹；字段不齐（缺 centerUtm/footprintArea/azimuth）返回 null */
export function readBuildingFingerprint(b: BuildingProps): Fingerprint | null {
  const rec = b as Record<string, unknown>;
  const c = rec['centerUtm'];
  const area = rec['footprintArea'];
  const az = rec['azimuth'];
  if (
    !Array.isArray(c) ||
    c.length !== 2 ||
    typeof c[0] !== 'number' ||
    typeof c[1] !== 'number' ||
    typeof area !== 'number' ||
    !Number.isFinite(area) ||
    typeof az !== 'number' ||
    !Number.isFinite(az)
  ) {
    return null;
  }
  return {
    centerUtm: [c[0], c[1]],
    area,
    azimuth: az,
  };
}

/** 两方位角的最小夹角（度，[0,180]） */
export function angleDiffDeg(a: number, b: number): number {
  let d = Math.abs(((a - b) % 360 + 360) % 360);
  if (d > 180) d = 360 - d;
  return d;
}

function centerDistance(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/** 面积相对差异：|a-b| / max(a,b)（避免除零） */
function areaDiffRatio(a: number, b: number): number {
  const m = Math.max(a, b, 1e-9);
  return Math.abs(a - b) / m;
}

/** 按优先级诊断「全不满足」的原因 */
function diagnoseNone(m: BuildingMatch): string[] {
  if (m.centerDist > NONE_CENTER_M) {
    return ['中心距离超过 10000m，坐标系可能不是 UTM，请改用手动配准。'];
  }
  if (m.areaDiff > NONE_AREA_RATIO) {
    return ['楼层外轮廓面积差异超过 50%，可能画错（误把走廊 / 房间当外轮廓）。'];
  }
  if (m.azimuthDiff > NONE_AZIMUTH_DEG) {
    return ['方位角差异超过 30°，请确认是否按真实方位绘制。'];
  }
  return ['未匹配到楼栋，请手动指定。'];
}

/** 弱匹配时列出未满足的指标 */
function describeWeak(m: BuildingMatch): string[] {
  const fails: string[] = [];
  if (!m.metrics.center) fails.push(`中心距离 ${Math.round(m.centerDist)}m（阈值 ≤${MATCH_CENTER_M}m）`);
  if (!m.metrics.area) fails.push(`面积差异 ${(m.areaDiff * 100).toFixed(0)}%（阈值 ≤${MATCH_AREA_RATIO * 100}%）`);
  if (!m.metrics.azimuth) fails.push(`方位角差异 ${m.azimuthDiff.toFixed(1)}°（阈值 ≤${MATCH_AZIMUTH_DEG}°）`);
  return [`部分匹配「${m.name}」：${fails.join('；')}。`];
}

/**
 * 把「楼层外轮廓指纹」与楼栋库比对，返回强 / 弱 / 无匹配。
 *
 * @param fp        解析得到的楼层外轮廓指纹（中心 / 面积 / 方位）
 * @param buildings 楼栋属性表（Record<节点名, BuildingProps>），遍历 Object.values
 *
 * 规则：
 * - 遍历每个楼栋，读取其挂载的指纹（centerUtm / footprintArea / azimuth）。
 * - 三项指标：中心距离 ≤50m、面积差异 ≤10%、方位角差异 ≤5°。
 * - strong：三项全满足且唯一候选。
 * - weak  ：满足 1~2 项，或多个候选同时满足三项。
 * - none  ：全不满足，按优先级诊断原因。
 * 房间闭合轮廓不参与匹配。
 */
export function matchBuildings(fp: Fingerprint, buildings: BuildingDataMap): MatchResult {
  const scored: BuildingMatch[] = [];
  for (const b of Object.values(buildings)) {
    const bf = readBuildingFingerprint(b);
    if (!bf) continue; // 未录入指纹的楼栋无法参与几何比对
    const centerDist = centerDistance(fp.centerUtm, bf.centerUtm);
    const areaDiff = areaDiffRatio(fp.area, bf.area);
    const azimuthDiff = angleDiffDeg(fp.azimuth, bf.azimuth);
    const center = centerDist <= MATCH_CENTER_M;
    const area = areaDiff <= MATCH_AREA_RATIO;
    const azimuth = azimuthDiff <= MATCH_AZIMUTH_DEG;
    // 三项指标各自归一化到 [0,1]：在阈值内随偏差线性衰减到 0；加权求和得到综合相似度
    const centerScore = center ? Math.max(0, 1 - centerDist / MATCH_CENTER_M) : 0;
    const areaScore = area ? Math.max(0, 1 - areaDiff / MATCH_AREA_RATIO) : 0;
    const azimuthScore = azimuth ? Math.max(0, 1 - azimuthDiff / MATCH_AZIMUTH_DEG) : 0;
    const similarity = Math.round((centerScore * 0.5 + areaScore * 0.3 + azimuthScore * 0.2) * 100);
    scored.push({
      name: b.name,
      centerDist,
      areaDiff,
      azimuthDiff,
      metrics: { center, area, azimuth },
      similarity,
    });
  }

  if (scored.length === 0) {
    return {
      status: 'none',
      candidates: [],
      matches: [],
      reasons: ['楼栋库中还没有对应楼栋的位置与轮廓信息，系统无法自动判断它属于哪栋楼。请点「下一步」，在「确认归属」中手动选择归属楼栋。'],
    };
  }

  // 最佳候选相似度（取分数最高、中心最近者），作为 MatchResult.score 对外展示
  const top = [...scored].sort((x, y) => {
    if (y.similarity !== x.similarity) return y.similarity - x.similarity;
    return x.centerDist - y.centerDist;
  })[0];

  const full = scored.filter((s) => s.metrics.center && s.metrics.area && s.metrics.azimuth);
  if (full.length === 1) {
    return { status: 'strong', candidates: [full[0].name], matches: full, reasons: [], score: full[0].similarity };
  }
  if (full.length > 1) {
    return {
      status: 'weak',
      candidates: full.map((s) => s.name),
      matches: full,
      reasons: ['多个楼栋同时满足中心 / 面积 / 方位匹配，请确认归属。'],
      score: Math.max(...full.map((s) => s.similarity)),
    };
  }

  // 无三项全中：best 即 top
  if (top.similarity === 0) {
    return { status: 'none', candidates: [], matches: [top], reasons: diagnoseNone(top), score: 0 };
  }
  return { status: 'weak', candidates: [top.name], matches: [top], reasons: describeWeak(top), score: top.similarity };
}
