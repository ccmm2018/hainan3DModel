/**
 * Mock 数据总入口（离线联调 / 单元测试使用）。
 *
 * 合并原 sampleDxf.ts（样例 DXF 字符串）与 floorPlanMock.ts（演示数据注入），
 * 统一由本文件对外导出，避免散落多文件。生产环境不应依赖本文件。
 *
 * 样例 DXF 含：
 * - SAMPLE_DXF           两个闭合房间（101/102），毫米局部坐标
 * - SAMPLE_DXF_4LAYER    4 图层结构（外轮廓/外墙/内墙/柱窗），毫米局部坐标
 * - SAMPLE_DXF_ROOM_FIELDS 单房间 + MTEXT 6 行字段，验证 6 字段解析
 */

// ---------------------------------------------------------------------------
// 样例 DXF 字符串
// ---------------------------------------------------------------------------

/** 两个闭合房间（101 / 102），单位毫米（局部坐标）。 */
export const SAMPLE_DXF = `0
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
0
70
0
62
7
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
0
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
0
10
2500
20
2000
1
101
0
LWPOLYLINE
8
0
70
1
10
6000
20
0
10
11000
20
0
10
11000
20
4000
10
6000
20
4000
0
TEXT
8
0
10
8500
20
2000
1
102
0
ENDSEC
0
EOF
`;

/**
 * 4 图层结构：
 *   - 楼层外轮廓线（楼栋指纹唯一来源，1 条闭合多段线）
 *   - 内部结构外墙线（双线外墙，1 条闭合多段线）
 *   - 内部结构内墙线（2 个房间闭合轮廓 + 文字标签 101 / 102）
 *   - 柱子及窗户线（1 个柱）
 *   - 窗（1 个窗，测试用：明确只含「窗」的图层）
 * 单位毫米（局部坐标）。
 */
export const SAMPLE_DXF_4LAYER = `0
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
楼层外轮廓线
70
0
62
1
0
LAYER
2
内部结构外墙线
70
0
62
2
0
LAYER
2
内部结构内墙线
70
0
62
3
0
LAYER
2
柱子及窗户线
70
0
62
4
0
LAYER
2
窗
70
0
62
5
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
楼层外轮廓线
70
1
10
0
20
0
10
12000
20
0
10
12000
20
9000
10
0
20
9000
0
LWPOLYLINE
8
内部结构外墙线
70
1
10
200
20
200
10
11800
20
200
10
11800
20
8800
10
200
20
8800
0
LWPOLYLINE
8
内部结构内墙线
70
1
10
500
20
500
10
5000
20
500
10
5000
20
4000
10
500
20
4000
0
TEXT
8
内部结构内墙线
10
2750
20
2250
1
101
0
LWPOLYLINE
8
内部结构内墙线
70
1
10
5500
20
500
10
11000
20
500
10
11000
20
4000
10
5500
20
4000
0
TEXT
8
内部结构内墙线
10
8250
20
2250
1
102
0
LWPOLYLINE
8
柱子及窗户线
70
1
10
1000
20
4200
10
1100
20
4200
10
1100
20
4300
10
1000
20
4300
0
LWPOLYLINE
8
窗
70
1
10
6000
20
4200
10
6400
20
4200
10
6400
20
4400
10
6000
20
4400
0
ENDSEC
0
EOF
`;

/**
 * 单房间 + 楼层外轮廓线，房间文本用 MTEXT 以 \P 拆成 6 行字段
 * （房间编码 / 房间号码 / 房间名称 / 部门名称 / 使用面积 / 建筑面积）。
 * 单位毫米（局部坐标）。
 */
export const SAMPLE_DXF_ROOM_FIELDS = `0
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
楼层外轮廓线
70
0
62
1
0
LAYER
2
内部结构内墙线
70
0
62
3
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
楼层外轮廓线
70
1
10
0
20
0
10
6000
20
0
10
6000
20
4000
10
0
20
4000
0
LWPOLYLINE
8
内部结构内墙线
70
1
10
500
20
500
10
5000
20
500
10
5000
20
3500
10
500
20
3500
0
MTEXT
8
内部结构内墙线
10
2750
20
2000
1
房间编码: A101\\P房间号码：101\\P房间名称 教室\\P部门名称：教务部\\P使用面积 45.2㎡\\P建筑面积 50.0
0
ENDSEC
0
EOF
`;

