import { describe, it, expect } from 'vitest';
import { estimateTextWidth, fitLabelText, fitVerticalLayout } from '../labelFit';

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

  it('baseSize 小于 minSize 时不被反向放大（5行压缩排版的场景）', () => {
    const r = fitLabelText('未分配 5㎡', 100, 6, 8);
    expect(r.size).toBe(6); // 应保持压缩后的小字号，而不是被抬回 8
  });
});

describe('fitVerticalLayout', () => {
  it('4 行沿用原算法（gap=roomHpx*0.21 夹到≥8）', () => {
    const l = fitVerticalLayout(60, 4);
    expect(l.gap).toBeCloseTo(12.6);
    expect(l.sizeNumber).toBeCloseTo(11.97);
    expect(l.sizeOther).toBeCloseTo(7.812);
  });

  it('顶面很矮时 4 行 gap 兜到 8', () => {
    expect(fitVerticalLayout(10, 4).gap).toBe(8);
  });

  it('5 行时行距压缩：文字块总高不超过原 4 行总高', () => {
    const h = 60;
    const l4 = fitVerticalLayout(h, 4);
    const l5 = fitVerticalLayout(h, 5);
    expect(l5.gap).toBeLessThan(l4.gap);
    // 文字块高度 ≈ (行数-1)*gap + 字号，5 行应 ≤ 4 行
    const block4 = 3 * l4.gap + l4.sizeNumber;
    const block5 = 4 * l5.gap + l5.sizeNumber;
    expect(block5).toBeLessThanOrEqual(block4 + 0.01);
  });

  it('5 行字号同步缩小', () => {
    const l4 = fitVerticalLayout(60, 4);
    const l5 = fitVerticalLayout(60, 5);
    expect(l5.sizeNumber).toBeLessThanOrEqual(l4.sizeNumber);
    expect(l5.sizeOther).toBeLessThanOrEqual(l4.sizeOther);
  });

  it('5 行时顶面高度兜底：文字块不超过顶面 90% + 字号', () => {
    const h = 30;
    const l5 = fitVerticalLayout(h, 5);
    // byHeight = h*0.9/(5-1)，保证 4*gap ≤ h*0.9
    expect(4 * l5.gap).toBeLessThanOrEqual(h * 0.9 + 0.01);
  });

  it('子房行距与字号再收一档', () => {
    const normal = fitVerticalLayout(60, 5, false);
    const sub = fitVerticalLayout(60, 5, true);
    expect(sub.gap).toBeLessThan(normal.gap);
    expect(sub.sizeNumber).toBeLessThan(normal.sizeNumber);
  });

  it('顶面高度为 0 / 负数不产生 NaN', () => {
    const l = fitVerticalLayout(0, 5);
    expect(Number.isFinite(l.gap)).toBe(true);
    expect(Number.isFinite(l.sizeNumber)).toBe(true);
    expect(Number.isFinite(l.sizeOther)).toBe(true);
  });
});
