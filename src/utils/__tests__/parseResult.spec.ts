import { describe, it, expect } from 'vitest';
import { parseDxfToResult } from '../dxfParser';
import type { DxfParseResult } from '../../types/cad';

/**
 * 步骤3 解析契约：Worker 内 extractRooms（经 parseDxfToResult 编排）返回的 DxfParseResult
 * 必须包含解析结果向用户呈现所需的字段：rooms / warnings / bbox / coordSource / unit。
 *
 * 最小合法 DXF：$INSUNITS=4（毫米），「内部结构内墙线」含 1 个闭合房间 (0,0)-(5000,4000)，
 * 房间内 TEXT "101"。期望 unit=mm、coordSource=local、1 个房间。
 */
const MINIMAL_DXF = `0
SECTION
2
HEADER
9
$INSUNITS
70
4
0
ENDSEC
0
SECTION
2
TABLES
0
TABLE
2
LAYER
0
LAYER
2
内部结构内墙线
70
0
0
ENDTAB
0
ENDSEC
0
SECTION
2
ENTITIES
0
LWPOLYLINE
8
内部结构内墙线
70
1
10
0
20
0
10
5000
20
0
10
5000
20
4000
10
0
20
4000
0
TEXT
8
内部结构内墙线
10
2500
20
2000
1
101
0
ENDSEC
0
EOF
`;

describe('步骤3 解析：Worker extractRooms 返回 DxfParseResult 契约', () => {
  const res = parseDxfToResult(MINIMAL_DXF, '教学楼', 1, {});

  it('返回完整 DxfParseResult（含 rooms / warnings / bbox / coordSource / unit）', () => {
    expect(res).toBeDefined();
    expect(Array.isArray(res.rooms)).toBe(true);
    expect(Array.isArray(res.warnings)).toBe(true);
    expect(res.bbox).toEqual(
      expect.objectContaining({
        minX: expect.any(Number),
        minY: expect.any(Number),
        maxX: expect.any(Number),
        maxY: expect.any(Number),
      }),
    );
    expect(['utm', 'local']).toContain(res.coordSource);
    expect(['m', 'cm', 'mm', 'unknown']).toContain(res.unit);
  });

  it('warnings 元素结构正确（code / level / message）', () => {
    for (const w of res.warnings) {
      expect(typeof w.code).toBe('string');
      expect(['error', 'warn']).toContain(w.level);
      expect(typeof w.message).toBe('string');
    }
  });

  it('coordSource / unit 与图纸特征一致（毫米图纸 → local + mm）', () => {
    expect(res.unit).toBe('mm');
    expect(res.coordSource).toBe('local');
    expect(res.rooms.length).toBe(1);
    expect(res.rooms[0].code).toBe('101');
  });

  it('bbox 反映原始坐标包围盒尺寸', () => {
    expect(res.bbox.maxX - res.bbox.minX).toBeCloseTo(5000);
    expect(res.bbox.maxY - res.bbox.minY).toBeCloseTo(4000);
  });
});
