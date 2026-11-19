import { describe, it, expect } from 'vitest';
import { estimateTextWidth, fitLabelText } from '../labelFit';

describe('estimateTextWidth', () => {
  it('全角中文按 1em 计宽', () => {
    expect(estimateTextWidth('房间名称', 10)).toBe(40);
  });

  it('纯数字窄于同数量中文', () => {
    expect(estimateTextWidth('1234', 10)).toBeLessThan(estimateTextWidth('房间名称', 10));
  });

  it('空串宽度为 0', () => {
    expect(estimateTextWidth('', 12)).toBe(0);
  });
});

describe('fitLabelText', () => {
  it('放得下时原文返回、字号不变、未截断', () => {
    const r = fitLabelText('101', 100, 16, 7);
    expect(r.text).toBe('101');
    expect(r.size).toBe(16);
    expect(r.truncated).toBe(false);
    expect(r.full).toBe('101');
  });

  it('放不下时先缩小字号，能够则完整显示且不截断', () => {
    // '房间名称' 4 字 ×10 = 40px；给 22px → 字号需缩到 ~5.5，但下限 7 → 触发截断，
    // 所以这里用一个较宽的可用宽验证“缩小即可放下”的分支。
    const r = fitLabelText('房间', 15, 10, 7); // 2 字 ×10=20>15；×7.5=15 恰好
    expect(r.truncated).toBe(false);
    expect(r.text).toBe('房间');
    expect(r.size).toBeLessThan(10);
    expect(r.size).toBeGreaterThanOrEqual(7);
  });

  it('缩到字号下限仍放不下则截断并加省略号', () => {
    const r = fitLabelText('多媒体教室与实验实训中心', 30, 12, 7);
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith('…')).toBe(true);
    expect(r.size).toBe(7);
    expect(r.full).toBe('多媒体教室与实验实训中心');
    expect(estimateTextWidth(r.text, r.size)).toBeLessThanOrEqual(30);
  });

  it('极窄宽度下至少保留省略号，不溢出', () => {
    const r = fitLabelText('abcdef', 5, 12, 7);
    expect(r.truncated).toBe(true);
    expect(estimateTextWidth(r.text, r.size)).toBeLessThanOrEqual(5);
  });

  it('空文本安全返回', () => {
    const r = fitLabelText('', 50, 12, 7);
    expect(r.text).toBe('');
    expect(r.truncated).toBe(false);
  });

  it('可用宽度非正数时原样返回', () => {
    const r = fitLabelText('101', 0, 12, 7);
    expect(r.text).toBe('101');
    expect(r.truncated).toBe(false);
  });
});
