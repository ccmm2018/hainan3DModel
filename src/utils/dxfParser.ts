/**
 * 轻量 ASCII DXF 解析器（仅覆盖平面图所需实体，避免引入无类型依赖）。
 *
 * 支持的图层结构（按「楼层平面图含 4 个图层」规范）：
 *   1. 楼层外轮廓线   —— 本层外边界，1 条闭合多段线【楼栋匹配指纹的唯一来源】
 *   2. 内部结构外墙线 —— 外墙双线（仅用于诊断 / 渲染，不参与指纹）
 *   3. 内部结构内墙线 —— 房间闭合轮廓（多条）+ 房间字段文本
 *   4. 柱子及窗户线   —— 柱与窗
 *
 * 解析逻辑：
 *   1. 按图层名归一层角色（别名表 + 模糊匹配，兼容真实图纸千奇百怪的层名）；
 *   2. 楼层外轮廓线 → floorOutline（指纹来源）；内墙线闭合多边形 → 房间；
 *      外墙线 → outerWalls；柱窗线 → columns / windows；
 *   3. 每个房间质心与最近的「落在房间内部」文字标签行匹配，得到 6 个房间字段；
 *   4. 自动推断坐标来源（utm / local）与单位（m / mm / cm）；
 *      单位优先按 DXF 头 $INSUNITS，缺失时按图面跨度推断；
 *   5. 闭合兼容：端点几乎重合的多段线视为闭合（对付未显式闭合的图纸）。
 *
 * 「楼栋外轮廓线」不在楼层平面图里（它在单独的楼栋外轮廓图中，一栋楼一张），
 * 因此楼层平面图只产出「楼层外轮廓」，楼栋指纹由其反推。
 *
 * 全程使用具体类型与 unknown 收窄，不使用 any。
 */

import type {
  ClosedPolyline,
  CoordSource,
  DxfLayer,
  DxfParseResult,
  FloorPlanLayerRole,
  LengthUnit,
  ParseWarning,
  ParsedRoom,
} from '../types/cad';
import { polygonArea, polygonCentroid, bounds, type Pt } from './geometry';
import { detectCoordSource, inferUnit, type DxfHeaderVars } from './coordinate';
import { parseRoomFields, inferRoomPurpose, normalizeLabel } from './textClean';
import { matchFieldLines } from './matcher';

// ---------------------------------------------------------------------------
// 图层角色解析（别名表 + 模糊匹配）
// ---------------------------------------------------------------------------

const LAYER_ALIASES: ReadonlyArray<readonly [FloorPlanLayerRole, string[]]> = [
  [
    'floorOutline',
    [
      '楼层外轮廓线',
      '楼层轮廓线',
      '楼层外轮廓',
      '楼栋外轮廓线',
      '楼栋外轮廓',
      '建筑外轮廓线',
      '建筑外轮廓',
      '外轮廓线',
      '外轮廓',
      'floor outline',
      'floor_outline',
      'building outline',
      'building_outline',
      'outer outline',
    ],
  ],
  [
    'outerWall',
    ['内部结构外墙线', '外墙线', '外墙', '结构外墙', 'outer wall', 'outer_wall', 'external wall'],
  ],
  [
    'innerWall',
    [
      '内部结构内墙线',
      '内墙线',
      '内墙',
      '隔墙',
      '房间轮廓',
      '房间',
      'room',
      'rooms',
      'inner wall',
      'inner_wall',
      'partition',
    ],
  ],
  [
    'columnWindow',
    [
      '柱子及窗户线',
      '柱及窗',
      '柱子',
      '窗',
      '柱',
      '窗洞',
      'column',
      'columns',
      'window',
      'windows',
    ],
  ],
];

function normalizeLayerName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '');
}

