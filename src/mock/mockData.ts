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

// ---------------------------------------------------------------------------
// 演示数据注入
// ---------------------------------------------------------------------------

import { parseDxfToResult } from '../utils/dxfParser';
import { useBuildingStore } from '../stores/building';

type BuildingStore = ReturnType<typeof useBuildingStore>;

const MOCK_BUILDING = '教学楼';
const MOCK_TRANSFORM = {
  offset: [440000, 4100000] as [number, number],
  rotation: 0,
  scale: 0.001,
};

/**
 * 用样例 DXF 在「教学楼」植入 1F / 2F 两层演示数据（含 local→UTM 变换，
 * 因此会写回楼栋指纹），便于离线联调 FloorPlan2D 与指纹逻辑。生产环境不应调用。
 */
export function seedMockFloorPlans(store: BuildingStore): void {
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
