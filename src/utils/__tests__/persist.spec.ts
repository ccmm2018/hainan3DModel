import { describe, it, expect } from 'vitest';
import type { BuildingFingerprint, Floor, Room } from '../../types/cad';
import {
  createPersistence,
  PERSIST_SCHEMA_VERSION,
  type DxfBlob,
  type KvBackend,
  type PersistedFloorRecord,
} from '../persist';

/** 内存版 KvBackend：无需 IndexedDB，专供单测；也演示「换后端只改 persist.ts」的接缝 */
class MemBackend implements KvBackend {
  private stores: Record<string, Map<string, unknown>> = {};
  private store(name: string): Map<string, unknown> {
    return (this.stores[name] ??= new Map());
  }
  async put(s: string, k: string, v: unknown): Promise<void> {
    this.store(s).set(k, v);
  }
  async get<T>(s: string, k: string): Promise<T | undefined> {
    return this.store(s).get(k) as T | undefined;
  }
  async delete(s: string, k: string): Promise<void> {
    this.store(s).delete(k);
  }
  async getAll<T>(s: string): Promise<{ key: string; value: T }[]> {
    const m = this.store(s);
    return [...m.entries()].map(([key, value]) => ({ key, value: value as T }));
  }
}

function makeFloor(id: string, buildingName: string): Floor {
  return {
    id,
    buildingName,
    floorNo: 1,
    name: '1F',
    height: 3.2,
    elevation: 0,
    outline: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    roomCount: 1,
    status: 'parsed',
    coordSource: 'local',
    transform: { offset: [1, 2], rotation: 0.1, scale: 1 },
  };
}

function makeRoom(floorId: string): Room {
  return {
    id: `${floorId}-1`,
    floorId,
    code: '101',
    number: '101',
    name: '教室',
    dept: '',
    usePurpose: '教学',
    useArea: 20,
    buildArea: 25,
    outline: [
      [0, 0],
      [5, 0],
      [5, 5],
      [0, 5],
    ],
    centroid: [2.5, 2.5],
    inspectStatus: 'normal',
    useStatus: 'occupied',
  };
}

function makeBlob(id: string): DxfBlob {
  return { id, name: `${id}.dxf`, bytes: new Uint8Array([1, 2, 3, 4]).buffer, savedAt: Date.now() };
}

function makeFp(): BuildingFingerprint {
  return {
    centerUtm: [500000, 3000000],
    outline: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    azimuth: 90,
    footprintArea: 100,
    centerGcj02: [110, 20],
  };
}

describe('persist (Persistence service)', () => {
  it('saveFloor + loadAll 往返：楼层 / 房间 / 指纹一致', async () => {
    const p = createPersistence(new MemBackend());
    const floor = makeFloor('B1-F1', 'B1');
    const rooms = [makeRoom('B1-F1')];
    const fp = makeFp();

    await p.saveFloor(floor, rooms);
    await p.saveFingerprint('B1', fp);
    const state = await p.loadAll();

    expect(state.floors).toHaveLength(1);
    expect(state.floors[0]).toEqual(floor);
    expect(state.roomsByFloor['B1-F1']).toEqual(rooms);
    expect(state.fingerprints['B1']).toEqual(fp);
  });

  it('DXF blob 随楼层落盘并可取回', async () => {
    const p = createPersistence(new MemBackend());
    const floor = makeFloor('B1-F1', 'B1');
    const blob = makeBlob('B1-F1');

    await p.saveFloor(floor, [makeRoom('B1-F1')], blob);
    const got = await p.getBlob('B1-F1');
    expect(got).toBeDefined();
    expect(got?.name).toBe('B1-F1.dxf');
    expect(new Uint8Array(got!.bytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('removeFloor 连带清除楼层 / 房间 / DXF blob', async () => {
    const p = createPersistence(new MemBackend());
    await p.saveFloor(makeFloor('B1-F1', 'B1'), [makeRoom('B1-F1')], makeBlob('B1-F1'));

    await p.removeFloor('B1', 1);
    const state = await p.loadAll();
    expect(state.floors).toHaveLength(0);
    expect(Object.keys(state.roomsByFloor)).toHaveLength(0);
    expect(await p.getBlob('B1-F1')).toBeUndefined();
  });

  it('saveRooms 单独更新某层房间（占用状态变更后落盘）', async () => {
    const p = createPersistence(new MemBackend());
    const floorId = 'B1-F1';
    await p.saveFloor(makeFloor(floorId, 'B1'), [makeRoom(floorId)]);

    const updated = makeRoom(floorId);
    updated.useStatus = 'vacant';
    await p.saveRooms(floorId, [updated]);

    const state = await p.loadAll();
    expect(state.roomsByFloor[floorId][0].useStatus).toBe('vacant');
  });

  it('schemaVersion 不符的记录被 loadAll 过滤', async () => {
    const mem = new MemBackend();
    const p = createPersistence(mem);
    await p.saveFloor(makeFloor('B1-F1', 'B1'), [makeRoom('B1-F1')]);

    // 直接塞入一条旧版本记录（绕开服务层、模拟历史数据）
    const stale: PersistedFloorRecord = {
      schemaVersion: PERSIST_SCHEMA_VERSION - 1,
      floor: makeFloor('OLD-F1', 'OLD'),
      dxfBlobId: undefined,
    };
    await mem.put('floors', 'OLD-F1', stale);

    const state = await p.loadAll();
    expect(state.floors.map((f) => f.id)).toEqual(['B1-F1']);
  });
});
