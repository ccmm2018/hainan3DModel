/**
 * 房间数据层（楼盘表）
 *
 * 负责加载某栋建筑的房间数据，按楼层分组，用状态色表示房间状态。
 * 数据来源：GeoJSON 或后端 API，与 buildingData 类似。
 */

import { normalizeGeoJSONToGcj02 } from '../utils/coordTransform';

/** 房间状态：使用中 / 无权限 / 空置 */
export type RoomStatus = 'occupied' | 'noaccess' | 'vacant';

/** 单个房间 */
export interface Room {
  /** 唯一标识 */
  id: string;
  /** 房间号，如 "101"、"302" */
  roomNo: string;
  /** 房间名称，如 "多媒体教室" */
  roomName?: string;
  /** 所属建筑名称（与 GLB 节点名匹配） */
  building: string;
  /** 楼层（从 1 开始） */
  floor: number;
  /** 状态：空闲 / 占用 / 维修 */
  status: RoomStatus;
  /** 使用面积（㎡） */
  area: number;
  /** 建筑面积（㎡） */
  buildingArea?: number;
  /** 使用部门 */
  department?: string;
  /** 管理部门 */
  managementDept?: string;
  /** 房间用途 */
  purpose?: string;
  /** 使用人 */
  user?: string;
  /** 备注 */
  remark?: string;
  /** GeoJSON Polygon 几何（WGS84，用于 Turf.js 计算实际面积） */
  geometry?: any;
  /** 任意附加属性 */
  [key: string]: unknown;
}

/** 标注字段（打印/导出对话框用） */
export interface RoomLabelField {
  key: keyof Room;
  label: string;
}

/** 可勾选的房间标注字段 */
export const ROOM_LABEL_FIELDS: RoomLabelField[] = [
  { key: 'roomNo', label: '房间号' },
  { key: 'roomName', label: '房间名称' },
  { key: 'managementDept', label: '管理部门' },
  { key: 'purpose', label: '房间用途' },
  { key: 'buildingArea', label: '建筑面积' },
  { key: 'area', label: '使用面积' },
  { key: 'department', label: '使用部门' },
  { key: 'user', label: '使用人' },
];

/** 状态 → 显示配置 */
export const ROOM_STATUS_CONFIG: Record<RoomStatus, { label: string; color: string }> = {
  occupied: { label: '使用中', color: '#3b82f6' },
  noaccess: { label: '无权限', color: '#f59e0b' },
  vacant: { label: '空置', color: '#22c55e' },
};

export const ROOM_STATUS_ORDER: RoomStatus[] = ['occupied', 'noaccess', 'vacant'];

/** building 名称 → 房间列表 */
export type RoomDataMap = Record<string, Room[]>;

/** 从 GeoJSON FeatureCollection 提取房间（读取 properties） */
export function loadRoomDataFromGeoJSON(geoJson: any): RoomDataMap {
  const map: RoomDataMap = {};
  const features: any[] = geoJson?.features ?? [];
  for (const f of features) {
    const p = f?.properties ?? {};
    const building = p.building ?? p.buildingName;
    if (!building) continue;

    const room: Room = {
      id: p.id ?? `${building}-${p.roomNo}`,
      roomNo: String(p.roomNo ?? p.room ?? p.name ?? ''),
      roomName: p.roomName ?? p.room_name,
      building,
      floor: Number(p.floor ?? p.level ?? 1),
      status: normalizeStatus(p.status),
      area: Number(p.area ?? p.area_m2 ?? p.usableArea ?? 0),
      buildingArea: p.buildingArea ?? p.building_area,
      department: p.department ?? p.dept,
      managementDept: p.managementDept ?? p.management_dept,
      purpose: p.purpose ?? p.use,
      user: p.user ?? p.owner,
      remark: p.remark ?? p.description,
      geometry: f?.geometry ?? p.geometry,
      ...p,
    };
    (map[building] ??= []).push(room);
  }
  return map;
}

/** 从后端数组加载房间 */
export function loadRoomDataFromArray(list: Room[]): RoomDataMap {
  const map: RoomDataMap = {};
  for (const room of list) {
    if (!room?.building) continue;
    (map[room.building] ??= []).push(room);
  }
  return map;
}

/** 从后端 API 或 GeoJSON 文件异步加载房间数据 */
export async function fetchRoomData(url: string): Promise<RoomDataMap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`加载失败：HTTP ${res.status}`);
  const json = await res.json();

  if (json?.type === 'FeatureCollection') return loadRoomDataFromGeoJSON(normalizeGeoJSONToGcj02(json));
  if (Array.isArray(json)) return loadRoomDataFromArray(json as Room[]);
  if (Array.isArray(json?.data)) return loadRoomDataFromArray(json.data as Room[]);
  if (Array.isArray(json?.list)) return loadRoomDataFromArray(json.list as Room[]);
  throw new Error('无法识别的房间数据格式（期望 GeoJSON FeatureCollection 或数组）');
}

