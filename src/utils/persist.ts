/**
 * 楼层 / 房间 / 楼栋指纹 / DXF 原文件的本地持久化。
 *
 * 设计目标：把"存储后端"与"业务写入"彻底解耦。
 * - 上层（building store / main）只调用本文件导出的 `persistence` 服务，
 *   完全不关心数据落在 IndexedDB 还是服务端 API。
 * - 以后要换后端（如 REST / OSS），只需在 `createPersistence` 处替换一个
 *   `KvBackend` 实现，其余代码一行都不用动 —— 这就是"以后换后端只改这一个文件"。
 *
 * IndexedDB 对象仓：
 *   floors       key = Floor.id                value = PersistedFloorRecord
 *   rooms        key = Floor.id                value = Room[]
 *   fingerprints key = buildingName            value = BuildingFingerprint
 *   dxfBlobs     key = blobId(= Floor.id)      value = DxfBlob
 */

import type { BuildingFingerprint, Floor, Room } from '../types/cad';

const DB_NAME = 'hnjcxy-dxf';
const DB_VERSION = 1;
const STORE_FLOORS = 'floors';
const STORE_ROOMS = 'rooms';
const STORE_FP = 'fingerprints';
const STORE_BLOBS = 'dxfBlobs';

/** 数据结构版本，结构演进时 +1；loadAll 会丢弃版本不符的记录 */
export const PERSIST_SCHEMA_VERSION = 1;

/** 上传的 DXF 原始文件（刷新后可重新下载 / 再导入） */
export interface DxfBlob {
  id: string;
  name: string;
  bytes: ArrayBuffer;
  savedAt: number;
}

export interface PersistedFloorRecord {
  schemaVersion: number;
  floor: Floor;
  /** 关联的 DXF blob id（无则为 undefined） */
  dxfBlobId?: string;
}

export interface LoadedState {
  floors: Floor[];
  /** floorId → Room[] */
  roomsByFloor: Record<string, Room[]>;
  /** buildingName → BuildingFingerprint */
  fingerprints: Record<string, BuildingFingerprint>;
}

/**
 * 最小 KV 后端接缝。
 * 换后端时实现该接口（put/get/delete/getAll）并传给 `createPersistence` 即可。
 */
export interface KvBackend {
  put(store: string, key: string, value: unknown): Promise<void>;
  get<T>(store: string, key: string): Promise<T | undefined>;
  delete(store: string, key: string): Promise<void>;
  getAll<T>(store: string): Promise<{ key: string; value: T }[]>;
}