/**
 * 脏图纸 mock（用于测试「编码 / MTEXT / 未闭合轮廓」兼容逻辑）：
 *   - 含 MTEXT（多行字段）+ TEXT 混合，验证两种文本实体的字段解析；
 *   - 楼层外轮廓线故意做成「开放多段线」（70=0，首尾不闭合）→ 解析阶段静默丢弃，
 *     并产出 NO_FLOOR_OUTLINE 告警（演示未闭合轮廓的兼容处理，不崩溃）；
 *   - 另含一个「自交环」房间（蝴蝶结）→ 触发 SELF_INTERSECTING 告警与 C4 闭合性告警；
 *   - 含中文（教室（多媒体）/ 部门名称 等），演示 GBK 编码兼容（测试中以 GBK 字节还原）。
 * 单位毫米（局部坐标）。
 */
export const SAMPLE_DXF_DIRTY = `0
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
楼层外轮廓线
70
0
62
1
0
LAYER
2
内部结构内墙线
70
0
62
3
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
楼层外轮廓线
70
0
10
0
20
0
10
6000
20
0
10
6000
20
4000
10
3000
20
4000
0
LWPOLYLINE
8
内部结构内墙线
70
1
10
500
20
500
10
5000
20
500
10
5000
20
3500
10
500
20
3500
0
MTEXT
8
内部结构内墙线
10
2750
20
2000
1
房间编码: A101\\P房间号码：101\\P房间名称 教室（多媒体）\\P部门名称：教务部\\P使用面积 52.8㎡\\P建筑面积 58.0
0
LWPOLYLINE
8
内部结构内墙线
70
1
10
5500
20
500
10
10500
20
500
10
10500
20
3500
10
5500
20
3500
0
TEXT
8
内部结构内墙线
10
8000
20
2000
1
102
0
LWPOLYLINE
8
内部结构内墙线
70
1
10
11000
20
500
10
20000
20
500
10
13000
20
15000
10
19000
20
15000
0
ENDSEC
0
EOF
`;

// ---------------------------------------------------------------------------
// 演示数据注入
// ---------------------------------------------------------------------------

import { parseDxfToResult } from '../utils/dxfParser';
import type { ClosedPolyline, DxfParseResult, LengthUnit, ParsedRoom } from '../types/cad';
import type { Pt } from '../utils/geometry';
import { useBuildingStore } from '../stores/building';

type BuildingStore = ReturnType<typeof useBuildingStore>;

const MOCK_BUILDING = '教学楼';
const MOCK_TRANSFORM = {
  offset: [440000, 4100000] as [number, number],
  rotation: 0,
  scale: 0.001,
};

/** 在 UTM 网格内生成 n 个房间（cols×rows），返回 ParsedRoom[]（坐标即 UTM 米） */
function gridRooms(
  buildingName: string,
  floorNo: number,
  cols: number,
  rows: number,
  origin: Pt,
  roomW: number,
  roomH: number,
  dept: string,
): ParsedRoom[] {
  const rooms: ParsedRoom[] = [];
  let seq = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      seq++;
      const x0 = origin[0] + c * roomW;
      const y0 = origin[1] + r * roomH;
      const x1 = x0 + roomW;
      const y1 = y0 + roomH;
      const polygon: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      const c0: Pt = [(x0 + x1) / 2, (y0 + y1) / 2];
      const code = `${floorNo}${String(seq).padStart(2, '0')}`; // 101..112 / 201..212
      rooms.push({
        id: `${buildingName}-F${floorNo}-${seq}`,
        buildingName,
        floorNo,
        code,
        number: code,
        name: `教室${seq}`,
        dept,
        usePurpose: '教学',
        useArea: Math.round(roomW * roomH * 0.9 * 100) / 100,
        buildArea: roomW * roomH,
        polygon,
        centroid: c0,
        area: roomW * roomH,
        inspectStatus: 'normal',
        useStatus: '',
        selected: true,
        layers: ['内部结构内墙线'],
        unmatchedTexts: [],
      });
    }
  }
  return rooms;
}

