import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useBuildingStore } from '../building';
import { parseDxfToResult } from '../../utils/dxfParser';
import { SAMPLE_DXF } from '../../mock/mockData';

beforeEach(() => setActivePinia(createPinia()));

const transform = { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 };

describe('building store', () => {
  it('importFloor 构建楼层与房间并写回楼栋指纹', () => {
    const store = useBuildingStore();
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
    const store = useBuildingStore();
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
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    store.importFloor({ buildingName: '教学楼', floorNo: 1, parsed, coordSource: 'local', transform });
    store.removeFloor('教学楼', 1);
    expect(store.hasFloors('教学楼')).toBe(false);
  });

  it('UTM 图纸确认入库时直接写回指纹', () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '图书馆', 1);
    store.importFloor({ buildingName: '图书馆', floorNo: 1, parsed, coordSource: 'utm' });
    expect(store.buildingFingerprint('图书馆').centerUtm).toBeDefined();
  });

  it('预览确认阶段补填 / 修正的 6 字段随入库写回', () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '实验楼', 1);
    const r = parsed.rooms[0];
    r.code = '101';
    r.number = '101';
    r.name = '保卫处办公室';
    r.dept = '保卫处';
    r.useArea = 12.5;
    r.buildArea = 15.2;
    const fid = store.importFloor({
      buildingName: '实验楼',
      floorNo: 1,
      parsed,
      coordSource: 'local',
      transform,
    });
    const room = store.roomsOfFloor(fid)[0];
    expect(room.code).toBe('101');
    expect(room.number).toBe('101');
    expect(room.name).toBe('保卫处办公室');
    expect(room.dept).toBe('保卫处');
    expect(room.useArea).toBeCloseTo(12.5, 5);
    expect(room.buildArea).toBeCloseTo(15.2, 5);
  });

  it('同楼同层重复导入：version 产生 -v{n} 楼层 id 且不覆盖 v1', () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 3);
    const fid1 = store.importFloor({ buildingName: '教学楼', floorNo: 3, parsed, coordSource: 'local', transform });
    expect(fid1).toBe('教学楼-F3');
    expect(store.getFloor('教学楼', 3)?.id).toBe('教学楼-F3');

    const v = store.nextVersion('教学楼', 3);
    expect(v).toBe(2);
    const fid2 = store.importFloor({ buildingName: '教学楼', floorNo: 3, parsed, coordSource: 'local', transform, version: v });
    expect(fid2).toBe('教学楼-F3-v2');
    // 两个版本并存，互不影响
    expect(store.getFloor('教学楼', 3)?.id).toBe('教学楼-F3');
    expect(store.roomsOfFloor('教学楼-F3-v2').length).toBe(2);
    expect(store.nextVersion('教学楼', 3)).toBe(3);
  });

  it('partial 楼层：status=partial，errorReason 与 warnings 一并随楼层持久化', () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '图书馆', 1);
    // 一个房间未匹配到文字标签 → inspectStatus=highlight → partial
    parsed.rooms[0].inspectStatus = 'highlight';
    parsed.warnings.push({ code: 'W-TEST', level: 'warn', message: '测试告警' });
    const fid = store.importFloor({ buildingName: '图书馆', floorNo: 1, parsed, coordSource: 'local', transform });
    const f = store.getFloor('图书馆', 1)!;
    expect(f.status).toBe('partial');
    expect(f.errorReason).toBeTruthy();
    expect(f.warnings?.some((w) => w.code === 'W-TEST')).toBe(true);
  });

  it('failed 楼层（无选中房间）：仍落库且带 errorReason 与 warnings', () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '图书馆', 2);
    parsed.rooms.forEach((r) => (r.selected = false));
    parsed.warnings.push({ code: 'W-FAIL', level: 'warn', message: '无房间' });
    const fid = store.importFloor({ buildingName: '图书馆', floorNo: 2, parsed, coordSource: 'local', transform });
    const f = store.getFloor('图书馆', 2)!;
    expect(f.status).toBe('failed');
    expect(f.errorReason).toBeTruthy();
    expect(f.warnings?.some((w) => w.code === 'W-FAIL')).toBe(true);
    expect(store.roomsOfFloor(fid).length).toBe(0);
  });

  it('updateRoom 补填字段并自动将 partial 楼层升级为 parsed', () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '图书馆', 1);
    // 一个房间未匹配到文字标签 → 整层 partial
    parsed.rooms[0].inspectStatus = 'highlight';
    const fid = store.importFloor({ buildingName: '图书馆', floorNo: 1, parsed, coordSource: 'local', transform });
    expect(store.getFloor('图书馆', 1)!.status).toBe('partial');

    const room = store.roomsOfFloor(fid)[0];
    store.updateRoom(fid, room.id, {
      code: '101',
      name: '控制室',
      useArea: 18.5,
      buildArea: 20.1,
      inspectStatus: 'normal',
    });

    const updated = store.roomsOfFloor(fid)[0];
    expect(updated.code).toBe('101');
    expect(updated.name).toBe('控制室');
    expect(updated.useArea).toBeCloseTo(18.5, 5);
    expect(updated.buildArea).toBeCloseTo(20.1, 5);
    expect(updated.inspectStatus).toBe('normal');
    // 全部房间均已字段完整且无需复核 → 自动升级为 parsed
    expect(store.getFloor('图书馆', 1)!.status).toBe('parsed');
    expect(store.getFloor('图书馆', 1)!.errorReason).toBeUndefined();
  });
});
