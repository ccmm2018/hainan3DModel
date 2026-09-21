/**
 * 轻量 ASCII DXF 解析器（仅覆盖平面图所需实体，避免引入无类型依赖）。
 *
 * 支持的图层结构（按「楼层平面图含 4 个图层」规范）：
 *   1. 楼层外轮廓线   —— 本层外边界，1 条闭合多段线【楼栋匹配指纹的唯一来源】
 *   2. 内部结构外墙线 —— 外墙双线（仅用于诊断 / 渲染，不参与指纹）
 *   3. 内部结构内墙线 —— 房间闭合轮廓（多条）+ 房间字段文本
 *   4. 柱子及窗户线   —— 柱与窗
 *
 * 解析分两层：
 *   - parseDxf(text)              低层「组码-值」状态机，返回 { header, layers, entities }，
 *                                   不依赖 buildingName / floorNo，可被 Worker / 测试独立调用；
 *   - extractRooms(entities, layers, unit, ctx)
 *                                   纯函数：把实体过滤（图层 + 实体类型双重过滤）、闭合判定、
 *                                   面积阈值、多文本竞争字段关联，产出 ParsedRoom[]；
 *   - parseDxfToResult(...)       高层编排：串起上面两步 + 坐标/单位推断 + 告警，
 *                                   是 Worker / 导入组件 / 测试的对外入口。
 *
 * 兼容规则（现实兼容，必须全部实现）：
 *   - 闭合判定三选一：flags bit0 / flags bit512 / 首尾点距离 < 1e-4（见 isClosedPolyline）；
 *   - LWPOLYLINE 与老式 POLYLINE(VERTEX+SEQEND) 都支持；
 *   - Splinline/ELLIPSE/ARC（曲线）MVP 不提取为房间，计入告警，不得静默丢弃；
 *   - INSERT / ATTRIB 块参照默认整体跳过（噪音来源），expandBlocks=true 时保留 ATTRIB 文字；
 *   - TEXT / MTEXT 均接受；MTEXT 经 textClean 去格式码并按 \P 拆成多行候选字段；
 *   - 4 个规定图层缺失时给 warn（不是直接 error），按实际存在图层尽力提取。
 *
 * DXF 是「组码-值」成对文本：按行扫描维护 (code, value) 成对状态机，跳过空行，
 * 不假设严格两行一组。全程使用具体类型与 unknown 收窄，不使用 any。
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
import {
  polygonArea,
  polygonCentroid,
  bounds,
  pointInPolygon,
  dist2,
  simplifyDedup,
  isSelfIntersecting,
  type Pt,
} from './geometry';
import { detectCoordSource, inferUnit, type DxfHeaderVars } from './coordinate';
import {
  FIELD_PATTERNS,
  inferRoomPurpose,
  splitMtext,
  parseArea,
  type RoomFields,
} from './textClean';

// ---------------------------------------------------------------------------
// 图层角色解析（trim + 全角/半角括号容错，精确匹配，不模糊到无关图层）
// ---------------------------------------------------------------------------

/** 全角括号 → 半角括号，便于统一匹配 */
const FULL_TO_HALF_BRACKET: ReadonlyArray<readonly [string, string]> = [
  ['（', '('],
  ['）', ')'],
  ['【', '['],
  ['】', ']'],
  ['［', '['],
  ['］', ']'],
  ['｛', '{'],
  ['｝', '}'],
];

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

/** 归一化图层名：trim + 全角括号转半角 + 小写 + 去空白 */
function canonicalizeLayerName(name: string): string {
  let s = name.trim();
  for (const [f, h] of FULL_TO_HALF_BRACKET) s = s.split(f).join(h);
  return s.toLowerCase().replace(/\s+/g, '');
}

/**
 * 把任意图层名归一到语义角色；无匹配返回 'other'。
 *
 * 匹配策略（规则 6）：先归一化（trim + 全角括号转半角 + 小写去空白），再与候选别名做
 * **精确**匹配；同时允许「去掉尾部括号组」后再匹配（如「楼层外轮廓线（房间）」= 楼层外轮廓线）。
 * 不使用 substring includes，避免把「外墙装饰线」等无关图层误判为「外墙线」。
 */
