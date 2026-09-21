/**
 * Floor / Room 的 mock 数据接入。
 *
 * 提供 seedMockFloorPlans(store)：用样例 DXF 在「教学楼」植入 1F / 2F 两层演示数据
 * （含 local→UTM 变换，因此会写回楼栋指纹），便于离线联调 FloorPlan2D 与指纹逻辑。
 * 生产环境不应调用本函数。
 */
import { parseDxfToResult } from '../utils/dxfParser';
import { useFloorRoomStore } from '../stores/floorRoom';
import { SAMPLE_DXF } from './sampleDxf';

type FloorRoomStore = ReturnType<typeof useFloorRoomStore>;

const MOCK_BUILDING = '教学楼';
const MOCK_TRANSFORM = {
  offset: [440000, 4100000] as [number, number],
  rotation: 0,
  scale: 0.001,
};

export function seedMockFloorPlans(store: FloorRoomStore): void {
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
