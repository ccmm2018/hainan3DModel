import { describe, it, expect } from 'vitest';
import { decodeDxf } from '../coordinate';
import { parseDxfToResult } from '../dxfParser';
import { validateDxf } from '../dxfValidate';
import { SAMPLE_DXF_DIRTY } from '../../mock/mockData';

/**
 * 把字符串编码为 GBK 二进制（模拟真实 GBK 编码 DXF 的字节）。
 * 注意：本机 Node 的 Buffer 不支持 'gbk' 编码名，故此处用手写最小映射表，
 * 仅覆盖测试需要的若干汉字；ASCII 字符（<0x80）字节不变。
 */
const GBK_MAP: Record<string, number[]> = {
  教: [0xbd, 0xcc],
  学: [0xd1, 0xa7],
  楼: [0xc2, 0xa5],
};
function toGbkBytes(str: string): ArrayBuffer {
  const bytes: number[] = [];
  for (const ch of str) {
    if (ch.charCodeAt(0) < 0x80) bytes.push(ch.charCodeAt(0));
    else if (GBK_MAP[ch]) bytes.push(...GBK_MAP[ch]);
    else bytes.push(0x3f); // 无法映射的字符降级为 '?'
  }
  const ab = new ArrayBuffer(bytes.length);
  new Uint8Array(ab).set(bytes);
  return ab;
}

describe('脏图纸兼容（MTEXT + GBK + 未闭合轮廓）', () => {
  it('GBK 字节可解码且不崩溃（中文标签被正确还原，ASCII 结构标记无损）', async () => {
    // 用含中文「教学楼」的片段构造 GBK 字节，验证 decodeDxf 走 GBK 解码且不崩溃
    const ab = toGbkBytes('0\nSECTION\n2\nENTITIES\n0\nMTEXT\n1\n教学楼\n0\nENDSEC');
    const text = await decodeDxf(ab);
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('MTEXT'); // ASCII 标记无损
    expect(text).toContain('教学楼'); // GBK 中文被正确还原
  });

  it('未闭合轮廓被静默丢弃并产出 NO_FLOOR_OUTLINE 告警（不崩溃）', () => {
    const parsed = parseDxfToResult(SAMPLE_DXF_DIRTY, '脏图纸', 1);
    expect(parsed.floorOutline).toBeNull();
    const codes = parsed.warnings.map((w) => w.code);
    expect(codes).toContain('NO_FLOOR_OUTLINE');
  });

  it('MTEXT 多行字段 + TEXT 混合解析出房间（A101 / 102），自交环触发 SELF_INTERSECTING', () => {
    const parsed = parseDxfToResult(SAMPLE_DXF_DIRTY, '脏图纸', 1);
    const codes = parsed.rooms.map((r) => r.code);
    // MTEXT「房间编码: A101」经字段规则提取出 'A101'；TEXT 直接为 '102'
    expect(codes).toContain('A101');
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