export function resolveLayerRole(layerName: string): FloorPlanLayerRole {
  const c = canonicalizeLayerName(layerName);
  // 去掉首个 ( [ （ 【 起的尾部内容（图层常见区分后缀，如 (1) / （房间） / [设备]）
  const cNoSuffix = c.replace(/[\(（\[【].*$/, '');
  const candidates = [c, cNoSuffix];
  for (const [role, aliases] of LAYER_ALIASES) {
    for (const alias of aliases) {
      const a = canonicalizeLayerName(alias);
      if (candidates.includes(a)) return role;
    }
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// 低层实体模型（parseDxf 产出）
// ---------------------------------------------------------------------------

export type DxfEntityType =
  | 'LWPOLYLINE'
  | 'POLYLINE'
  | 'TEXT'
  | 'MTEXT'
  | 'LAYER'
  | 'INSERT'
  | 'ATTRIB'
  | 'SPLINE'
  | 'ELLIPSE'
  | 'ARC'
  | 'LINE'
  | 'CIRCLE'
  | 'POINT'
  | string;

/** 解析出的单个实体（原始坐标，未清洗文本） */
export interface DxfEntity {
  type: DxfEntityType;
  layer: string;
  /** LWPOLYLINE / POLYLINE 顶点（原生坐标） */
  points: [number, number][];
  /** TEXT / MTEXT / ATTRIB 插入点 */
  pos: [number, number] | null;
  /** 70 标志（闭合判定用） */
  flags: number;
  /** 最终闭合判定（见 isClosedPolyline） */
  closed: boolean;
  /** 原始文本（含格式码，未清洗） */
  text: string;
  color?: number;
  name: string;
  /** LAYER 实体：bit0=1 表示冻结 */
  frozen?: boolean;
  /** POLYLINE 已进入 VERTEX 子实体收集阶段 */
  vertexStarted?: boolean;
}

/** 解析出的图层 */
export interface DxfLayerInfo {
  name: string;
  frozen: boolean;
  color?: number;
}

/** parseDxf 低层产出 */
export interface ParseDxfOutput {
  /** DXF 头变量表（如 $INSUNITS / $EXTMIN / $EXTMAX，值为字符串） */
  header: DxfHeaderVars;
  layers: DxfLayerInfo[];
  entities: DxfEntity[];
}

/** 曲线实体类型（MVP 不提取为房间，但需计数告警） */
const CURVE_TYPES: ReadonlyArray<string> = ['SPLINE', 'ELLIPSE', 'ARC'];

// ---------------------------------------------------------------------------
// 闭合判定（三选一）
// ---------------------------------------------------------------------------

/** 三选一闭合判定：flags bit0 / flags bit512 / 首尾点距离 < 1e-4（原生坐标单位） */
export function isClosedPolyline(e: DxfEntity): boolean {
  if (e.points.length < 3) return false;
  const bit0 = (e.flags & 1) === 1;
  const bit512 = (e.flags & 512) === 512;
  const [x0, y0] = e.points[0];
  const [x1, y1] = e.points[e.points.length - 1];
  const endpointClose = Math.hypot(x1 - x0, y1 - y0) < 1e-4;
  return bit0 || bit512 || endpointClose;
}

/** LWPOLYLINE / POLYLINE 通用：返回顶点；其它类型返回空数组 */
export function entityPoints(e: DxfEntity): [number, number][] {
  if (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') return e.points;
  return [];
}

// ---------------------------------------------------------------------------
// 低层解析：parseDxf
// ---------------------------------------------------------------------------

export function parseDxf(text: string): ParseDxfOutput {
  // 按行切分，去除空行，得到干净的 token 序列（组码 / 值成对出现）
  const tokens: string[] = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const t = rawLine.trim();
    if (t !== '') tokens.push(t);
  }
  const nt = tokens.length;

  let section = '';
  let expectSectionName = false;
  let expectTableName = false;
  let headerVar = '';
  // DXF 头变量表（如 { '$INSUNITS': '6' }），供 inferUnit 推断单位
  const header: DxfHeaderVars = {};
  // 头段 $EXTMIN / $EXTMAX（10/20），作为实体缺失时的包围盒回退
  let extMin: [number, number] | null = null;
  let extMax: [number, number] | null = null;

  const layerMap = new Map<string, { color: number; frozen: boolean }>();
  const layerOrder: string[] = [];
  const entities: DxfEntity[] = [];
  let current: DxfEntity | null = null;

  const newEntity = (type: DxfEntityType): DxfEntity => ({
    type,
    layer: '',
    points: [],
    pos: null,
    flags: 0,
    closed: false,
    text: '',
    color: undefined,
    name: '',
  });

  const flushCurrent = (): void => {
    if (!current) return;
    const t = current.type;
    if (t === 'LAYER') {
      if (current.name && !layerMap.has(current.name)) {
        const frozen = Boolean(current.frozen);
        layerOrder.push(current.name);
        layerMap.set(current.name, { color: current.color ?? 7, frozen });
      }
    } else if (t === 'LWPOLYLINE' || t === 'POLYLINE') {
      // 闭合判定三选一（见 isClosedPolyline）
      current.closed = isClosedPolyline(current);
      // 端点近重合的「软闭合」：把末顶点吸附到首顶点，避免形成尖刺边导致
      // pointInPolygon 误判内部点为外部（真实图纸常以 ~1e-4 偏差收尾）。
      const pts = current.points;
      if (current.closed && pts.length >= 3) {
        const a = pts[0];
        const b = pts[pts.length - 1];
        if (Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4) {
          pts[pts.length - 1] = [a[0], a[1]];
        }
      }
      // 吸附后再去重：仅剔除内部相邻重复点，保留闭合首末点（removeClosing=false），
      // 否则会把刚吸附的闭合点删掉、重新变成开口环。
      current.points = simplifyDedup(current.points as Pt[], 1e-4, false);
      if (current.points.length >= 3) entities.push(current);
    } else if (t === 'TEXT' || t === 'MTEXT' || t === 'ATTRIB') {
      // 文本实体：保留原始文本与插入点，清洗放到 extractRooms 阶段
      if (current.pos && current.text) entities.push(current);
    } else {
      // INSERT / SPLINE / ELLIPSE / ARC / 其它：保留用于计数 / 跳过判断
      entities.push(current);
    }
    current = null;
  };

  let i = 0;
  while (i + 1 < nt) {
    const code = tokens[i];
    const value = tokens[i + 1];
    i += 2;

    // -------- code=0 开启新结构 / 新实体 --------
    if (code === '0') {
      if (current) {
        const continuePolyline = value === 'VERTEX' && current.type === 'POLYLINE';
        const continueBlock =
          (value === 'ATTRIB' && current.type === 'INSERT') ||
          (value === 'SEQEND' && current.type === 'INSERT');
        if (!continuePolyline && !continueBlock) flushCurrent();
      }

      if (value === 'SECTION') {
        expectSectionName = true;
      } else if (value === 'ENDSEC') {
        section = '';
        expectSectionName = false;
      } else if (value === 'TABLE') {
        expectTableName = true;
      } else if (value === 'LAYER' && section === 'TABLES') {
        current = newEntity('LAYER');
        expectTableName = false;
      } else if (value === 'LWPOLYLINE' && section === 'ENTITIES') {
        current = newEntity('LWPOLYLINE');
      } else if (value === 'POLYLINE' && section === 'ENTITIES') {
        current = newEntity('POLYLINE');
      } else if (value === 'VERTEX') {
        if (current && current.type === 'POLYLINE') {
          // 首次出现时清空可能残留的 POLYLINE 头顶点
          if (!current.vertexStarted) {
            current.points = [];
            current.vertexStarted = true;
          }
        }
      } else if (value === 'SEQEND') {
        // POLYLINE 结束：flushCurrent 已在上一步执行，置空
        current = null;
      } else if (value === 'TEXT' && section === 'ENTITIES') {
        current = newEntity('TEXT');
      } else if (value === 'MTEXT' && section === 'ENTITIES') {
        current = newEntity('MTEXT');
      } else if (value === 'INSERT' && section === 'ENTITIES') {
        current = newEntity('INSERT');
      } else if (value === 'ATTRIB' && section === 'ENTITIES') {
        current = newEntity('ATTRIB');
      } else if (
        (value === 'SPLINE' || value === 'ELLIPSE' || value === 'ARC') &&
        section === 'ENTITIES'
      ) {
        // 曲线实体：MVP 不提取为房间，仅计数告警（见 parseDxfToResult）
        current = newEntity(value);
      } else {
        current = null;
      }
      continue;
    }

    // -------- 无 current 实体时的段头处理（HEADER / TABLES 结构） --------
    if (!current) {
      if (section === 'HEADER') {
        if (code === '9') {
          headerVar = value;
        } else if (headerVar === '$INSUNITS') {
          header[headerVar] = value;
        } else if (headerVar === '$EXTMIN') {
          if (code === '10') extMin = [Number(value), extMin ? extMin[1] : NaN];
          else if (code === '20') extMin = [extMin ? extMin[0] : NaN, Number(value)];
        } else if (headerVar === '$EXTMAX') {
          if (code === '10') extMax = [Number(value), extMax ? extMax[1] : NaN];
          else if (code === '20') extMax = [extMax ? extMax[0] : NaN, Number(value)];
        }
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

    // -------- 实体属性解析 --------
    switch (code) {
      case '2':
        if (current.type === 'LAYER') current.name = value;
        break;
      case '8':
        current.layer = value;
        break;
      case '62':
        current.color = Number(value);
        break;
      case '70':
        if (current.type === 'LAYER') {
          // bit0 = 1 冻结
          current.frozen = (Number(value) & 1) === 1;
        } else if (current.type === 'LWPOLYLINE' || current.type === 'POLYLINE') {
          current.flags = Number(value);
        }
        break;
      case '10': {
        const x = Number(value);
        if (current.type === 'LWPOLYLINE') {
          current.points.push([x, 0]);
        } else if (current.type === 'POLYLINE' && current.vertexStarted) {
          current.points.push([x, 0]);
        } else if (current.type === 'TEXT' || current.type === 'MTEXT' || current.type === 'ATTRIB') {
          current.pos = [x, current.pos ? current.pos[1] : 0];
        }
        break;
      }
      case '20': {
        const y = Number(value);
        if (
          (current.type === 'LWPOLYLINE' ||
            (current.type === 'POLYLINE' && current.vertexStarted)) &&
          current.points.length
        ) {
          current.points[current.points.length - 1][1] = y;
        } else if (
          (current.type === 'TEXT' || current.type === 'MTEXT' || current.type === 'ATTRIB') &&
          current.pos
        ) {
          current.pos = [current.pos[0], y];
        }
        break;
      }
      case '1':
        if (current.type === 'TEXT' || current.type === 'MTEXT' || current.type === 'ATTRIB') {
          current.text = current.text ? current.text + '\n' + value : value;
        }
        break;
      case '3':
        if (current.type === 'MTEXT' || current.type === 'ATTRIB') {
          current.text = current.text ? current.text + '\n' + value : value;
        }
        break;
      default:
        break;
    }
  }
  flushCurrent();

  if (extMin && Number.isFinite(extMin[0]) && Number.isFinite(extMin[1])) {
    header['$EXTMIN'] = `${extMin[0]},${extMin[1]}`;
  }
  if (extMax && Number.isFinite(extMax[0]) && Number.isFinite(extMax[1])) {
    header['$EXTMAX'] = `${extMax[0]},${extMax[1]}`;
  }

  const layers: DxfLayerInfo[] = layerOrder.map((name) => ({
    name,
    color: layerMap.get(name)?.color,
    frozen: layerMap.get(name)?.frozen ?? false,
  }));

  return { header, layers, entities };
}

// ---------------------------------------------------------------------------
// 房间提取：extractRooms（双重过滤 + 面积阈值 + 多文本竞争字段关联）
// ---------------------------------------------------------------------------

/** 部门字典（用于「匹配部门字典的作为部门名称」的兜底识别） */
const DEPT_KEYWORDS: ReadonlyArray<RegExp> = [
  /教务/,
  /学工/,
  /后勤/,
  /保卫/,
  /图书馆/,
  /校办/,
  /基建/,
  /财务/,
  /人事/,
  /院系|学院/,
  /教研/,
  /办公室/,
  /中心/,
  /实验中心/,
  /管理处/,
  /团委/,
  /党委/,
];

/** 把单位换算成「平方米」的系数（unknown 时按 1 处理，best-effort） */
function unitToSqMeter(unit: LengthUnit): number {
  switch (unit) {
    case 'mm':
      return 1e-6;
    case 'cm':
      return 1e-4;
    case 'm':
      return 1;
    default:
      return 1;
  }
}

interface FieldText {
  pos: [number, number];
  text: string;
}

/**
 * 多文本竞争字段关联。
 * 给定一个房间内（pointInPolygon）的文本行集合：
 *   1) 优先用标签正则（房间编码/房间号码/房间名称/部门名称/使用面积/建筑面积）解析 6 字段；
 *   2) 标签未命中的裸行，按「到质心距离」升序竞争回填（不得丢弃）：
 *      - 离质心最近的文本 → 房间名称；
 *      - 纯数字 / 带房·室 → 房间号码；
 *      - 带 ㎡/m2/平方 → 使用面积；
 *      - 命中部门字典 → 部门名称；
 *   3) 其余文本拼入 remark / unmatchedTexts；
 *   4) 字段识别不出（name/code 皆空）时，房间仍保留，状态交由调用方置为 partial。
 *
 * 注意：不依赖 parseRoomFields 的位置兜底结果，避免把它与「按距离竞争」混淆；
 * 标签行优先，裸行一律走竞争回填。
 */
function associateRoomFields(inside: FieldText[], centroid: Pt): {
  fields: RoomFields;
  remark: string;
  remaining: string[];
} {
  const fields: RoomFields = {
    code: '',
    number: '',
    name: '',
    dept: '',
    useArea: 0,
    buildArea: 0,
  };

  const byLabel: FieldText[] = [];
  const bare: FieldText[] = [];
  for (const t of inside) {
    let labeled = false;
    for (const [field, re] of FIELD_PATTERNS) {
      const m = t.text.match(re);
      if (m) {
        labeled = true;
        const val = (m[1] ?? '').trim();
        if (field === 'useArea' || field === 'buildArea') fields[field] = parseArea(val);
        else fields[field] = val;
        break;
      }
    }
    (labeled ? byLabel : bare).push(t);
  }

  const byDist = (list: FieldText[]): FieldText[] =>
    list.slice().sort((a, b) => dist2(a.pos, centroid) - dist2(b.pos, centroid));

  // 各字段独立竞争（不互相消费同一行）：同一文本可同时作为「名称（离质心最近）」
  // 与「房间号码（纯数字）」。例如 "101" 既是离质心最近的一行，又是纯数字号码。
  if (!fields.name) {
    const pick = byDist(bare)[0];
    if (pick) fields.name = pick.text;
  }
  if (!fields.number && !fields.code) {
    // 纯数字（如 "101"）或带 房/号/室 后缀（如 "201室"、"3号"）：必须以数字开头，
    // 避免把含「室」的房间名（如「会议室」）误判为房间号码。
    const pick = byDist(bare.filter((t) => /^\d{1,5}(?:[房号室])?$/.test(t.text)))[0];
    if (pick) {
      fields.number = pick.text;
      fields.code = pick.text.replace(/\D/g, '');
    }
  }
  if (fields.useArea === 0) {
    const pick = byDist(bare.filter((t) => /㎡|m2|m²|平方/.test(t.text)))[0];
    if (pick) fields.useArea = parseArea(pick.text);
  }
  if (!fields.dept) {
    const pick = bare.find((t) => DEPT_KEYWORDS.some((re) => re.test(t.text)));
    if (pick) fields.dept = pick.text;
  }

  // remark = 既非带标签行、也未被任一字段采用的裸文本（其余未匹配文字拼入，不得丢弃）
  const used = new Set<string>();
  if (fields.name) used.add(fields.name);
  if (fields.number) used.add(fields.number);
  if (fields.code) used.add(fields.code);
  if (fields.dept) used.add(fields.dept);
  const remaining = bare.filter((t) => !used.has(t.text)).map((t) => t.text);
  const remark = remaining.join('；');
  return { fields, remark, remaining };
}

export interface ExtractRoomsCtx {
  buildingName?: string;
  floorNo?: number;
  /** 是否展开块参照（保留 ATTRIB 文字作为房间字段） */
  expandBlocks?: boolean;
}

/**
 * 从实体中提取房间候选（ParsedRoom[]）。
 *
 * 双重过滤（图层 + 实体类型）：
 *   - 房间轮廓 = 图层角色含 innerWall && LWPOLYLINE/POLYLINE && isClosed
 *                && 面积（换算成 ㎡）> 5㎡（过滤管井、柱垛）；
 *   - 房间字段 = 图层角色含 innerWall && TEXT/MTEXT 清洗后的每一行文本。
 * 4 个规定图层缺失时（innerWall 不存在），回退「除楼层外轮廓外全部闭合多边形」尽力提取。
 */
export function extractRooms(
  entities: DxfEntity[],
  layers: DxfLayerInfo[],
  unit: LengthUnit,
  ctx?: ExtractRoomsCtx,
): ParsedRoom[] {
  const buildingName = ctx?.buildingName ?? '';
  const floorNo = ctx?.floorNo ?? 0;
  const expandBlocks = ctx?.expandBlocks ?? false;

  const frozenSet = new Set(layers.filter((l) => l.frozen).map((l) => l.name));
  const roleOf = (layer: string): FloorPlanLayerRole => resolveLayerRole(layer);

  // 闭合多段线（排除冻结图层）
  const closed = entities.filter(
    (e) =>
      (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') &&
      e.closed &&
      e.points.length >= 3 &&
      !frozenSet.has(e.layer),
  );

  const innerLayerExists = closed.some((e) => roleOf(e.layer) === 'innerWall');
  const roomSource = innerLayerExists
    ? closed.filter((e) => roleOf(e.layer) === 'innerWall')
    : closed.filter((e) => roleOf(e.layer) !== 'floorOutline');

  const sqScale = unitToSqMeter(unit);
  const roomOutlines = roomSource
    .map((e) => ({
      entity: e,
      polygon: e.points.map((p) => [p[0], p[1]] as [number, number]),
      centroid: polygonCentroid(e.points as Pt[]),
      area: polygonArea(e.points as Pt[]),
    }))
    // 面积（换算成㎡）> 5㎡ 过滤管井、柱垛
    .filter((r) => r.area * sqScale > 5);

  // 房间字段文本：TEXT/MTEXT（expandBlocks 时含 ATTRIB），清洗成多行候选
  const textEntities = entities.filter(
    (e) =>
      (e.type === 'TEXT' ||
        e.type === 'MTEXT' ||
        (expandBlocks && e.type === 'ATTRIB')) &&
      e.pos &&
      e.text &&
      !frozenSet.has(e.layer),
  );
  // 房间字段文本默认只在「内部结构内墙线」图层上取（符合规范）。
  // 展开块参照时，块属性（ATTRIB）常落在「家具」等其它图层，按「落入哪个房间多边形」归属，
  // 因此绕过图层过滤，交由 pointInPolygon 决定归属。
  const fieldLayerFilter = (e: DxfEntity): boolean => {
    if (expandBlocks && e.type === 'ATTRIB') return true;
    return innerLayerExists ? roleOf(e.layer) === 'innerWall' : true;
  };
  const fieldTexts: FieldText[] = textEntities
    .filter(fieldLayerFilter)
    .flatMap((e) =>
      splitMtext(e.text).map((line) => ({ pos: e.pos as [number, number], text: line })),
    );

  return roomOutlines.map((r, idx) => {
    const inside = fieldTexts
      .filter((t) => pointInPolygon(t.pos, r.polygon))
      .sort((a, b) => dist2(a.pos, r.centroid) - dist2(b.pos, r.centroid));
    const assoc = associateRoomFields(inside, r.centroid);
    const f = assoc.fields;
    const usePurpose = inferRoomPurpose(f.name);
    // 字段识别不出（name/code 皆空）→ partial，留给预览页人工补填
    const identified = Boolean(f.name || f.code || f.number);
    const inspectStatus: ParsedRoom['inspectStatus'] = identified ? 'normal' : 'partial';
    const displayName = f.name || (f.code ? `房间${f.code}` : `房间${idx + 1}`);
    return {
      id: `${buildingName}-${floorNo}-${idx + 1}`,
      buildingName,
      floorNo,
      code: f.code,
      number: f.number,
      name: displayName,
      dept: f.dept,
      usePurpose,
      useArea: f.useArea,
      buildArea: f.buildArea,
      polygon: r.polygon,
      centroid: r.centroid,
      area: r.area,
      inspectStatus,
      useStatus: '',
      remark: assoc.remark ? assoc.remark : undefined,
      selected: true,
      layers: r.entity.layer ? [r.entity.layer] : [],
      unmatchedTexts: assoc.remaining,
    } as ParsedRoom;
  });
}

// ---------------------------------------------------------------------------
// 高层编排：parseDxfToResult
// ---------------------------------------------------------------------------

export interface ParseOptions {
  /** 是否展开块参照（INSERT）及其属性（ATTRIB）。默认 false：整体跳过块参照（噪音来源） */
  expandBlocks?: boolean;
}

export function parseDxfToResult(
  text: string,
  buildingName: string,
  floorNo: number,
  opts?: ParseOptions,
): DxfParseResult {
  const { header, layers, entities } = parseDxf(text);
  const expandBlocks = opts?.expandBlocks ?? false;
  const roleOf = (layer: string): FloorPlanLayerRole => resolveLayerRole(layer);

  const layerRoles: Record<string, FloorPlanLayerRole> = {};
  for (const l of layers) layerRoles[l.name] = roleOf(l.name);

  const frozenSet = new Set(layers.filter((l) => l.frozen).map((l) => l.name));
  const closed = entities.filter(
    (e) =>
      (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') &&
      e.closed &&
      e.points.length >= 3 &&
      !frozenSet.has(e.layer),
  );

  const toClosed = (e: DxfEntity): ClosedPolyline => {
    const polygon = e.points.map((p) => [p[0], p[1]] as [number, number]);
    return {
      polygon,
      centroid: polygonCentroid(polygon),
      area: polygonArea(polygon),
      layer: e.layer,
    };
  };
  const largestByArea = (list: ClosedPolyline[]): ClosedPolyline | null =>
    list.length ? list.reduce((best, cur) => (cur.area > best.area ? cur : best)) : null;

  const floorOutlinePolys = closed.filter((e) => roleOf(e.layer) === 'floorOutline').map(toClosed);
  const floorOutline = largestByArea(floorOutlinePolys);

  const outerWalls = closed.filter((e) => roleOf(e.layer) === 'outerWall').map(toClosed);

  const columnWindowPolys = closed.filter((e) => roleOf(e.layer) === 'columnWindow').map(toClosed);
  const columns: ClosedPolyline[] = [];
  const windows: ClosedPolyline[] = [];
  for (const p of columnWindowPolys) {
    const ln = p.layer.trim().toLowerCase();
    const isWindowLayer = ln.includes('窗') && !ln.includes('柱');
    const isColumnLayer = ln.includes('柱') && !ln.includes('窗');
    if (isWindowLayer) windows.push(p);
    else if (isColumnLayer) columns.push(p);
    else columns.push(p);
  }

  // ---- 坐标来源 / 单位推断（先算，供 extractRooms 面积阈值使用） ----
  const allPts: Pt[] = closed.flatMap((e) => e.points as Pt[]);
  let bboxRaw = bounds(allPts.length ? allPts : []);
  const extMinPair = header['$EXTMIN'] ? header['$EXTMIN'].split(',').map(Number) : null;
  const extMaxPair = header['$EXTMAX'] ? header['$EXTMAX'].split(',').map(Number) : null;
  if (
    (!allPts.length || !Number.isFinite(bboxRaw.minX)) &&
    extMinPair &&
    extMaxPair &&
    Number.isFinite(extMinPair[0]) &&
    Number.isFinite(extMaxPair[0])
  ) {
    bboxRaw = { minX: extMinPair[0], minY: extMinPair[1], maxX: extMaxPair[0], maxY: extMaxPair[1] };
  }
  const unit: LengthUnit = inferUnit(header, bboxRaw);
  const coordSource: CoordSource = detectCoordSource(allPts, unit);

  // 房间提取（双重过滤 + 多文本竞争）交给 extractRooms
  const rooms = extractRooms(entities, layers, unit, {
    buildingName,
    floorNo,
    expandBlocks,
  });

  // 房间字段文本（供未匹配告警 / 标记计算）
  const frozenLayerSet = frozenSet;
  const fieldTextsAll: FieldText[] = entities
    .filter(
      (e) =>
        (e.type === 'TEXT' || e.type === 'MTEXT' || (expandBlocks && e.type === 'ATTRIB')) &&
        e.pos &&
        e.text &&
        !frozenLayerSet.has(e.layer),
    )
    .flatMap((e) => splitMtext(e.text).map((line) => ({ pos: e.pos as [number, number], text: line })));
  // 落在任一房间内的文本（视为已用）
  const usedTexts = new Set<string>();
  for (const room of rooms) {
    for (const t of fieldTextsAll) {
      if (pointInPolygon(t.pos, room.polygon as Pt[])) usedTexts.add(t.text);
    }
  }
  const unmatchedTexts = fieldTextsAll.filter((t) => !usedTexts.has(t.text));

  // ---- 图层（对外结构） ----
  const outLayers: DxfLayer[] = layers.map((l) => ({ name: l.name, color: l.color }));

  // ---- 告警 ----
  const warnings: ParseWarning[] = [];
  // 规则 5：曲线实体计数告警（不得静默丢弃）
  const curveCount = entities.filter((e) => CURVE_TYPES.includes(e.type)).length;
  if (curveCount > 0) {
    warnings.push({
      code: 'CURVE_ENTITY',
      level: 'warn',
      message: `发现曲线实体 ${curveCount} 个，请在 CAD 中将该轮廓转为多段线（LWPOLYLINE / POLYLINE）后重新导出。`,
    });
  }
  // 校验阶段：房间轮廓自交检测（isSelfIntersecting 非相邻边求交），自交轮廓几何不可信
  const selfIntersectRooms = rooms.filter((r) => isSelfIntersecting(r.polygon as Pt[]));
  if (selfIntersectRooms.length > 0) {
    warnings.push({
      code: 'SELF_INTERSECTING',
      level: 'warn',
      message: `有 ${selfIntersectRooms.length} 个房间轮廓存在自交（可能是绘制错误或多段线未闭合），其面积 / 质心可能不准确，请在 CAD 中修正。`,
    });
  }
  if (closed.length === 0) {
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
  // 规则 6：4 个规定图层缺失 → warn（尽力提取）
  const presentRoles = new Set(layers.map((l) => roleOf(l.name)));
  const missing = (
    ['floorOutline', 'outerWall', 'innerWall', 'columnWindow'] as FloorPlanLayerRole[]
  ).filter((r) => !presentRoles.has(r));
  if (missing.length > 0 && missing.length < 4) {
    warnings.push({
      code: 'MISSING_SPEC_LAYERS',
      level: 'warn',
      message: `缺少规定图层：${missing.join('、')}，已按实际存在图层尽力提取。`,
    });
  }
  if (fieldTextsAll.length === 0 && closed.length > 0) {
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
  if (unmatchedTexts.length > 0) {
    warnings.push({
      code: 'UNMATCHED_TEXT',
      level: 'warn',
      message: `有 ${unmatchedTexts.length} 个文字未匹配到房间（如材质 / 注释 / 柱窗标注），已忽略。`,
    });
  }
  const unlabeled = rooms.filter((r) => r.inspectStatus === 'partial').length;
  if (unlabeled > 0) {
    warnings.push({
      code: 'UNLABELED_ROOM',
      level: 'warn',
      message: `有 ${unlabeled} 个房间未匹配到文字标签，已标记为需补填（partial），可在预览页人工补全房间号 / 用途。`,
    });
  }

  return {
    layers: outLayers,
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
