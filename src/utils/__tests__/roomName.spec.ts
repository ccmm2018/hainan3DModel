import { describe, it, expect } from 'vitest';
import { cleanName, isAreaLike } from '../roomName';

describe('roomName.cleanName', () => {
  it('空值/空白 → （未命名）', () => {
    expect(cleanName('')).toBe('（未命名）');
    expect(cleanName('   ')).toBe('（未命名）');
    expect(cleanName(null)).toBe('（未命名）');
    expect(cleanName(undefined)).toBe('（未命名）');
  });

  it('面积串入名称（如 "45.2㎡"）显示为（未命名）', () => {
    expect(cleanName('45.2㎡')).toBe('（未命名）');
    expect(cleanName('12.0 m²')).toBe('（未命名）');
    expect(cleanName('8.5m2')).toBe('（未命名）');
  });

  it('纯小数面积串入名称显示为（未命名）', () => {
    expect(cleanName('2.3')).toBe('（未命名）');
    expect(cleanName('45.2')).toBe('（未命名）');
  });

  it('用户手动填写的纯数字房名应原样显示（不再被归一为未命名）', () => {
    expect(cleanName('101')).toBe('101');
    expect(cleanName('102')).toBe('102');
    expect(cleanName('3')).toBe('3');
  });

  it('正常名称原样返回', () => {
    expect(cleanName('会议室')).toBe('会议室');
    expect(cleanName(' 大会议室 ')).toBe('大会议室');
    expect(cleanName('研发部开放区')).toBe('研发部开放区');
  });

  it('isAreaLike 判定', () => {
    expect(isAreaLike('45.2㎡')).toBe(true);
    expect(isAreaLike('面积45.2')).toBe(true);
    expect(isAreaLike('约 60')).toBe(true);
    expect(isAreaLike('2.3')).toBe(true);
    // 纯整数房号/房名不是面积，允许作为名称展示
    expect(isAreaLike('101')).toBe(false);
    expect(isAreaLike('会议室')).toBe(false);
    expect(isAreaLike('')).toBe(false);
  });
});
