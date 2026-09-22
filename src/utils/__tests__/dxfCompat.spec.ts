import { describe, it, expect } from 'vitest';
import { decodeDxf } from '../coordinate';
import { parseDxfToResult } from '../dxfParser';
import { validateDxf } from '../dxfValidate';
import { SAMPLE_DXF_DIRTY } from '../../mock/mockData';

/**
 * 把字符串按 GBK 编码为二进制（模拟真实 GBK 编码 DXF 的字节）。
 * Node 运行时 Buffer 为全局可用；此处用 globalThis 引用以绕开 @types/node 缺失。
 */
function toGbkBytes(str: string): ArrayBuffer {
  const g = globalThis as unknown as {
    Buffer: { from(s: string, enc: string): { buffer: ArrayBuffer; byteOffset: number; byteLength: number } };
  };
  const buf = g.Buffer.from(str, 'gbk');
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe('脏图纸兼容（MTEXT + GBK + 未闭合轮廓）', () => {
  it('GBK 字节可解码且不崩溃（ASCII 结构标记在 GBK 下无损）', async () => {
    const ab = toGbkBytes(SAMPLE_DXF_DIRTY);
    const text = await decodeDxf(ab);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    // ASCII 标记在 UTF-8 / GBK 下字节一致，必能还原，可用于探测编码
    expect(text).toContain('MTEXT');
    expect(text).toContain('LWPOLYLINE');
  });

  it('未闭合轮廓被静默丢弃并产出 NO_FLOOR_OUTLINE 告警（不崩溃）', () => {
    const parsed = parseDxfToResult(SAMPLE_DXF_DIRTY, '脏图纸', 1);
    expect(parsed.floorOutline).toBeNull();
    const codes = parsed.warnings.map((w) => w.code);
    expect(codes).toContain('NO_FLOOR_OUTLINE');
  });

  it('MTEXT 多行字段 + TEXT 混合解析出房间（101 / 102），自交环触发 SELF_INTERSECTING', () => {
    const parsed = parseDxfToResult(SAMPLE_DXF_DIRTY, '脏图纸', 1);
    const codes = parsed.rooms.map((r) => r.code);
    expect(codes).toContain('101');
    expect(codes).toContain('102');
    const warnCodes = parsed.warnings.map((w) => w.code);
    expect(warnCodes).toContain('SELF_INTERSECTING');
  });

  it('C4 闭合性校验给出 warn 且不阻断（hasError=false）', () => {
    const parsed = parseDxfToResult(SAMPLE_DXF_DIRTY, '脏图纸', 1);
    const res = validateDxf(parsed);
    expect(res.hasError).toBe(false);
    const c4 = res.checks.find((c) => c.code === 'C4');
    expect(c4).toBeTruthy();
    expect(c4!.level).toBe('warn');
    expect(res.closureProblemCount).toBeGreaterThanOrEqual(1);
  });
});
