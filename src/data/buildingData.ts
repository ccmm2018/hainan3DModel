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

import { normalizeGeoJSONToGcj02 } from '../utils/coordTransform';

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
  /** 类型：building / road / water / other（对象类型，与业务分类 bizCategory 不同） */
  category?: 'building' | 'road' | 'water' | 'other';
  /**
   * 业务分类 ID（统计口径，如 teaching / lab / library ...）。
   * 与 BUILDING_CATEGORIES 的 id 对应；未显式声明时按楼名兜底归类。
   * 这是「楼栋类别」的唯一数据来源——统计弹窗的饼图 / 校区概况 / 楼栋汇总
   * 全部由它派生，不再在组件里各写一套正则。
   */
  bizCategory?: string;
  /** 备注描述 */
  description?: string;
  /** 任意附加属性 */
  [key: string]: unknown;
}

/** 楼栋业务分类元数据（统计口径唯一来源） */
export interface BuildingCategoryMeta {
  id: string;
  label: string;
  color: string;
  order: number;
  /** 楼名兜底匹配规则（数据未显式写 bizCategory 时用） */
  match: RegExp;
}

/**
 * 楼栋业务分类字典。改类别只改这里，饼图 / 汇总 / 详情自动一致。
 * 顺序即图例与下钻列表的默认顺序。
 */
export const BUILDING_CATEGORIES: BuildingCategoryMeta[] = [
  { id: 'teaching', label: '教学科研类', color: '#2f6fb0', order: 1, match: /教学|科研|办公楼/ },
  { id: 'lab', label: '实验实训类', color: '#7a5fc0', order: 2, match: /实验|实训/ },
  { id: 'library', label: '图书文化类', color: '#3a9b8e', order: 3, match: /图书/ },
  {
    id: 'sports', label: '体育训练类', color: '#d98b2b', order: 4,
    match: /体育|训练馆|游泳|射击|搏击|琴剑|模拟街区|模拟法庭/,
  },
  { id: 'life', label: '生活服务类', color: '#c0507a', order: 5, match: /公寓|宿舍|食堂|生活/ },
];
export const OTHER_CATEGORY: BuildingCategoryMeta = {
  id: 'other', label: '其他', color: '#8894a6', order: 99, match: /$^/,
};

/** 校区展示顺序（未在基础数据 campus 字段出现过的校区自动追加到末尾） */
export const CAMPUS_ORDER: string[] = ['主校区', '东校区', '西校区'];

/** 解析楼栋业务分类：优先数据显式字段，兜底楼名规则 */
export function resolveBizCategory(
  b: Pick<BuildingProps, 'name' | 'bizCategory'>,
): BuildingCategoryMeta {
  if (b.bizCategory) {
    const hit = [...BUILDING_CATEGORIES, OTHER_CATEGORY].find(
      (c) => c.id === b.bizCategory || c.label === b.bizCategory,
    );
    if (hit) return hit;
  }
  const name = b.name ?? '';
  for (const c of BUILDING_CATEGORIES) if (c.match.test(name)) return c;
  return OTHER_CATEGORY;
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
      bizCategory: p.bizCategory ?? p.biz_category ?? p.categoryName ?? p.category_name,
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
    return loadBuildingDataFromGeoJSON(normalizeGeoJSONToGcj02(json));
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
    bizCategory: 'teaching',
    description: '本科教学主楼，含多媒体教室与智慧教室。',
  },
  实验楼: {
    name: '实验楼',
    height: 20,
    department: '实验实训中心',
    campus: '东校区',
    managementDept: '实验实训中心',
    totalFloors: 5,
    roomCount: 40,
    buildingArea: 9600,
    usableArea: 7680,
    category: 'building',
    bizCategory: 'lab',
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
    bizCategory: 'library',
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
    bizCategory: 'sports',
    description: '含射击馆、搏击馆、泅渡馆、模拟街区等训练场馆。',
  },
  学生公寓: {
    name: '学生公寓',
    height: 15,
    department: '后勤保障',
    campus: '西校区',
    managementDept: '学生工作处',
    totalFloors: 5,
    roomCount: 40,
    buildingArea: 7200,
    usableArea: 5760,
    category: 'building',
    bizCategory: 'life',
    description: '4 人一间，独立卫浴，配备空调与热水。',
  },
  食堂: {
    name: '食堂',
    height: 10,
    department: '后勤保障',
    campus: '西校区',
    managementDept: '后勤保障处',
    totalFloors: 2,
    roomCount: 16,
    buildingArea: 3200,
    usableArea: 2560,
    category: 'building',
    bizCategory: 'life',
    description: '学生食堂，提供多样化餐饮服务。',
  },

  // —— 导入向导 / 2.5D 查看器 演示楼栋（key = GLB 节点名）——
  node_jiaoxueA: {
    name: 'node_jiaoxueA',
    height: 24,
    department: '教务处',
    campus: '主校区',
    managementDept: '教务处',
    totalFloors: 2,
    roomCount: 24,
    buildingArea: 1296,
    usableArea: 1100,
    category: 'building',
    bizCategory: 'teaching',
    description: '教学楼A栋（演示）：2 层图纸、各 12 间房、字段完整、带楼栋指纹。',
    // —— 楼栋指纹字段：通过 BuildingProps 索引签名挂载，不修改接口定义 [约束9] ——
    // 以下值与 seedMockFloorPlans 注入的图纸一致；运行时被刷新覆盖。
    centerUtm: [440124, 4100113] as [number, number],
    outline: [
      [440100, 4100100],
      [440148, 4100100],
      [440148, 4100127],
      [440100, 4100127],
    ] as [number, number][],
    azimuth: 0,
    footprintArea: 1296,
  },
  node_shixun: {
    name: 'node_shixun',
    height: 18,
    department: '实训中心',
    campus: '主校区',
    managementDept: '实训中心',
    totalFloors: 1,
    roomCount: 12,
    buildingArea: 960,
    usableArea: 820,
    category: 'building',
    bizCategory: 'lab',
    description: '实训楼（演示）：1 层局部坐标图纸（mm），用于演示 AnchorPicker 手工配准流程。',
  },
  node_tushuguan: {
    name: 'node_tushuguan',
    height: 18,
    department: '图书馆',
    campus: '主校区',
    managementDept: '图书馆',
    totalFloors: 4,
    roomCount: 0,
    buildingArea: 8600,
    usableArea: 6880,
    category: 'building',
    bizCategory: 'library',
    description: '图书馆（演示）：尚未导入任何室内图纸，用于演示「暂无室内图纸」空状态。',
  },
};
