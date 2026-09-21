import { describe, expect, it } from 'vitest';
import { parseDxfToResult } from '../dxfParser';

/**
 * 含家具块参照（INSERT + ATTRIB）的图纸：房间在 (0,0)-(5000,5000)（≈25㎡，高于 5㎡ 阈值），
 * 块参照放在房间外 (8000,8000)，不会干扰房间识别。
 */
const SAMPLE_WITH_INSERT = `0
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
5000
10
0
20
5000
0
TEXT
8
内部结构内墙线
10
2500
20
2500
1
101
0
INSERT
8
家具
2
CHAIR
10
8000
20
8000
0
ATTRIB
8
家具
10
8000
20
8000
1
沙发
0
ENDSEC
0
EOF
`;

/**
 * 房间内只放一个块参照（INSERT + ATTRIB "305"），用于验证 expandBlocks 开关。
 * 房间 (0,0)-(5000,5000)；块参照在房间内 (2500,2500)。
 */
const SAMPLE_INSERT_ONLY = `0
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
5000
10
0
20
5000
0
INSERT
8
家具
2
DESK
10
2500
20
2500
0
ATTRIB
8
家具
10
2500
20
2500
1
305
0
ENDSEC
0
EOF
`;

describe('dxfParser 块参照（INSERT/ATTRIB）', () => {
  it('默认整体跳过 INSERT/ATTRIB（噪音来源）', () => {
    const r = parseDxfToResult(SAMPLE_WITH_INSERT, '教学楼', 1);
    // 房间仍被正确识别
    expect(r.rooms.length).toBe(1);
    expect(r.rooms[0].code).toBe('101');
    // 块参照未污染房间字段（文字标签只有房间内的 "101"，无 INSERT/ATTRIB 泄露）
    expect(r.rooms[0].name).toContain('101');
  });

  it('expandBlocks=false：房间内只有块属性时无标签，标记为需补填（partial）', () => {
    const r = parseDxfToResult(SAMPLE_INSERT_ONLY, '教学楼', 1, { expandBlocks: false });
    expect(r.rooms.length).toBe(1);
    const room = r.rooms[0];
    expect(room.code).toBe('');
    expect(room.inspectStatus).toBe('partial');
  });

  it('expandBlocks=true：保留块属性文字作为房间字段', () => {
    const r = parseDxfToResult(SAMPLE_INSERT_ONLY, '教学楼', 1, { expandBlocks: true });
    expect(r.rooms.length).toBe(1);
    const room = r.rooms[0];
    expect(room.code).toBe('305');
    expect(room.inspectStatus).toBe('normal');
  });
});