function normalizeStatus(s: unknown): RoomStatus {
  const v = String(s ?? '').trim();
  if (['使用中', '占用', 'occupied', 'in_use', 'used', '1'].includes(v)) return 'occupied';
  if (['无权限', 'noaccess', 'no_access', 'no-permission', '2'].includes(v)) return 'noaccess';
  return 'vacant';
}

// ---------------------------------------------------------------------------
// 示例数据（无真实数据时联调用）
// ---------------------------------------------------------------------------

/** 生成以 (lng,lat) 为中心、边长为 sideMeters 米的正方形 GeoJSON Polygon */
function makeSquarePolygon(lng: number, lat: number, sideMeters: number): any {
  const dLng = sideMeters / 2 / 111320;
  const dLat = sideMeters / 2 / 110540;
  return {
    type: 'Polygon',
    coordinates: [[
      [lng - dLng, lat - dLat],
      [lng + dLng, lat - dLat],
      [lng + dLng, lat + dLat],
      [lng - dLng, lat + dLat],
      [lng - dLng, lat - dLat],
    ]],
  };
}

function generateSampleRooms(): RoomDataMap {
  // 覆盖全部楼栋（与 buildingData 主键一致），避免部分楼栋无房间数据
  const plan: Record<string, { floors: number; perFloor: number }> = {
    教学楼: { floors: 6, perFloor: 10 },
    实验楼: { floors: 5, perFloor: 8 },
    图书馆: { floors: 7, perFloor: 6 },
    警体综合训练馆: { floors: 3, perFloor: 5 },
    学生公寓: { floors: 8, perFloor: 12 },
    食堂: { floors: 3, perFloor: 4 },
  };
  const departments = ['教务处', '侦查系', '边防管理系', '网络安全与执法系', '警体部', '图书馆', '后勤管理处'];
  const roomNamesByType: Record<string, string[]> = {
    教学楼: ['多媒体教室', '普通教室', '阶梯教室', '研讨室', '办公室', '机房'],
    实验楼: ['理化实验室', '电子实验室', '法医实验室', '仪器室', '准备室', '办公室'],
    图书馆: ['阅览室', '书库', '电子阅览室', '研讨间', '采编室', '办公室'],
    警体综合训练馆: ['训练馆', '器械室', '更衣室', '裁判室', '储物间'],
    学生公寓: ['学生宿舍', '洗衣房', '活动室', '宿管室', '储物间'],
    食堂: ['餐厅', '后厨', '备餐间', '仓库', '办公室'],
  };
  const purposesByType: Record<string, string[]> = {
    教学楼: ['教学', '会议', '办公', '科研'],
    实验楼: ['实验实训', '教学', '办公'],
    图书馆: ['阅览', '藏书', '办公'],
    警体综合训练馆: ['体育训练', '仓储'],
    学生公寓: ['住宿', '生活服务'],
    食堂: ['餐饮', '后勤'],
  };
  const users = ['张老师', '李老师', '王老师', '陈老师', '刘教官', '—'];
  const statuses: RoomStatus[] = ['occupied', 'noaccess', 'vacant'];
  const map: RoomDataMap = {};
  // 校园中心（WGS84）
  const baseLng = 110.280328;
  const baseLat = 19.75491;

  const buildingNames = Object.keys(plan);
  for (const [bi, building] of buildingNames.entries()) {
    const { floors, perFloor } = plan[building];
    const roomNames = roomNamesByType[building];
    const purposes = purposesByType[building];
    const rooms: Room[] = [];
    for (let f = 1; f <= floors; f++) {
      for (let r = 1; r <= perFloor; r++) {
        const status = statuses[(f + r + bi) % statuses.length];
        const area = 24 + ((f + r * 3 + bi) % 6) * 10;
        const side = Math.sqrt(area);
        const lng = baseLng + (bi * 0.0004) + ((r - 1) % 5) * 0.00012;
        const lat = baseLat + Math.floor((r - 1) / 5) * 0.0001 + bi * 0.00018;
        rooms.push({
          id: `${building}-${f}-${r}`,
          roomNo: `${f}${String(r).padStart(2, '0')}`,
          roomName: roomNames[(f + r) % roomNames.length],
          building,
          floor: f,
          status,
          area,
          buildingArea: Math.round(area * 1.25),
          department: departments[(f + r + bi) % departments.length],
          managementDept: '后勤管理处',
          purpose: purposes[(f + r) % purposes.length],
          user: users[(f + r) % users.length],
          remark: status === 'noaccess' ? '暂无门禁权限' : undefined,
          geometry: makeSquarePolygon(lng, lat, side),
        });
      }
    }
    map[building] = rooms;
  }
  return map;
}

export const SAMPLE_ROOM_DATA: RoomDataMap = generateSampleRooms();
