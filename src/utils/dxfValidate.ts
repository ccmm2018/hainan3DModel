/**
 * DXF 导入「步骤 2 校验」独立校验模块（C1–C6）。
 *
 * 设计要点：
 *   - 区分「硬错误 error」与「软警告 warn / 提示 info」；只有 error 才阻断向导前进。
 *   - 纯函数、无 DOM 依赖、不抛异常，便于单测与 Worker 复用。
 *   - 校验输入是「已解析的 DxfParseResult」+ 原始字节（C1 编码探测需要）；
 *     坐标来源 C6 取「用户覆盖值 ?? 自动识别值」（与向导内单选联动）。
 *
 * 校验项（与规范一一对应）：
 *   C1 编码：自动探测解码，解码失败 / 非 DXF 文本 = error。
 *   C2 图层：4 个规定图层缺失 = warn（列出缺哪个，允许继续，结果可能 partial）。
 *   C3 单位：自动推断；unknown = warn。
 *   C4 闭合：轮廓存在未闭合 / 自交 / 重复点 = warn，列出问题轮廓数量。
 *   C5 文本：一个房间字段都没有 = warn（房间将无名称，可稍后补填）。
 *   C6 坐标：UTM 量级 → 标记 utm（可自动匹配）；否则 local（走手动配准，提示、非错误）。
 */
import type { CoordSource, DxfParseResult, FloorPlanLayerRole } from '../types/cad';
import { isSelfIntersecting, type Pt } from './geometry';

/** 校验项代码 */
export type ValidationCode = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6';

/** 校验项级别：ok=通过 / error=硬错误（阻断） / warn=软警告（可继续） / info=提示（不阻断） */
export type CheckLevel = 'ok' | 'error' | 'warn' | 'info';

/** 单条校验结果 */
export interface CheckResult {
  code: ValidationCode;
  level: CheckLevel;
  message: string;
}

/** 校验总结果 */
export interface DxfValidation {
  checks: CheckResult[];
  /** 是否存在硬错误（阻断向导） */
  hasError: boolean;
  /** 是否存在软警告 */
  hasWarn: boolean;
  /** 生效坐标来源（覆盖值 ?? 自动识别） */
  coordSource: CoordSource;
  /** C2：缺失的规定图层 */
  missingLayers: FloorPlanLayerRole[];
  /** C4：存在几何问题的轮廓数量 */
  closureProblemCount: number;
  /** C5：无任何字段的房间数量 */
  emptyRoomCount: number;
}

/** 4 个规定图层角色（按「楼栋平面图含 4 个图层」规范） */
export const REQUIRED_LAYER_ROLES: readonly FloorPlanLayerRole[] = [
  'floorOutline',
  'outerWall',
  'innerWall',
  'columnWindow',
];

/** 规定图层角色 → 中文展示名（用于校验提示） */
export const LAYER_ROLE_LABELS: Record<FloorPlanLayerRole, string> = {
  floorOutline: '楼层外轮廓线',
  outerWall: '内部结构外墙线',
  innerWall: '内部结构内墙线',
  columnWindow: '柱子及窗户线',
  other: '其它',
};

/**
 * 同步、编码无关的「是否为 DXF 文件」结构探测。
 *
 * 原理：合法 DXF（无论 UTF-8 / GBK / UTF-16LE）必含结构标记 SECTION / EOF / AcDb。
 *   - UTF-16LE（BOM 0xFF 0xFE）：标记字符以「ASCII 字节 + 0x00」交替存储，逐宽字节读取 ASCII 即可。
 *   - UTF-8 / GBK：ASCII 标记字节与字符码一致，非 ASCII 字节视作空格后检索即可。
 * 该方法不依赖具体编码解码器、不抛异常，能在「解码成功但内容非 DXF（乱码/错格式）」时
 * 仍能识别为「无法识别」，从而触发 C1 硬错误。
 */
export function isLikelyDxfBuffer(buf: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buf);
  if (bytes.length < 6) return false;

  // UTF-16LE BOM
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i]);
    return /\bSECTION\b|\bEOF\b|AcDb/i.test(s);
  }

  // UTF-8 / GBK：仅保留可打印 ASCII（0x20–0x7E），非 ASCII 字节视作空格
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ' ';
  }
  return /\bSECTION\b|\bEOF\b|AcDb/i.test(s);
}

/**
 * 轮廓是否存在「内部」重复相邻点（忽略闭合末点=首点的情形）。
 * 注意：解析器会把端点近重合的闭合多段线吸附成「末点==首点」，因此必须跳过
 * 末点↔首点的环绕边，否则任意正常闭合环都会被误判为重复点。
 */
function hasDuplicatePoints(poly: Pt[]): boolean {
  const n = poly.length;
  if (n < 2) return false;
  // 仅检查内部连续相邻点对，不检查末点→首点的环绕边
  for (let i = 0; i < n - 1; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) return true;
  }
  return false;
}

/**
 * 统计存在几何问题的轮廓数量（自交 / 内部重复点）。
 *
 * 说明：解析器只产出「已闭合」实体（由 flags / 端点近重合判定），因此「未闭合」在解析结果中
 * 通常不可见；本函数聚焦可稳定判定的两类真实问题——自交与内部重复点。若未来扩展到原始实体，
 * 可在此加入端点开口判定。
 */