/** 把任意图层名归一到语义角色；无匹配返回 'other' */
export function resolveLayerRole(layerName: string): FloorPlanLayerRole {
  const n = normalizeLayerName(layerName);
  if (!n) return 'other';
  for (const [role, aliases] of LAYER_ALIASES) {
    for (const alias of aliases) {
      const a = normalizeLayerName(alias);
      if (n === a || (a.length >= 2 && n.includes(a))) return role;
    }
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// 原始实体
// ---------------------------------------------------------------------------

interface RawEntity {
  type: 'LWPOLYLINE' | 'POLYLINE' | 'VERTEX' | 'TEXT' | 'MTEXT' | 'SEQEND' | 'LAYER';
  layer: string;
  points: number[][];
  pos: Pt | null;
  closed: boolean;
  text: string;
  color?: number;
  name: string;
}

interface RawLabel {
  pos: Pt;
  text: string;
  layer: string;
}

/** 端点几乎重合则视为闭合（闭合兼容默认规则） */
function autoClose(points: number[][], span: number): boolean {
  if (points.length < 3) return false;
  const [x0, y0] = points[0];
  const [x1, y1] = points[points.length - 1];
  const d = Math.hypot(x1 - x0, y1 - y0);
  const tol = Math.max(1e-6 * Math.max(Math.abs(x0), Math.abs(y0)), 1e-3 * span);
  return d <= tol;
}

function toClosedPolyline(e: RawEntity): ClosedPolyline {
  const polygon = e.points.map((p) => [p[0], p[1]] as [number, number]);
  return {
    polygon,
    centroid: polygonCentroid(polygon),
    area: polygonArea(polygon),
    layer: e.layer,
  };
}

function largestByArea(list: ClosedPolyline[]): ClosedPolyline | null {
  if (!list.length) return null;
  return list.reduce((best, cur) => (cur.area > best.area ? cur : best));
}

// ---------------------------------------------------------------------------
// 解析入口
// ---------------------------------------------------------------------------

export function parseDxfToResult(
  text: string,
  buildingName: string,
  floorNo: number,
): DxfParseResult {
  const lines = text.split(/\r\n|\r|\n/).map((l) => l.trim());
  const n = lines.length;

  let section = '';
  let expectSectionName = false;
  let expectTableName = false;
  let headerVar = '';
  // DXF 头变量表（如 { '$INSUNITS': '6' }），供 inferUnit 推断单位
  const header: DxfHeaderVars = {};

  const layerMap = new Map<string, number>();
  const layerOrder: string[] = [];
  const entities: RawEntity[] = [];
  const labels: RawLabel[] = [];
  let current: RawEntity | null = null;

  const flushCurrent = (): void => {
    if (!current) return;
    if (current.type === 'LAYER') {
      if (current.name && !layerMap.has(current.name)) {
        layerOrder.push(current.name);
        layerMap.set(current.name, current.color ?? 7);
      }
    } else if (current.type === 'LWPOLYLINE' || current.type === 'POLYLINE') {
      // 闭合兼容：端点重合即视为闭合
      const span = entitySpan(current.points);
      if (!current.closed && autoClose(current.points, span)) current.closed = true;
      if (current.points.length >= 3) entities.push(current);
    } else if (current.type === 'TEXT') {
      if (current.pos && current.text) {
        const line = normalizeLabel(current.text);
        if (line) labels.push({ pos: current.pos, text: line, layer: current.layer });
      }
    } else if (current.type === 'MTEXT') {
      if (current.pos && current.text) {
        // MTEXT 按 \P（或换行）拆成多行，每行视为一个候选字段（共享同一插入点）
        const multi = current.text
          .split(/\\P|\r?\n/i)
          .map((s) => normalizeLabel(s))
          .filter((s) => s.length > 0);
        for (const line of multi) labels.push({ pos: current.pos, text: line, layer: current.layer });
      }
    }
    current = null;
  };

  const entitySpan = (pts: number[][]): number => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return Math.hypot(maxX - minX, maxY - minY);
  };

  let i = 0;
  while (i < n - 1) {
    const code = lines[i];
    const value = lines[i + 1];
    i += 2;

    if (code === '0') {
      if (
        current &&
        (current.type === 'LWPOLYLINE' ||
          current.type === 'POLYLINE' ||
          current.type === 'TEXT' ||
          current.type === 'MTEXT' ||
          current.type === 'LAYER')
      ) {
        flushCurrent();
      } else if (value === 'SEQEND') {
        flushCurrent();
      } else {
        current = null;
      }

      if (value === 'SECTION') {
        expectSectionName = true;
      } else if (value === 'ENDSEC') {
        section = '';
      } else if (value === 'TABLE') {
        expectTableName = true;
      } else if (value === 'LAYER' && section === 'TABLES') {
        current = { type: 'LAYER', layer: '', points: [], pos: null, closed: false, text: '', color: undefined, name: '' };
      } else if (value === 'LWPOLYLINE' && section === 'ENTITIES') {
        current = { type: 'LWPOLYLINE', layer: '', points: [], pos: null, closed: false, text: '', color: undefined, name: '' };
      } else if (value === 'POLYLINE' && section === 'ENTITIES') {
        current = { type: 'POLYLINE', layer: '', points: [], pos: null, closed: false, text: '', color: undefined, name: '' };
      } else if (value === 'TEXT' && section === 'ENTITIES') {
        current = { type: 'TEXT', layer: '', points: [], pos: null, closed: false, text: '', color: undefined, name: '' };
      } else if (value === 'MTEXT' && section === 'ENTITIES') {
        current = { type: 'MTEXT', layer: '', points: [], pos: null, closed: false, text: '', color: undefined, name: '' };
      }
      continue;
    }

    // HEADER / TABLES 等非实体段落的头部处理（无 current 实体）
    if (!current) {
      if (section === 'HEADER') {
        // DXF 头变量：9 后跟变量名，随后一对为值
        if (code === '9') headerVar = value;
        else if (headerVar) header[headerVar] = value;
      } else if (code === '2') {
        if (expectSectionName) {
          section = value;
          expectSectionName = false;
        } else if (expectTableName) {
          expectTableName = false;
        }
      }
      continue;
    }

    switch (code) {
      case '2':
        if (current.type === 'LAYER') {
          current.name = value;
        }
        break;
      case '8':
        if (current) current.layer = value;
        break;
      case '62':
        if (current) current.color = Number(value);
        break;
      case '70':
        if (current && (current.type === 'LWPOLYLINE' || current.type === 'POLYLINE')) {
          current.closed = (Number(value) & 1) === 1;
        }
        break;
      case '10': {
        const x = Number(value);
        if (current && (current.type === 'LWPOLYLINE' || current.type === 'POLYLINE')) {
          current.points.push([x, 0]);
        } else if (current && (current.type === 'TEXT' || current.type === 'MTEXT')) {
          current.pos = [x, current.pos ? current.pos[1] : 0];
        }
        break;
      }
      case '20': {
        const y = Number(value);
        if (current && (current.type === 'LWPOLYLINE' || current.type === 'POLYLINE') && current.points.length) {
          current.points[current.points.length - 1][1] = y;
        } else if (current && (current.type === 'TEXT' || current.type === 'MTEXT') && current.pos) {
          current.pos = [current.pos[0], y];
        }
        break;
      }
      case '1':
        if (current && (current.type === 'TEXT' || current.type === 'MTEXT')) {
          current.text = current.text ? current.text + '\n' + value : value;
        }
        break;
      case '3':
        if (current && current.type === 'MTEXT') {
          current.text = current.text ? current.text + '\n' + value : value;
        }
        break;
      default:
        break;
    }
  }
  flushCurrent();

  // ---- 按图层角色归并 ----
  const roleOf = (layer: string): FloorPlanLayerRole => resolveLayerRole(layer);
  const layerRoles: Record<string, FloorPlanLayerRole> = {};
  for (const name of layerOrder) layerRoles[name] = roleOf(name);

  const closedEntities = entities.filter((e) => e.closed && e.points.length >= 3);

  const floorOutlinePolys = closedEntities
    .filter((e) => roleOf(e.layer) === 'floorOutline')
    .map(toClosedPolyline);
  const floorOutline = largestByArea(floorOutlinePolys);

  const innerPolys = closedEntities
    .filter((e) => roleOf(e.layer) === 'innerWall')
    .map(toClosedPolyline);

  // 房间来源：优先内墙线层；无内墙线层时，取除楼层外轮廓层外的所有闭合多边形（现实兼容）
  const roomSource =
    innerPolys.length > 0
      ? innerPolys
      : closedEntities
          .filter((e) => roleOf(e.layer) !== 'floorOutline')
          .map(toClosedPolyline);

  const outerWalls = entities
    .filter((e) => roleOf(e.layer) === 'outerWall')
    .map(toClosedPolyline);

  const columnWindowPolys = closedEntities
    .filter((e) => roleOf(e.layer) === 'columnWindow')
    .map(toClosedPolyline);
  const columns: ClosedPolyline[] = [];
  const windows: ClosedPolyline[] = [];
  for (const p of columnWindowPolys) {
    const ln = p.layer.trim().toLowerCase();
    // 「柱子及窗户线」为混合层，无法靠层名区分柱/窗：默认归入柱；
    // 仅当层名明确只含「窗」（不含「柱」）时才视为窗。
    const isWindowLayer = ln.includes('窗') && !ln.includes('柱');
    const isColumnLayer = ln.includes('柱') && !ln.includes('窗');
    if (isWindowLayer) windows.push(p);
    else if (isColumnLayer) columns.push(p);
    else columns.push(p);
  }

  // ---- 房间候选 + 字段行匹配 ----
  const roomShapes = roomSource.map((r) => ({ polygon: r.polygon, centroid: r.centroid }));
  const labelTexts = labels.map((l) => ({ pos: l.pos, text: l.text }));
  const matched = matchFieldLines(roomShapes, labelTexts);

  const rooms: ParsedRoom[] = roomSource.map((r, idx) => {
    const area = r.area;
    const fieldLines = matched[idx] ?? [];
    const { fields, unmatched } = parseRoomFields(fieldLines);
    const usePurpose = inferRoomPurpose(fields.name);
    const inspectStatus: ParsedRoom['inspectStatus'] = fieldLines.length > 0 ? 'normal' : 'highlight';
    const displayName =
      fields.name || (fields.code ? `房间${fields.code}` : `房间${idx + 1}`);
    return {
      id: `${buildingName}-${floorNo}-${idx + 1}`,
      buildingName,
      floorNo,
      code: fields.code,
      number: fields.number,
      name: displayName,
      dept: fields.dept,
      usePurpose,
      useArea: fields.useArea,
      buildArea: fields.buildArea,
      polygon: r.polygon,
      centroid: r.centroid,
      area,
      inspectStatus,
      useStatus: '',
      remark: unmatched.length ? unmatched.join('；') : undefined,
      selected: true,
      layers: r.layer ? [r.layer] : [],
      unmatchedTexts: unmatched,
    };
  });

  const used = new Set(matched.flat());
  const unmatched = labelTexts.filter((l) => !used.has(l.text));

  // ---- 坐标来源 / 单位推断 ----
  const allPts: Pt[] = closedEntities.flatMap((e) => e.points as Pt[]);
  const bboxRaw = bounds(allPts.length ? allPts : (floorOutline ? floorOutline.polygon : []));
  // 单位优先 $INSUNITS，缺失按图面跨度推断（见 inferUnit）
  const unit: LengthUnit = inferUnit(header, bboxRaw);
  const coordSource: CoordSource = detectCoordSource(allPts, unit);

  // ---- 图层 ----
  const layers: DxfLayer[] = layerOrder.map((name) => ({ name, color: layerMap.get(name) }));

  // ---- 告警 ----
  const warnings: ParseWarning[] = [];
  if (closedEntities.length === 0) {
    warnings.push({
      code: 'NO_ROOM',
      level: 'warn',
      message: '未识别到闭合的多段线（房间轮廓），请确认 DXF 含闭合 LWPOLYLINE / POLYLINE。',
    });
  }
  if (!floorOutline) {
    warnings.push({
      code: 'NO_FLOOR_OUTLINE',
      level: 'warn',
      message:
        '未找到「楼层外轮廓线」图层（楼栋指纹唯一来源）。将改用全部房间外包络估算楼栋指纹，精度有限；建议补充该图层。',
    });
  }
  if (labels.length === 0 && closedEntities.length > 0) {
    warnings.push({
      code: 'NO_LABEL',
      level: 'warn',
      message: '图纸中未发现文字标签，房间已按序号自动编号（房间1、房间2…）。',
    });
  }
  if (unit === 'unknown') {
    warnings.push({
      code: 'UNIT_UNKNOWN',
      level: 'warn',
      message:
        '无法推断图纸单位（坐标跨度不在 10~2000m 或 10000~200000mm 区间，且未设 $INSUNITS）。请手动指定坐标来源 / 单位，否则面积与变换可能错误。',
    });
  }
  if (unmatched.length > 0) {
    warnings.push({
      code: 'UNMATCHED_TEXT',
      level: 'warn',
      message: `有 ${unmatched.length} 个文字未匹配到房间（如材质 / 注释 / 柱窗标注），已忽略。`,
    });
  }
  if (roomSource.some((_, idx) => matched[idx].length === 0)) {
    const cnt = roomSource.filter((_, idx) => matched[idx].length === 0).length;
    warnings.push({
      code: 'UNLABELED_ROOM',
      level: 'warn',
      message: `有 ${cnt} 个房间未匹配到文字标签，已标记为需复核（highlight）。`,
    });
  }

  return {
    layers,
    rooms,
    warnings,
    coordSource,
    unit,
    bbox: bboxRaw,
    floorOutline,
    outerWalls,
    columns,
    windows,
    layerRoles,
  };
}
