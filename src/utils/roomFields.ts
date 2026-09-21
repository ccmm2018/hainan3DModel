import type { ParsedRoom } from '../types/cad';

/**
 * 房间字段完整性判定（预览确认步骤统计用）。
 *
 * 以「房间编码 + 房间名称」均非空作为完整标准：
 * DXF 通常无法提供部门 / 面积，故不纳入强制完整判定（避免几乎所有房间都被标「待补填」）。
 * 这与解析阶段的 inspectStatus==='partial'（缺文字标签）语义一致。
 */
export function isRoomFieldComplete(r: ParsedRoom): boolean {
  return r.code.trim() !== '' && r.name.trim() !== '';
}
