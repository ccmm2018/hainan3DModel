import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useFloorRoomStore } from '../floorRoom';
import { parseDxfToResult } from '../../utils/dxfParser';
import { SAMPLE_DXF } from '../../mock/sampleDxf';

beforeEach(() => setActivePinia(createPinia()));

const transform = { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 };

describe('floorRoom store', () => {
  it('importFloor 构建楼层与房间并写回楼栋指纹', () => {
    const store = useFloorRoomStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    const fid = store.importFloor({
      buildingName: '教学楼',
      floorNo: 1,
      fileName: 'a.dxf',
      parsed,
      coordSource: 'local',
      transform,
    });
    expect(fid).toBe('教学楼-F1');
    expect(store.floorsOf('教学楼')).toContain(1);
    expect(store.getFloor('教学楼', 1)?.status).toBe('parsed');
    expect(store.roomsOfFloor(fid).length).toBe(2);

    const fp = store.buildingFingerprint('教学楼');
    expect(fp.centerUtm).toBeDefined();
    expect(fp.centerUtm![0]).toBeCloseTo(440006, 0);
    expect(fp.footprintArea).toBeGreaterThan(0);
  });

  it('selected=false 的房间在入库时被剔除', () => {
    const store = useFloorRoomStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    parsed.rooms[0].selected = false;
    const fid = store.importFloor({
      buildingName: '教学楼',
      floorNo: 1,
      parsed,
      coordSource: 'local',
      transform,
    });
    expect(store.roomsOfFloor(fid).length).toBe(1);
  });

  it('removeFloor 删除楼层与房间', () => {
    const store = useFloorRoomStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    store.importFloor({ buildingName: '教学楼', floorNo: 1, parsed, coordSource: 'local', transform });
    store.removeFloor('教学楼', 1);
    expect(store.hasFloors('教学楼')).toBe(false);
  });

  it('UTM 图纸确认入库时直接写回指纹', () => {
    const store = useFloorRoomStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '图书馆', 1);
    store.importFloor({ buildingName: '图书馆', floorNo: 1, parsed, coordSource: 'utm' });
    expect(store.buildingFingerprint('图书馆').centerUtm).toBeDefined();
  });
});
