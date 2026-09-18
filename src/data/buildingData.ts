/**
 * 建筑属性数据层
 *
 * 负责把「GLB 模型中的建筑/道路/水系」映射到其业务属性
 * （name、height、department 等），属性来源可以是：
 *   1. GeoJSON 的 features[].properties
 *   2. 后端 API 返回的 JSON
 *
 * 用法：
 *   - 传入 GeoJSON（FeatureCollection）→ loadBuildingDataFromGeoJSON()
 *   - 传入后端 API 返回的数组 → loadBuildingDataFromArray()
 *   - 直接使用示例数据（无真实数据时）→ SAMPLE_BUILDING_DATA
 *
 * 属性映射键：以「对象名称」（GLB 节点名 / GeoJSON name 字段）作为主键。
 */

export interface BuildingProps {
  /** 名称 */
  name: string;
  /** 建筑高度（米） */
  height?: number | string;
  /** 所属部门/院系 */
  department?: string;
  /** 所在校区 */
  campus?: string;
  /** 管理部门 */
  managementDept?: string;
  /** 总层数 */
  totalFloors?: number;
  /** 房间数 */
  roomCount?: number;
  /** 建筑面积（㎡） */
  buildingArea?: number;
  /** 使用面积（㎡） */
  usableArea?: number;
  /** 楼宇图片 URL（相对 public 或绝对地址） */
  image?: string;
  /** 类型：building / road / water / other */
  category?: 'building' | 'road' | 'water' | 'other';
  /** 备注描述 */
  description?: string;
  /** 任意附加属性 */
  [key: string]: unknown;
}

/** name → props 映射表 */
export type BuildingDataMap = Record<string, BuildingProps>;

/**
 * 从 GeoJSON FeatureCollection 中提取属性。
 * 以 feature.properties.name（或 name:zh）作为主键。
 */
export function loadBuildingDataFromGeoJSON(geoJson: any): BuildingDataMap {
  const map: BuildingDataMap = {};
  const features: any[] = geoJson?.features ?? [];
  for (const feature of features) {
    const p = feature?.properties ?? {};
    const name = p.name ?? p['name:zh'] ?? p.name_en;
    if (!name) continue;

    map[name] = {
      name,
      height: p.height ?? p['building:height'] ?? p.levels,
      department: p.department ?? p.dept ?? p.building,
      campus: p.campus ?? p.campus_name,
      managementDept: p.managementDept ?? p.management_dept ?? p.manage_dept,
      totalFloors: p.totalFloors ?? p.total_floors ?? p.floors,
      roomCount: p.roomCount ?? p.room_count,
      buildingArea: p.buildingArea ?? p.building_area,
      usableArea: p.usableArea ?? p.usable_area,
      image: p.image ?? p.img ?? p.photo,
      category: p.category ?? (p.building ? 'building' : p.highway ? 'road' : 'other'),
      description: p.description ?? p.amenity,
      ...p,
    };
  }
  return map;
}

/**
 * 从后端 API 返回的数组加载属性。
 * 数组元素需包含 `name` 字段作为主键。
 */
export function loadBuildingDataFromArray(list: BuildingProps[]): BuildingDataMap {
  const map: BuildingDataMap = {};
  for (const item of list) {
    if (item?.name) map[item.name] = item;
  }
  return map;
}

/**
 * 从后端 API 或 GeoJSON 文件异步加载建筑属性数据。
 * 支持：
 *   - GeoJSON FeatureCollection（public/data/buildings.geojson）
 *   - 后端返回的数组 [{ name, height, department, ... }]
 *   - 后端包装结构 { data: [...] } / { list: [...] }
 */
export async function fetchBuildingData(url: string): Promise<BuildingDataMap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`加载失败：HTTP ${res.status}`);
  const json = await res.json();

  if (json?.type === 'FeatureCollection') {
    return loadBuildingDataFromGeoJSON(json);
  }
  if (Array.isArray(json)) {
    return loadBuildingDataFromArray(json as BuildingProps[]);
  }
  if (Array.isArray(json?.data)) {
    return loadBuildingDataFromArray(json.data as BuildingProps[]);
  }
  if (Array.isArray(json?.list)) {
    return loadBuildingDataFromArray(json.list as BuildingProps[]);
  }
  throw new Error('无法识别的数据格式（期望 GeoJSON FeatureCollection 或属性数组）');
}

/**
 * 示例数据（无真实 GeoJSON / 后端时使用，便于功能联调）。
 * 实际项目中替换为真实数据源即可。
 */
export const SAMPLE_BUILDING_DATA: BuildingDataMap = {
  教学楼: {
    name: '教学楼',
    height: 24,
    department: '教务处',
    campus: '主校区',
    managementDept: '教务处',
    totalFloors: 6,
    roomCount: 48,
    buildingArea: 12800,
    usableArea: 10240,
    category: 'building',
    description: '本科教学主楼，含多媒体教室与智慧教室。',
  },
  实验楼: {
    name: '实验楼',
    height: 20,
    department: '实验实训中心',
    campus: '主校区',
    managementDept: '实验实训中心',
    totalFloors: 5,
    roomCount: 40,
    buildingArea: 9600,
    usableArea: 7680,
    category: 'building',
    description: '承担刑技、网络、电子数据等实验实训教学。',
  },
  图书馆: {
    name: '图书馆',
    height: 18,
    department: '图书馆',
    campus: '主校区',
    managementDept: '图书馆',
    totalFloors: 4,
    roomCount: 32,
    buildingArea: 8600,
    usableArea: 6880,
    category: 'building',
    description: '馆藏纸质图书 51.7 万册，电子图书 42 万册。',
  },
  警体综合训练馆: {
    name: '警体综合训练馆',
    height: 16,
    department: '警体部',
    campus: '主校区',
    managementDept: '警体部',
    totalFloors: 3,
    roomCount: 24,
    buildingArea: 15000,
    usableArea: 12000,
    category: 'building',
    description: '含射击馆、搏击馆、泅渡馆、模拟街区等训练场馆。',
  },
  学生公寓: {
    name: '学生公寓',
    height: 15,
    department: '后勤保障',
    campus: '主校区',
    managementDept: '学生工作处',
    totalFloors: 5,
    roomCount: 40,
    buildingArea: 7200,
    usableArea: 5760,
    category: 'building',
    description: '4 人一间，独立卫浴，配备空调与热水。',
  },
  食堂: {
    name: '食堂',
    height: 10,
    department: '后勤保障',
    campus: '主校区',
    managementDept: '后勤保障处',
    totalFloors: 2,
    roomCount: 16,
    buildingArea: 3200,
    usableArea: 2560,
    category: 'building',
    description: '学生食堂，提供多样化餐饮服务。',
  },
};
