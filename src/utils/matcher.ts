/**
 * 文本标签 ↔ 房间匹配，以及楼栋名模糊匹配。
 * 不使用 any。
 */

import { dist2, pointInPolygon, type Pt } from './geometry';

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
