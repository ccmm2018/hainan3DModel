/**
 * 房间名称展示辅助：把「面积文本」归一为「（未命名）」，但保留用户手动填写的纯房号 / 房名。
 * - DXF 导入时，离房间质心最近的文本若为面积数字（如 "45.2㎡"），会被误当作 room.name；这类应隐藏。
 * - 但用户明确把房间命名为纯数字（如 "101"、"102"）时，这是合法的房名，必须照常显示，
 *   不能再被归一为「（未命名）」（之前的实现因 /^[\d.]+$/ 把纯数字也判成面积，导致改名后标题仍显示未命名）。
 */

/** 判定字符串是否为「面积文本」之类不应作为名称展示的取值（纯房号 / 房名除外） */
export function isAreaLike(s: string | undefined | null): boolean {
  const t = (s ?? '').trim();
  if (!t) return false;
  // 带 ㎡/m²/m2 的面积（含数字，如 "45.2㎡"）
  if (/[\d.]+\s*(㎡|m²|m2|M²|M2)/i.test(t)) return true;
  // 含「平方米 / 平米 / 平方 / 面积」等面积关键字（如「面积45.2」「约 60 平方米」）
  if (/(平方米|平米|平方|面积)/.test(t)) return true;
  // 以「约/大概/大约/估计」开头的近似面积表达（如「约45.2」「大概 60」）
  if (/^(约|大概|大约|估计)\s*[\d.]+$/.test(t)) return true;
  // 纯小数（含小数点、无单位）—— 多为导入时误入的面积值（如「45.2」），仍视为未命名
  if (/^\d+\.\d+$/.test(t)) return true;
  // 注意：纯整数（如「101」「102」）视为房间号 / 房名，允许作为名称展示，不再归一为未命名
  return false;
}

/** 展示用房间名称：空值或面积/房号类数值 → 返回「（未命名）」，其余原样返回 */
export function cleanName(raw: string | undefined | null): string {
  const t = (raw ?? '').trim();
  if (!t) return '（未命名）';
  if (isAreaLike(t)) return '（未命名）';
  return t;
}
