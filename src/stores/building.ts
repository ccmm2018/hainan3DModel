/**
 * 楼层 / 房间 数据仓库（Pinia，新建，不改动现有 building store）。
 *
 * 四层树：Building（已有）→ Floor（新增）→ Room（新增）。
 * 楼栋外键统一使用 buildingName（= BuildingProps.name）。
 *
 * 关键约定：
 * - 解析（parse）只是预览，不写指纹；
 * - 用户「确认入库」（importFloor）那一刻，才把楼栋指纹（centerUtm / outline /
 *   azimuth / footprintArea）写回 buildingMap[name]（通过索引签名挂载）。
 * - 仅当坐标为 UTM（coordSource='utm'）或显式提供了 local→UTM 变换时，才计算并写回指纹。
 */

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type {
  BuildingFingerprint,
  CoordSource,
  DxfParseResult,
  Floor,
  FloorTransform,
  ParseWarning,
  Room,
} from '../types/cad';
import { SAMPLE_BUILDING_DATA, type BuildingDataMap } from '../data/buildingData';
import {
  buildDefaultTransform,
  computeFloorBounds,
  computeFloorOutline,
  estimateFingerprint,
  fingerprintFromOutline,
} from '../utils/coordinate';
import { utm49nToGcj02 } from '../utils/coordTransform';
import { matchBuildings, type Fingerprint, type MatchResult } from '../utils/matcher';
import { polygonArea, polygonCentroid, transformPolygon, type Pt } from '../utils/geometry';
import { persistence, type LoadedState } from '../utils/persist';

function floorKey(buildingName: string, floorNo: number, version = 1): string {
  return version > 1 ? `${buildingName}#${floorNo}#${version}` : `${buildingName}#${floorNo}`;
}

function floorId(buildingName: string, floorNo: number, version = 1): string {
  return version > 1 ? `${buildingName}-F${floorNo}-v${version}` : `${buildingName}-F${floorNo}`;
}

/**
 * 计算同楼同层的下一个可用版本号。
 * 扫描 floors 主键，识别 `${buildingName}#${floorNo}`（v1）与
 * `${buildingName}#${floorNo}#${n}`（v≥2），返回最大版本 + 1。
 */
function computeNextVersion(
  floorsMap: Record<string, Floor>,
  buildingName: string,
  floorNo: number,
): number {
  let max = 1;
  const base = `${buildingName}#${floorNo}`;
  for (const k of Object.keys(floorsMap)) {
    if (k === base) max = Math.max(max, 1);
    else if (k.startsWith(base + '#')) {
      const v = Number(k.slice(base.length + 1));
      if (Number.isFinite(v) && v > max) max = v;
    }
  }
  return max + 1;
}

/** 把指纹字段写回 buildingMap（通过索引签名挂载，不修改 BuildingProps 接口） */
function writeFingerprint(map: BuildingDataMap, buildingName: string, fp: BuildingFingerprint): void {
  const base: BuildingDataMap[string] =
    map[buildingName] ?? ({ name: buildingName } as BuildingDataMap[string]);
  const rec = base as Record<string, unknown>;
  rec['centerUtm'] = fp.centerUtm;
  rec['outline'] = fp.outline;
  rec['azimuth'] = fp.azimuth;
  rec['footprintArea'] = fp.footprintArea;
  rec['centerGcj02'] = fp.centerGcj02;
  map[buildingName] = base;
}

export interface ImportFloorPayload {
  buildingName: string;
  floorNo: number;
  fileName?: string;
  parsed: DxfParseResult;
  /** 界面可覆盖自动推断的坐标来源 */
  coordSource?: CoordSource;
  /** local 图纸可显式提供变换（AnchorPicker 产出） */
  transform?: FloorTransform;
  /** 层高（米），默认 3.2 */
  height?: number;
  /** DXF 原始文件字节，落盘用（刷新后可重新下载 / 再导入） */
  dxfBytes?: ArrayBuffer;
  /** 版本号：同楼同层重复导入时 >=2 表示「另存为新版本」，floor id 追加 -v{n} */
  version?: number;
}

