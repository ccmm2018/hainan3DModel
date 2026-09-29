/**
 * 房间名称展示辅助：把"面积 / 纯房号"之类被误当成名称的数值文本归一为「（未命名）」。
 * - DXF 导入时，离房间质心最近的文本若为面积数字（如 "45.2㎡"），会被误当作 room.name；
 * - 已入库的历史脏数据也沿用此规则，无需重新导入即可在界面正确显示。
 */

/** 判定字符串是否为「纯面积 / 纯数字（房号）」之类不应作为名称展示的取值 */
export function isAreaLike(s: string | undefined | null): boolean {
  const t = (s ?? '').trim();
  if (!t) return false;
  // 纯数字（房号）
  if (/^[\d.]+$/.test(t)) return true;
  // 带 ㎡/m²/m2 的面积
  if (/[\d.]+\s*(㎡|m²|m2|M²|M2)/.test(t)) return true;
  // 含「平方米 / 平米 / 平方」等面积单位
  if (/(平方米|平米|平方)/.test(t)) return true;
  // 含「面积」字样（如「面积45.2」）
  if (/面积/.test(t)) return true;
  // 约/大概 开头且核心为数字的近似面积（如「约 45.2」「大概60」）
  if (/^(约|大概|大约|估计)?\s*[\d.]+\s*(㎡|m²|m2|平方米|平米)?$/.test(t)) return true;
  return false;
}

/** 展示用房间名称：空值或面积/房号类数值 → 返回「（未命名）」，其余原样返回 */
export function cleanName(raw: string | undefined | null): string {
  const t = (raw ?? '').trim();
  if (!t) return '（未命名）';
  if (isAreaLike(t)) return '（未命名）';
  return t;
}