function countClosureProblems(parsed: DxfParseResult): number {
  const polys: Pt[][] = [];
  if (parsed.floorOutline) polys.push(parsed.floorOutline.polygon as Pt[]);
  for (const o of parsed.outerWalls) polys.push(o.polygon as Pt[]);
  for (const c of parsed.columns) polys.push(c.polygon as Pt[]);
  for (const w of parsed.windows) polys.push(w.polygon as Pt[]);
  for (const r of parsed.rooms) polys.push(r.polygon as Pt[]);

  let count = 0;
  for (const p of polys) {
    if (p.length < 3) {
      count += 1;
      continue;
    }
    if (isSelfIntersecting(p) || hasDuplicatePoints(p)) count += 1;
  }
  return count;
}

export interface ValidateOptions {
  /** 原始字节（C1 编码探测需要；缺失则跳过 C1） */
  buffer?: ArrayBuffer;
  /** 规定图层角色（默认 REQUIRED_LAYER_ROLES） */
  requiredRoles?: readonly FloorPlanLayerRole[];
  /** 生效坐标来源覆盖（用户手动切换 utm/local）；缺省用 parsed.coordSource */
  coordSourceOverride?: CoordSource;
}

/**
 * 对一份已解析的 DXF 做「步骤 2 校验」，返回 C1–C6 清单。
 * 不抛异常；任意输入都返回结构化结果。
 */
export function validateDxf(parsed: DxfParseResult, opts: ValidateOptions = {}): DxfValidation {
  const checks: CheckResult[] = [];

  // ---- C1 编码 ----
  let c1: CheckResult;
  if (opts.buffer !== undefined) {
    if (!isLikelyDxfBuffer(opts.buffer)) {
      c1 = { code: 'C1', level: 'error', message: '文件编码无法识别，请另存为 UTF-8/GBK DXF' };
    } else {
      c1 = { code: 'C1', level: 'ok', message: '文件编码识别正常，可继续解析' };
    }
  } else {
    c1 = { code: 'C1', level: 'ok', message: '（无原始字节，跳过编码校验）' };
  }
  checks.push(c1);

  // ---- C2 图层 ----
  const required = opts.requiredRoles ?? REQUIRED_LAYER_ROLES;
  const present = new Set(Object.values(parsed.layerRoles));
  const missing = required.filter((r) => !present.has(r));
  if (missing.length > 0) {
    const names = missing.map((r) => LAYER_ROLE_LABELS[r]).join('、');
    checks.push({
      code: 'C2',
      level: 'warn',
      message: `缺少规定图层：${names}，已按实际图层尽力提取（结果可能 partial）`,
    });
  } else {
    checks.push({ code: 'C2', level: 'ok', message: '4 个规定图层齐全' });
  }

  // ---- C3 单位 ----
  if (parsed.unit === 'unknown') {
    checks.push({
      code: 'C3',
      level: 'warn',
      message: '无法判断单位（既不是米也不是毫米），请确认图纸单位（米/毫米）',
    });
  } else {
    checks.push({
      code: 'C3',
      level: 'ok',
      message: `单位已识别为 ${parsed.unit === 'm' ? '米' : parsed.unit === 'mm' ? '毫米' : parsed.unit}`,
    });
  }

  // ---- C4 闭合 ----
  const closureCount = countClosureProblems(parsed);
  if (closureCount > 0) {
    checks.push({
      code: 'C4',
      level: 'warn',
      message: `有 ${closureCount} 个轮廓存在未闭合/自交/重复点，其面积/质心可能不准确`,
    });
  } else {
    checks.push({ code: 'C4', level: 'ok', message: '轮廓闭合性正常' });
  }

  // ---- C5 文本 ----
  const emptyRooms = parsed.rooms.filter(
    (r) => !r.name && !r.code && !r.number && !r.dept && r.useArea === 0 && r.buildArea === 0,
  ).length;
  if (emptyRooms > 0) {
    checks.push({
      code: 'C5',
      level: 'warn',
      message: `有 ${emptyRooms} 个房间未识别到任何字段，将无名称，可在预览确认步骤稍后补填`,
    });
  } else {
    checks.push({ code: 'C5', level: 'ok', message: '房间字段识别正常' });
  }

  // ---- C6 坐标 ----
  const coordSource: CoordSource = opts.coordSourceOverride ?? parsed.coordSource;
  if (coordSource === 'utm') {
    checks.push({
      code: 'C6',
      level: 'info',
      message: '坐标识别为 UTM 49N（米量级），可自动匹配楼栋指纹',
    });
  } else {
    checks.push({
      code: 'C6',
      level: 'info',
      message: '坐标识别为局部坐标，将走手动配准（2 对同名锚点），不影响入库',
    });
  }

  return {
    checks,
    hasError: checks.some((c) => c.level === 'error'),
    hasWarn: checks.some((c) => c.level === 'warn'),
    coordSource,
    missingLayers: missing,
    closureProblemCount: closureCount,
    emptyRoomCount: emptyRooms,
  };
}