export const useBuildingStore = defineStore('building', () => {
  /** 当前生效的楼栋属性表（由 App 在加载数据后 setBuildingMap 注入） */
  const buildingMap = ref<BuildingDataMap>(SAMPLE_BUILDING_DATA);
  /** floorKey（${buildingName}#${floorNo}[#${version}]）→ Floor */
  const floors = ref<Record<string, Floor>>({});
  /** Floor.id → Room[] */
  const rooms = ref<Record<string, Room[]>>({});

  // ---- getters ----
  const floorsOf = (buildingName: string): number[] => {
    const out: number[] = [];
    for (const f of Object.values(floors.value)) {
      if (f.buildingName === buildingName) out.push(f.floorNo);
    }
    return [...new Set(out)].sort((a, b) => a - b);
  };

  const hasFloors = (buildingName: string): boolean =>
    Object.values(floors.value).some((f) => f.buildingName === buildingName);

  const getFloor = (buildingName: string, floorNo: number): Floor | undefined =>
    floors.value[floorKey(buildingName, floorNo)];

  const roomsOfFloor = (fid: string): Room[] => rooms.value[fid] ?? [];

  const buildingFingerprint = (buildingName: string): BuildingFingerprint => {
    const base = buildingMap.value[buildingName];
    if (!base) return {};
    const rec = base as Record<string, unknown>;
    const fp: BuildingFingerprint = {};
    if (Array.isArray(rec['centerUtm'])) fp.centerUtm = rec['centerUtm'] as [number, number];
    if (Array.isArray(rec['outline'])) fp.outline = rec['outline'] as [number, number][];
    if (typeof rec['azimuth'] === 'number') fp.azimuth = rec['azimuth'] as number;
    if (typeof rec['footprintArea'] === 'number') fp.footprintArea = rec['footprintArea'] as number;
    if (Array.isArray(rec['centerGcj02'])) fp.centerGcj02 = rec['centerGcj02'] as [number, number];
    return fp;
  };

  const buildingNames = computed(() => Object.keys(buildingMap.value));
  /** 当前生效的完整楼栋属性表（供楼栋匹配等需要遍历全部楼栋的场景） */
  const buildingData = computed<BuildingDataMap>(() => buildingMap.value);

  // ---- actions ----
  function setBuildingMap(map: BuildingDataMap): void {
    buildingMap.value = map;
  }

  function importFloor(payload: ImportFloorPayload): string {
    const { buildingName, floorNo, fileName, parsed } = payload;
    const version = payload.version ?? 1;
    const cs: CoordSource = payload.coordSource ?? parsed.coordSource;
    const unit = parsed.unit;
    const tr: FloorTransform = payload.transform ?? buildDefaultTransform(cs, unit);
    const fid = floorId(buildingName, floorNo, version);
    const key = floorKey(buildingName, floorNo, version);

    const selectedRooms = parsed.rooms.filter((r) => r.selected);
    const selectedPolys = selectedRooms.map((r) => r.polygon);

    // 楼层外轮廓：优先用「楼层外轮廓线」图层（楼栋指纹唯一来源），否则回退房间外包络
    const floorOutlineLocal: Pt[] | null = parsed.floorOutline ? parsed.floorOutline.polygon : null;
    const outline: [number, number][] = floorOutlineLocal
      ? transformPolygon(floorOutlineLocal, tr)
      : (computeFloorOutline(selectedPolys, tr) as [number, number][]);

    // 构建 Room（轮廓 / 质心 / 面积均变换到 UTM 米）
    const roomList: Room[] = selectedRooms.map((r, idx) => {
      const rOutline = transformPolygon(r.polygon, tr);
      const centroid = polygonCentroid(rOutline);
      const areaUtm = polygonArea(rOutline);
      return {
        id: `${fid}-${idx + 1}`,
        floorId: fid,
        code: r.code,
        number: r.number,
        name: r.name,
        dept: r.dept,
        usePurpose: r.usePurpose,
        // 优先用 DXF 文本解析出的使用 / 建筑面积；缺失（=0）时回退多边形几何面积
        useArea: r.useArea > 0 ? r.useArea : areaUtm,
        buildArea: r.buildArea > 0 ? r.buildArea : areaUtm,
        outline: rOutline,
        centroid,
        inspectStatus: r.inspectStatus,
        useStatus: r.useStatus,
        remark: r.remark,
        selected: true,
      };
    });

    const bbox = computeFloorBounds(selectedPolys, tr);
    const roomCount = roomList.length;

    let status: Floor['status'] = 'parsed';
    let errorReason: string | undefined;
    if (roomCount === 0) {
      status = 'failed';
      errorReason = '未识别到房间，或未选择任何房间入库。';
    } else if (parsed.rooms.some((r) => r.inspectStatus === 'highlight')) {
      status = 'partial';
      const cnt = parsed.rooms.filter((r) => r.inspectStatus === 'highlight').length;
      errorReason = `有 ${cnt} 个房间未匹配到文字标签，已标记为需复核；建议在查看器中补全房间号 / 用途。`;
    }

    const floor: Floor = {
      id: fid,
      buildingName,
      floorNo,
      name: `${floorNo}F${version > 1 ? ` v${version}` : ''}`,
      height: payload.height ?? 3.2,
      elevation: (floorNo - 1) * (payload.height ?? 3.2),
      outline,
      roomCount,
      status,
      errorReason,
      // 解析告警（partial / failed 时一并持久化；parsed 时也保留，便于事后排查）
      warnings: parsed.warnings.length ? (parsed.warnings as ParseWarning[]) : undefined,
      dxfFile: fileName,
      coordSource: cs,
      transform: cs === 'local' ? tr : undefined,
    };

    floors.value[key] = floor;
    rooms.value[fid] = roomList;

    // 仅在坐标确为 UTM（或提供了 local→UTM 变换）时写回楼栋指纹。
    // 指纹首选「楼层外轮廓线」多边形，否则回退到房间顶点凸包。
    const canFingerprint = cs === 'utm' || Boolean(payload.transform);
    if (canFingerprint && status !== 'failed') {
      let fp: BuildingFingerprint;
      if (floorOutlineLocal) {
        fp = fingerprintFromOutline(transformPolygon(floorOutlineLocal, tr));
      } else {
        const pts = roomList.flatMap((r) => r.outline);
        fp = estimateFingerprint(pts);
      }
      if (fp.centerUtm) fp.centerGcj02 = utm49nToGcj02(fp.centerUtm[0], fp.centerUtm[1]);
      writeFingerprint(buildingMap.value, buildingName, fp);
    }

    // 落盘：fire-and-forget；浏览器外环境（如单测）IDB 不可用则静默失败，不影响内存态
    const blob =
      payload.dxfBytes
        ? { id: fid, name: fileName ?? `${fid}.dxf`, bytes: payload.dxfBytes, savedAt: Date.now() }
        : undefined;
    void persistence.saveFloor(floor, roomList, blob).catch(() => undefined);

    return fid;
  }

  function removeFloor(buildingName: string, floorNo: number, version = 1): void {
    const key = floorKey(buildingName, floorNo, version);
    const fid = floorId(buildingName, floorNo, version);
    delete floors.value[key];
    delete rooms.value[fid];
    void persistence.removeFloor(buildingName, floorNo, version).catch(() => undefined);
  }

  function setRoomUseStatus(fid: string, roomId: string, useStatus: Room['useStatus']): void {
    const list = rooms.value[fid];
    if (!list) return;
    const room = list.find((r) => r.id === roomId);
    if (!room) return;
    room.useStatus = useStatus;
    void persistence.saveRooms(fid, list).catch(() => undefined);
  }

  function setRoomSelected(fid: string, roomId: string, selected: boolean): void {
    const list = rooms.value[fid];
    if (!list) return;
    const room = list.find((r) => r.id === roomId);
    if (!room) return;
    room.selected = selected;
    void persistence.saveRooms(fid, list).catch(() => undefined);
  }

  /**
   * 补填 / 修订房间字段（查看器「继续补填」调用）。
   * 落盘后，若本层此前为 partial，且全部房间现已字段完整且无需复核，则自动升级为 parsed。
   */
  function updateRoom(
    fid: string,
    roomId: string,
    patch: Partial<
      Pick<Room, 'code' | 'number' | 'name' | 'dept' | 'usePurpose' | 'useArea' | 'buildArea' | 'inspectStatus'>
    >,
  ): void {
    const list = rooms.value[fid];
    if (!list) return;
    const room = list.find((r) => r.id === roomId);
    if (!room) return;
    Object.assign(room, patch);
    // 补填完整后，若该房间此前因字段缺失被标记为 partial，则恢复 normal
    if (patch.code !== undefined || patch.name !== undefined) {
      if (room.code.trim() !== '' && room.name.trim() !== '' && room.inspectStatus === 'partial') {
        room.inspectStatus = 'normal';
      }
    }
    void persistence.saveRooms(fid, list).catch(() => undefined);

    // partial 楼层：检查是否仍有待补填 / 待复核房间，已全部补全则升级为 parsed
    const f = Object.values(floors.value).find((x) => x.id === fid);
    if (f && f.status === 'partial') {
      const stillPartial = list.some(
        (r) =>
          r.inspectStatus === 'highlight' ||
          r.inspectStatus === 'warning' ||
          r.inspectStatus === 'partial' ||
          r.code.trim() === '' ||
          r.name.trim() === '',
      );
      if (!stillPartial) {
        f.status = 'parsed';
        f.errorReason = undefined;
        void persistence.saveFloor(f, list).catch(() => undefined);
      }
    }
  }

  /**
   * 启动恢复：把持久化读出的楼层 / 房间 / 楼栋指纹合并进内存态。
   * 调用时机在「播种样例数据」之后，故持久化数据会覆盖样例中的同名项。
   */
  function applyPersisted(state: LoadedState): void {
    for (const f of state.floors) {
      // 用持久化记录里的真实 id 作为主键（可能含 -v{n} 版本后缀）
      floors.value[f.id] = f;
    }
    for (const [fid, list] of Object.entries(state.roomsByFloor)) {
      rooms.value[fid] = list;
    }
    for (const [bn, fp] of Object.entries(state.fingerprints)) {
      const has =
        !!fp &&
        (!!fp.centerUtm || !!fp.outline || fp.azimuth != null || fp.footprintArea != null || !!fp.centerGcj02);
      if (has) writeFingerprint(buildingMap.value, bn, fp);
    }
  }

  /**
   * 用「楼层外轮廓指纹」在楼栋库中匹配楼栋。
   * 仅在坐标为 UTM（可直接算出 UTM 指纹）或已提供 local→UTM 变换时才有意义。
   */
  function matchByFingerprint(fp: Fingerprint): MatchResult {
    return matchBuildings(fp, buildingMap.value);
  }

  return {
    buildingMap,
    floors,
    rooms,
    buildingNames,
    buildingData,
    floorsOf,
    hasFloors,
    getFloor,
    roomsOfFloor,
    buildingFingerprint,
    setBuildingMap,
    importFloor,
    removeFloor,
    /** 计算同楼同层下一个可用版本号（同楼同层已存在时用于「另存为新版本」） */
    nextVersion: (buildingName: string, floorNo: number) =>
      computeNextVersion(floors.value, buildingName, floorNo),
    setRoomUseStatus,
    setRoomSelected,
    updateRoom,
    applyPersisted,
    matchByFingerprint,
  };
});