/** IndexedDB 后端实现（默认） */
class IdbBackend implements KvBackend {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB 不可用（非浏览器环境）'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of [STORE_FLOORS, STORE_ROOMS, STORE_FP, STORE_BLOBS]) {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  private async store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.open();
    return db.transaction(name, mode).objectStore(name);
  }

  async put(s: string, key: string, value: unknown): Promise<void> {
    const os = await this.store(s, 'readwrite');
    await new Promise<void>((resolve, reject) => {
      const r = os.put(value, key);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }

  async get<T>(s: string, key: string): Promise<T | undefined> {
    const os = await this.store(s, 'readonly');
    return new Promise<T | undefined>((resolve, reject) => {
      const r = os.get(key);
      r.onsuccess = () => resolve(r.result as T | undefined);
      r.onerror = () => reject(r.error);
    });
  }

  async delete(s: string, key: string): Promise<void> {
    const os = await this.store(s, 'readwrite');
    await new Promise<void>((resolve, reject) => {
      const r = os.delete(key);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }

  async getAll<T>(s: string): Promise<{ key: string; value: T }[]> {
    const os = await this.store(s, 'readonly');
    return new Promise((resolve, reject) => {
      const reqV = os.getAll();
      const reqK = os.getAllKeys();
      reqV.onsuccess = () => {
        reqK.onsuccess = () => {
          const values = reqV.result as T[];
          const keys = reqK.result as string[];
          resolve(keys.map((k, i) => ({ key: k, value: values[i] })));
        };
        reqK.onerror = () => reject(reqK.error);
      };
      reqV.onerror = () => reject(reqV.error);
    });
  }
}

export interface Persistence {
  /** 保存整层（楼层 + 房间 + 可选 DXF blob） */
  saveFloor(floor: Floor, rooms: Room[], blob?: DxfBlob): Promise<void>;
  /** 单独更新某层房间（占用状态 / 显隐切换后调用） */
  saveRooms(floorId: string, rooms: Room[]): Promise<void>;
  /** 删除某层（连带清掉 DXF blob） */
  removeFloor(buildingName: string, floorNo: number): Promise<void>;
  /** 写回楼栋指纹 */
  saveFingerprint(buildingName: string, fp: BuildingFingerprint): Promise<void>;
  /** 取回 DXF 原文件（用于重新下载 / 再导入） */
  getBlob(blobId: string): Promise<DxfBlob | undefined>;
  /** 启动恢复：读出全部已持久化数据 */
  loadAll(): Promise<LoadedState>;
}

/**
 * 工厂：传入一个 KvBackend 即可得到一个 Persistence 服务。
 * 换后端 → 实现一个 KvBackend（如 HTTP 版），在此替换入参即可。
 */
export function createPersistence(backend: KvBackend): Persistence {
  function floorIdOf(buildingName: string, floorNo: number): string {
    return `${buildingName}-F${floorNo}`;
  }

  return {
    async saveFloor(floor, rooms, blob) {
      let dxfBlobId: string | undefined;
      if (blob) {
        await backend.put(STORE_BLOBS, blob.id, blob);
        dxfBlobId = blob.id;
      }
      await backend.put(STORE_ROOMS, floor.id, rooms);
      const rec: PersistedFloorRecord = {
        schemaVersion: PERSIST_SCHEMA_VERSION,
        floor,
        dxfBlobId,
      };
      await backend.put(STORE_FLOORS, floor.id, rec);
    },

    async saveRooms(floorId, rooms) {
      await backend.put(STORE_ROOMS, floorId, rooms);
    },

    async removeFloor(buildingName, floorNo) {
      const floorId = floorIdOf(buildingName, floorNo);
      const rec = await backend.get<PersistedFloorRecord>(STORE_FLOORS, floorId);
      if (rec?.dxfBlobId) await backend.delete(STORE_BLOBS, rec.dxfBlobId);
      await backend.delete(STORE_FLOORS, floorId);
      await backend.delete(STORE_ROOMS, floorId);
    },

    async saveFingerprint(buildingName, fp) {
      await backend.put(STORE_FP, buildingName, fp);
    },

    async getBlob(blobId) {
      return backend.get<DxfBlob>(STORE_BLOBS, blobId);
    },

    async loadAll() {
      const [floorRecs, roomsRecs, fpRecs] = await Promise.all([
        backend.getAll<PersistedFloorRecord>(STORE_FLOORS),
        backend.getAll<Room[]>(STORE_ROOMS),
        backend.getAll<BuildingFingerprint>(STORE_FP),
      ]);
      const roomsByFloor: Record<string, Room[]> = {};
      for (const { key, value } of roomsRecs) roomsByFloor[key] = value;
      const fingerprints: Record<string, BuildingFingerprint> = {};
      for (const { key, value } of fpRecs) fingerprints[key] = value;
      const floors: Floor[] = floorRecs
        .filter((r) => r.value && r.value.schemaVersion === PERSIST_SCHEMA_VERSION)
        .map((r) => r.value.floor);
      return { floors, roomsByFloor, fingerprints };
    },
  };
}

/** 默认单例：IndexedDB 后端。换后端只改这一行。 */
export const persistence: Persistence = createPersistence(new IdbBackend());