/** 由房间网格生成「楼层外轮廓」闭合多段线（包络矩形） */
function gridOutline(rooms: ParsedRoom[]): ClosedPolyline {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rooms) {
    for (const [x, y] of r.polygon) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const polygon: Pt[] = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]];
  return {
    polygon,
    centroid: [(minX + maxX) / 2, (minY + maxY) / 2],
    area: (maxX - minX) * (maxY - minY),
    layer: '楼层外轮廓线',
  };
}

/** 组装一份最小合法的 DxfParseResult（importFloor 仅消费 rooms/coordSource/unit/floorOutline/warnings） */
function makeResult(
  rooms: ParsedRoom[],
  outline: ClosedPolyline,
  coordSource: 'utm' | 'local',
  unit: LengthUnit,
): DxfParseResult {
  const xs = rooms.flatMap((r) => r.polygon.map((p) => p[0]));
  const ys = rooms.flatMap((r) => r.polygon.map((p) => p[1]));
  return {
    layers: [{ name: '楼层外轮廓线', color: 1 }, { name: '内部结构内墙线', color: 3 }],
    rooms,
    warnings: [],
    coordSource,
    unit,
    bbox: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
    floorOutline: outline,
    outerWalls: [],
    columns: [],
    windows: [],
    layerRoles: { 楼层外轮廓线: 'floorOutline', 内部结构内墙线: 'innerWall' },
  };
}

/**
 * 播种演示数据（开发态）：
 * - node_jiaoxueA 教学楼A栋：2 层 × 12 间房（4×3 网格，UTM 米坐标），字段完整，入库时写回楼栋指纹；
 * - node_shixun 实训楼：1 层局部坐标图纸（mm），演示 AnchorPicker 配准（coordSource=local + 变换）；
 * - node_tushuguan 图书馆：无图纸，演示空状态（不播种楼层即可）；
 * - 教学楼房演示向后兼容：2 层样例（local→UTM 变换）仍保留。
 * 生产环境不应调用。
 */
export function seedMockFloorPlans(store: BuildingStore): void {
  // 教学楼A栋：F1 / F2 各 4×3 = 12 间，楼层间在 Y 方向错开以便区分
  for (const floorNo of [1, 2]) {
    const origin: Pt = [440100, 4100100 + (floorNo - 1) * 40];
    const rooms = gridRooms('node_jiaoxueA', floorNo, 4, 3, origin, 12, 9, '教务部');
    const outline = gridOutline(rooms);
    const parsed = makeResult(rooms, outline, 'utm', 'm');
    store.importFloor({
      buildingName: 'node_jiaoxueA',
      floorNo,
      fileName: 'mock.jiaoxueA.dxf',
      parsed,
      coordSource: 'utm',
    });
  }

  // 实训楼：1 层，局部坐标（mm），需经变换进入 UTM（演示 AnchorPicker 配准路径）
  {
    const rooms = gridRooms('node_shixun', 1, 4, 3, [1000, 1000], 8000, 6000, '实训中心');
    const outline = gridOutline(rooms);
    const parsed = makeResult(rooms, outline, 'local', 'mm');
    store.importFloor({
      buildingName: 'node_shixun',
      floorNo: 1,
      fileName: 'mock.shixun.dxf',
      parsed,
      coordSource: 'local',
      transform: { offset: [440000, 4100000], rotation: 0, scale: 0.001 },
    });
  }

  // 教学楼房演示向后兼容
  for (const floorNo of [1, 2]) {
    const parsed = parseDxfToResult(SAMPLE_DXF, MOCK_BUILDING, floorNo);
    store.importFloor({
      buildingName: MOCK_BUILDING,
      floorNo,
      fileName: 'mock.floorplan.dxf',
      parsed,
      coordSource: 'local',
      transform: MOCK_TRANSFORM,
    });
  }
}
