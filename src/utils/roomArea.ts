/**
 * 房间「未分配面积」口径（只读展示，不参与拆分 / 合并的面积校验）。
 *
 * 未分配面积 = 建筑面积 − 使用面积。它是同一个矩形空间的两种口径之差，
 * 不是一块独立地块，也不代表面积丢失：房间「只用这么多」是实际可用量的选择，
 * 建筑面积里未被登记为使用面积的部分，中性归为「未分配」，只做明确展示。
 *
 * 仅当「建筑面积、使用面积都填写(>0)且建筑面积 > 使用面积」时才展示；
 * 缺任一面积、面积相等、建筑 < 使用等脏数据一律返回 null（不展示）。
 */
export function unassignedArea(useArea: number, buildArea: number): number | null {
  const use = Number(useArea) || 0;
  const build = Number(buildArea) || 0;
  if (use <= 0 || build <= 0) return null;
  const gap = build - use;
  // 容差 0.005：滤掉浮点噪声（如 50.00 − 49.999999），不足 0.01㎡ 的差额不展示
  return gap > 0.005 ? gap : null;
}

/** 把未分配面积格式化为展示文本；null → 空串（配合 v-if 隐藏该行）。 */
export function formatUnassignedArea(v: number | null, digits = 2): string {
  return v === null ? '' : `未分配 ${v.toFixed(digits)}㎡`;
}
