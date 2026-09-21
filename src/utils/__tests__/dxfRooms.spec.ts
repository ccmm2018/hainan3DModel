import { describe, expect, it } from 'vitest';
import { parseDxf, parseDxfToResult, isClosedPolyline, entityPoints, extractRooms } from '../dxfParser';

/**
 * 多文本竞争：一个房间（(0,0)-(5000,4000)，质心 (2500,2000)）内放 4 个独立 TEXT，
 * 分别位于不同位置，验证「按到质心距离竞争回填」：
 *   - 离质心最近（恰好在质心）→ 房间名称
 *   - 纯数字 → 房间号码 / 编码
 *   - 带 ㎡ → 使用面积
 *   - 命中部门字典 → 部门名称
 */
const SAMPLE_ROOM_COMPETE = `0
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
会议室
0
TEXT
8
内部结构内墙线
10
2700
20
2100
1
201
0
TEXT
8
内部结构内墙线
10
2900
20
2200
1
45.2㎡
0
TEXT
8
内部结构内墙线
10
2300
20
1900
1
教务部
0
ENDSEC
0
EOF
`;

/**
 * 含曲线实体（SPLINE / ELLIPSE / ARC）的图纸：房间在 (0,0)-(5000,5000)（≈25㎡，高于 5㎡ 阈值），
 * 房间内无任何文字标签；另有一条 SPLINE、一个 ELLIPSE、一个 ARC。
 * MVP 不提取曲线为房间，但必须计数告警（且不因曲线导致房间被丢弃）。
 */
const SAMPLE_WITH_CURVES = `0
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
SPLINE
8
内部结构内墙线
0
ELLIPSE
8
内部结构内墙线
0
ARC
8
内部结构内墙线
0
ENDSEC
0
EOF
`;

/**
 * 仅含「柱」图层与房间线，但缺「楼层外轮廓线 / 内部结构外墙线 / 内部结构内墙线」：
 * 验证 4 个规定图层缺失时给出 warn（不是 error），仍尽力提取房间（回退全部闭合多边形）。
 * 房间 (0,0)-(5000,5000)（≈25㎡，高于 5㎡ 阈值），文字标签 "101" 在房间内 (2500,2500)。
 */
const SAMPLE_MISSING_LAYERS = `0
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
柱
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
柱
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
柱
10
2500
20
2500
1
101
0
ENDSEC
0
EOF
`;

describe('dxfParser 房间提取 / 曲线告警 / 图层缺失告警', () => {
  it('多文本竞争：按到质心距离回填 name/number/area/dept', () => {
    const r = parseDxfToResult(SAMPLE_ROOM_COMPETE, '教学楼', 1);
    expect(r.rooms.length).toBe(1);
    const room = r.rooms[0];
    expect(room.name).toBe('会议室'); // 离质心最近的一行
    expect(room.code).toBe('201');
    expect(room.number).toBe('201');
    expect(room.useArea).toBeCloseTo(45.2);
    expect(room.dept).toBe('教务部');
    expect(room.inspectStatus).toBe('normal');
  });

  it('房间内无任何文字 → 保留房间，状态 partial', () => {
    const r = parseDxfToResult(SAMPLE_WITH_CURVES, '教学楼', 1, { expandBlocks: false });
    expect(r.rooms.length).toBe(1);
    expect(r.rooms[0].code).toBe('');
    expect(r.rooms[0].inspectStatus).toBe('partial');
    expect(r.warnings.some((w) => w.code === 'UNLABELED_ROOM')).toBe(true);
  });

  it('曲线实体计数告警（SPLINE/ELLIPSE/ARC），且不提取为房间', () => {
    const r = parseDxfToResult(SAMPLE_WITH_CURVES, '教学楼', 1);
    expect(r.rooms.length).toBe(1); // 仅 1 个闭合房间，曲线不计为房间
    const curve = r.warnings.find((w) => w.code === 'CURVE_ENTITY');
    expect(curve).toBeDefined();
    expect(curve!.message).toContain('3 个');
  });

  it('4 个规定图层缺失 → warn（不是 error），仍尽力提取房间', () => {
    const r = parseDxfToResult(SAMPLE_MISSING_LAYERS, '教学楼', 1);
    // 房间在「柱」层，无 innerWall 层 → 回退全部闭合多边形尽力提取
    expect(r.rooms.length).toBe(1);
    expect(r.rooms[0].code).toBe('101');
    // 全部为 warn，无 level==='error'
    expect(r.warnings.every((w) => w.level === 'warn')).toBe(true);
    expect(r.warnings.some((w) => w.code === 'MISSING_SPEC_LAYERS')).toBe(true);
    expect(r.warnings.some((w) => w.code === 'NO_FLOOR_OUTLINE')).toBe(true);
  });

  it('isClosedPolyline 三选一 + entityPoints 通用', () => {
    const { entities } = parseDxf(SAMPLE_ROOM_COMPETE);
    const poly = entities.find((e) => e.type === 'LWPOLYLINE')!;
    expect(isClosedPolyline(poly)).toBe(true);
    expect(entityPoints(poly).length).toBe(4);
    const txt = entities.find((e) => e.type === 'TEXT')!;
    expect(entityPoints(txt)).toEqual([]);
  });

  it('extractRooms 低层函数可直接产出 ParsedRoom[]（不依赖 parseDxfToResult）', () => {
    const { entities, layers } = parseDxf(SAMPLE_ROOM_COMPETE);
    const rooms = extractRooms(entities, layers, 'mm', { buildingName: '教学楼', floorNo: 1 });
    expect(rooms.length).toBe(1);
    expect(rooms[0].name).toBe('会议室');
    expect(rooms[0].buildingName).toBe('教学楼');
    expect(rooms[0].floorNo).toBe(1);
  });
});
