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

function floorKey(buildingName: string, floorNo: number): string {
  return `${buildingName}#${floorNo}`;
}

function floorId(buildingName: string, floorNo: number): string {
  return `${buildingName}-F${floorNo}`;
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
}

export const useBuildingStore = defineStore('building', () => {
  /** 当前生效的楼栋属性表（由 App 在加载数据后 setBuildingMap 注入） */
  const buildingMap = ref<BuildingDataMap>(SAMPLE_BUILDING_DATA);
  /** buildingName#floorNo → Floor */
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
    const cs: CoordSource = payload.coordSource ?? parsed.coordSource;
    const unit = parsed.unit;
    const tr: FloorTransform = payload.transform ?? buildDefaultTransform(cs, unit);
    const fid = floorId(buildingName, floorNo);

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
      name: `${floorNo}F`,
      height: payload.height ?? 3.2,
      elevation: (floorNo - 1) * (payload.height ?? 3.2),
      outline,
      roomCount,
      status,
      errorReason,
      dxfFile: fileName,
      coordSource: cs,
      transform: cs === 'local' ? tr : undefined,
    };

    floors.value[floorKey(buildingName, floorNo)] = floor;
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

    return fid;
  }

  function removeFloor(buildingName: string, floorNo: number): void {
    const key = floorKey(buildingName, floorNo);
    const fid = floorId(buildingName, floorNo);
    delete floors.value[key];
    delete rooms.value[fid];
  }

  function setRoomUseStatus(fid: string, roomId: string, useStatus: Room['useStatus']): void {
    const list = rooms.value[fid];
    if (!list) return;
    const room = list.find((r) => r.id === roomId);
    if (room) room.useStatus = useStatus;
  }

  function setRoomSelected(fid: string, roomId: string, selected: boolean): void {
    const list = rooms.value[fid];
    if (!list) return;
    const room = list.find((r) => r.id === roomId);
    if (room) room.selected = selected;
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
    setRoomUseStatus,
    setRoomSelected,
    matchByFingerprint,
  };
});
