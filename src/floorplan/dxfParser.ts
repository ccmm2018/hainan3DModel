/**
 * 轻量 ASCII DXF 解析器（仅覆盖平面图所需实体，避免引入无类型依赖）。
 *
 * 支持实体：
 *   - LWPOLYLINE        轻量多段线（10/20 成对坐标，70 闭合标志）
 *   - POLYLINE+VERTEX   经典多段线（闭合标志在 POLYLINE 的 70，顶点在 VERTEX 的 10/20）
 *   - TEXT / MTEXT       文字（1 / 3 组码为内容，10/20 为插入点）
 *
 * 解析逻辑：
 *   1. 所有「闭合」多边形视为房间轮廓；
 *   2. 每个房间质心与最近的文字标签匹配，得到房间号 / 名称；
 *   3. 无标签的房间自动编号。
 *
 * 全程使用具体类型与 unknown 收窄，不使用 any。
 */

import type { DxfParseResult, ParsedRoom, RoomVertex } from './types';
import { polygonArea, polygonCentroid, pointInPolygon, dist2 } from './geometry';

interface RawEntity {
  type: 'LWPOLYLINE' | 'POLYLINE' | 'TEXT' | 'MTEXT';
  layer: string;
  points: number[][];
  pos: RoomVertex | null;
  closed: boolean;
  text: string;
}

const ROOM_TYPES = new Set(['LWPOLYLINE', 'POLYLINE', 'TEXT', 'MTEXT']);

/** 去除 MTEXT 常见格式控制符（\P 段落、\px 宽度、花括号等） */
function cleanMtext(raw: string): string {
  return raw
    .replace(/\\px[^;]*;/g, '')
    .replace(/\\p[^;]*;/g, '')
    .replace(/[{}]/g, '')
    .replace(/\\P/gi, '\n')
    .replace(/\\[A-Za-z]+\d*;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLabel(raw: string): string {
  const cleaned = cleanMtext(raw).split('\n')[0]?.trim() ?? '';
  return cleaned;
}

export function parseDxfToRooms(
  text: string,
  buildingName: string,
  floor: number,
): DxfParseResult {
  const lines = text.split(/\r\n|\r|\n/).map((l) => l.trim());
  const n = lines.length;

  const entities: RawEntity[] = [];
  let current: RawEntity | null = null;

  const flush = (): void => {
    if (current) entities.push(current);
    current = null;
  };

  let i = 0;
  while (i < n - 1) {
    const code = lines[i];
    const value = lines[i + 1];
    i += 2;

    if (code === '0') {
      // 遇到新实体：先把已收集的同类实体收尾
      if (
        current &&
        (current.type === 'LWPOLYLINE' ||
          current.type === 'POLYLINE' ||
          current.type === 'TEXT' ||
          current.type === 'MTEXT')
      ) {
        flush();
      } else {
        current = null;
      }
      if (ROOM_TYPES.has(value)) {
        current = { type: value as RawEntity['type'], layer: '', points: [], pos: null, closed: false, text: '' };
      }
      continue;
    }

    if (!current) continue;

    switch (code) {
      case '8': // 图层
        current.layer = value;
        break;
      case '70': // 标志位：POLYLINE / LWPOLYLINE 的 bit0 = 闭合
        if (current.type === 'LWPOLYLINE' || current.type === 'POLYLINE') {
          current.closed = (Number(value) & 1) === 1;
        }
        break;
      case '10': // X 坐标：开启一个新点（或文字插入点）
        if (current.type === 'TEXT' || current.type === 'MTEXT') {
          current.pos = { x: Number(value), y: current.pos?.y ?? 0 };
        } else {
          current.points.push([Number(value), 0]);
        }
        break;
      case '20': // Y 坐标
        if (current.pos) {
          current.pos = { x: current.pos.x, y: Number(value) };
        } else if (current.points.length) {
          current.points[current.points.length - 1][1] = Number(value);
        }
        break;
      case '1': // 文字主内容
        current.text = current.text ? current.text + '\n' + value : value;
        break;
      case '3': // MTEXT 续行
        current.text = current.text ? current.text + '\n' + value : value;
        break;
      default:
        break;
    }
  }
  flush();

  // 房间轮廓：闭合且点数 ≥ 3 的多段线
  const roomEntities = entities.filter(
    (e) =>
      (e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') &&
      e.closed &&
      e.points.length >= 3,
  );

  // 文字标签
  const labels = entities
    .filter((e) => (e.type === 'TEXT' || e.type === 'MTEXT') && e.pos)
    .map((e) => ({ pos: e.pos as RoomVertex, text: normalizeLabel(e.text) }))
    .filter((l) => l.text.length > 0);

  const rooms: ParsedRoom[] = [];
  const warnings: DxfParseResult['warnings'] = [];

  roomEntities.forEach((entity, idx) => {
    const polygon: RoomVertex[] = entity.points.map((p) => ({ x: p[0], y: p[1] }));
    const centroid = polygonCentroid(polygon);
    const area = polygonArea(polygon);

    // 匹配最近的文字标签（优先落在房间内，否则取最近）
    let bestLabel = '';
    let bestDist = Infinity;
    for (const label of labels) {
      const inside = pointInPolygon(label.pos, polygon);
      const d = dist2(label.pos, centroid);
      const score = inside ? d - 1e12 : d; // 落在内部者优先
      if (score < bestDist) {
        bestDist = score;
        bestLabel = label.text;
      }
    }

    const labelled = bestLabel.length > 0;
    const label = labelled ? bestLabel : `房间${idx + 1}`;
    rooms.push({
      id: `${buildingName}-${floor}-${idx + 1}`,
      buildingName,
      floor,
      label,
      polygon,
      centroid,
      area,
      status: 'vacant',
      labelled,
    });
  });

  if (roomEntities.length === 0) {
    warnings.push({ level: 'warn', message: '未识别到闭合的多段线（房间轮廓），请确认 DXF 含闭合 LWPOLYLINE / POLYLINE。' });
  }
  if (labels.length === 0 && roomEntities.length > 0) {
    warnings.push({ level: 'info', message: '图纸中未发现文字标签，房间已按序号自动编号（房间1、房间2…）。' });
  }
  if (labels.length > 0 && rooms.some((r) => !r.labelled)) {
    const unmatched = rooms.filter((r) => !r.labelled).length;
    warnings.push({ level: 'info', message: `有 ${unmatched} 个房间未匹配到文字标签，已自动编号。` });
  }

  // 计算整体包围盒
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rooms) {
    for (const p of r.polygon) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 1;
    maxY = 1;
  }

  return {
    rooms,
    bounds: { minX, minY, maxX, maxY },
    warnings,
  };
}
