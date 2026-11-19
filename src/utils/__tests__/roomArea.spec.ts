import { describe, it, expect } from 'vitest';
import { unassignedArea, formatUnassignedArea, isAreaOrderValid } from '../roomArea';

describe('unassignedArea', () => {
  it('建筑>使用且都填写：返回正差额', () => {
    expect(unassignedArea(45, 50)).toBeCloseTo(5);
    expect(unassignedArea(90, 100)).toBeCloseTo(10);
  });

  it('使用>建筑（脏数据）：返回 null，不展示负数', () => {
    expect(unassignedArea(60, 50)).toBeNull();
  });

  it('两者相等：返回 null，不展示 0㎡', () => {
    expect(unassignedArea(50, 50)).toBeNull();
  });

  it('任一面积未填(0)或缺失：返回 null', () => {
    expect(unassignedArea(0, 50)).toBeNull();
    expect(unassignedArea(45, 0)).toBeNull();
    expect(unassignedArea(0, 0)).toBeNull();
  });

  it('浮点噪声差额(<0.01㎡)：返回 null，避免显示 0.00㎡', () => {
    expect(unassignedArea(49.999999, 50)).toBeNull();
    expect(unassignedArea(50, 50.004)).toBeNull();
  });

  it('小数差额正常返回', () => {
    expect(unassignedArea(45.5, 50.25)).toBeCloseTo(4.75);
  });
});

describe('formatUnassignedArea', () => {
  it('有差额：格式化为「未分配 X㎡」', () => {
    expect(formatUnassignedArea(5)).toBe('未分配 5.00㎡');
    expect(formatUnassignedArea(4.75)).toBe('未分配 4.75㎡');
  });

  it('无差额(null)：返回空串，配合 v-if 隐藏', () => {
    expect(formatUnassignedArea(null)).toBe('');
  });

  it('支持自定义小数位', () => {
    expect(formatUnassignedArea(4.756, 1)).toBe('未分配 4.8㎡');
  });
});

describe('isAreaOrderValid', () => {
  it('建筑>使用：合法', () => {
    expect(isAreaOrderValid(45, 50)).toBe(true);
    expect(isAreaOrderValid(90, 100)).toBe(true);
  });

  it('两者相等：合法', () => {
    expect(isAreaOrderValid(50, 50)).toBe(true);
  });

  it('使用>建筑：非法（避免未分配为负）', () => {
    expect(isAreaOrderValid(60, 50)).toBe(false);
    expect(isAreaOrderValid(51, 50.5)).toBe(false);
  });

  it('只填使用、建筑留空(0)：非法，需补填建筑', () => {
    expect(isAreaOrderValid(50, 0)).toBe(false);
  });

  it('只填建筑、使用留空：合法（无从比较）', () => {
    expect(isAreaOrderValid(0, 100)).toBe(true);
  });

  it('两者都未填：合法', () => {
    expect(isAreaOrderValid(0, 0)).toBe(true);
  });

  it('0.01㎡ 内四舍五入噪声：合法', () => {
    expect(isAreaOrderValid(50, 49.995)).toBe(true);
  });

  it('接受字符串输入（表单 v-model 是字符串）', () => {
    expect(isAreaOrderValid('60', '50')).toBe(false);
    expect(isAreaOrderValid('45.5', '50.25')).toBe(true);
  });
});
