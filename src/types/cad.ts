/**
 * CAD / 楼层平面图 新增数据结构（本功能新增，不改动 BuildingProps）。
 *
 * 四层树：Building（已有）→ Floor（新增）→ Room（新增）
 *
 * - 楼栋外键统一使用 buildingName（= BuildingProps.name，即 GLB 节点名）。
 * - Building 上的指纹字段（centerUtm / outline / azimuth / footprintArea）通过
 *   BuildingProps 的 `[key: string]: unknown` 索引签名挂载，本文件只给出类型，
 *   不修改 BuildingProps 接口定义。
 * - Room 同时保留两类状态：
 *     · inspectStatus：审图 / 质检标记（导入向导预览阶段用，入库后留作质检记录）
 *     · useStatus：正式业务占用状态（使用中 / 无权限 / 空置），导入时可空，后续手工分配
 *   FloorPlan2D 渲染支持按 inspectStatus / useStatus / 部门 / 用途 四种方式分色。
 */

/** 坐标来源：utm = 图纸已是 UTM 49N（米）；local = 局部坐标，需 FloorTransform 变换 */
export type CoordSource = 'utm' | 'local';

/** 长度单位（DXF $INSUNITS 或跨度推断） */
export type LengthUnit = 'm' | 'cm' | 'mm' | 'unknown';

/** 审图 / 质检状态 */
export type InspectStatus = 'normal' | 'highlight' | 'warning' | 'partial';

/** 业务占用状态（可空，用 '' 表示未分配） */
export type UseStatus = 'occupied' | 'noaccess' | 'vacant' | '';

/** 楼栋指纹：挂载在 BuildingProps 上（通过索引签名），第一份图纸确认入库时写回 */
export interface BuildingFingerprint {
  /** 楼栋中心点 UTM 49N（米） */
  centerUtm?: [number, number];
  /** 楼栋外轮廓（UTM 米） */
  outline?: [number, number][];
  /** 方位角（度，正北顺时针） */
  azimuth?: number;
  /** 占地面积 ㎡ */
  footprintArea?: number;
  /** 中心点 GCJ-02 经纬度（高德定位用，由 centerUtm 派生，可选） */
  centerGcj02?: [number, number];
}

/**
 * 楼层平面图图层语义角色。
 * 真实图纸图层名千差万别，解析时按别名表 + 模糊匹配归一到以下角色之一。
 */
export type FloorPlanLayerRole =
  | 'floorOutline' // 楼层外轮廓线（楼栋指纹唯一来源）
  | 'outerWall' // 内部结构外墙线（双线外墙）
  | 'innerWall' // 内部结构内墙线（房间闭合轮廓 + 文本所在层）
  | 'columnWindow' // 柱子及窗户线
  | 'other';

/** 闭合多段线（已算面积 / 质心） */
export interface ClosedPolyline {
  /** 顶点（DXF 局部坐标） */
  polygon: [number, number][];
  /** 质心（局部坐标） */
  centroid: [number, number];
  /** 面积（DXF 原始单位平方） */
  area: number;
  /** 来源图层名 */
  layer: string;
}

/** 图纸局部坐标 → UTM 的二维相似变换（先旋转，再缩放，再平移） */
export interface FloorTransform {
  /** 平移（UTM 米） */
  offset: [number, number];
  /** 旋转（弧度） */
  rotation: number;
  /** 缩放（毫米图纸 = 0.001，米图 = 1） */
  scale: number;
}

/** 单层楼（新增，外键 buildingName） */
export interface Floor {
  /** `${buildingName}-F${floorNo}` */
  id: string;
  /** 所属建筑（外键 = BuildingProps.name） */
  buildingName: string;
  /** 楼层号（从 1 开始） */
  floorNo: number;
  /** 楼层名称，如 "3F" / "第3层" */
  name: string;
  /** 层高（米），默认 3.2 */
  height: number;
  /** 层底标高（米） */
  elevation: number;
  /** 楼层外轮廓（已变换到 UTM 米） */
  outline: [number, number][];
  /** 房间数 */
  roomCount: number;
  /** 解析状态 */
  status: 'pending' | 'parsed' | 'partial' | 'failed';
  /** failed / partial 时的可读原因，必须持久化可查看 */
  errorReason?: string;
  /** 解析告警（partial / failed 时一并持久化，便于事后排查）；parsed 时也保留解析阶段告警 */
  warnings?: ParseWarning[];
  /** 来源 DXF 文件名 */
  dxfFile?: string;
  /** 图纸原始坐标来源 */
  coordSource: CoordSource;
  /** coordSource='local' 时必填 */
  transform?: FloorTransform;
}

/** 单个房间（新增） */
export interface Room {
  /** `${floorId}-${index}` */
  id: string;
  /** 所属楼层（外键 = Floor.id） */
  floorId: string;
  /** 房间号（文本，如 "101"） */
  code: string;
  /** 房间编号（同 code，保留用于排序/检索） */
  number: string;
  /** 房间名称 / 标签 */
  name: string;
  /** 使用部门 */
  dept: string;
  /** 房间用途（用于分色） */
  usePurpose: string;
  /** 使用面积 ㎡ */
  useArea: number;
  /** 建筑面积 ㎡ */
  buildArea: number;
  /** 轮廓（UTM 米） */
  outline: [number, number][];
  /** 质心（UTM 米） */
  centroid: [number, number];
  /** 审图 / 质检状态 */
  inspectStatus: InspectStatus;
  /** 业务占用状态（可空） */
  useStatus: UseStatus;
  /** 房间内未被采用的其余 TEXT（材质 / 注释等） */
  remark?: string;
  /** 预览确认阶段用户可剔除误识别房间 */
  selected?: boolean;
}

// ---------------------------------------------------------------------------
// 解析阶段（入库前）的候选结构
// ---------------------------------------------------------------------------

/** DXF 图层 */
export interface DxfLayer {
  name: string;
  /** AutoCAD 颜色索引（ACI） */
  color?: number;
}

/** 解析告警 / 错误 */
export interface ParseWarning {
  /** 可机读代码 */
  code: string;
  /** 级别 */
  level: 'error' | 'warn';
  /** 可读信息 */
  message: string;
}

/** 房间候选（已关联字段，尚未入库为 Room） */
export interface ParsedRoom {
  id: string;
  buildingName: string;
  floorNo: number;
  /** 房间号（如 101） */
  code: string;
  /** 房间编号（字符串，同 code） */
  number: string;
  /** 显示名 */
  name: string;
  /** 使用部门（DXF 文本通常无法提供，默认空） */
  dept: string;
  /** 房间用途（由关键词推断，默认空） */
  usePurpose: string;
  /** 使用面积 ㎡（来自「使用面积」字段，解析不到为 0） */
  useArea: number;
  /** 建筑面积 ㎡（来自「建筑面积」字段，解析不到为 0） */
  buildArea: number;
  /** 轮廓（DXF 局部坐标） */
  polygon: [number, number][];
  /** 质心（局部坐标） */
  centroid: [number, number];
  /** 面积（DXF 原始单位平方，多边形几何面积） */
  area: number;
  /** 审图状态（解析结果默认 normal，由匹配质量决定） */
  inspectStatus: InspectStatus;
  /** 业务状态（导入时默认空，后续手工分配） */
  useStatus: UseStatus;
  /** 房间内未被采用的其余 TEXT（材质 / 注释等） */
  remark?: string;
  /** 预览确认阶段是否保留（用户可取消勾选剔除误识别房间） */
  selected: boolean;
  /** 来源图层 */
  layers: string[];
  /** 未被采用 / 未匹配的 TEXT 列表（供 remark 参考） */
  unmatchedTexts: string[];
}

/** 包围盒 */
export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** DXF 解析结果 */
export interface DxfParseResult {
  layers: DxfLayer[];
  /** 已关联字段的房间候选 */
  rooms: ParsedRoom[];
  warnings: ParseWarning[];
  /** 坐标来源（自动推断，界面可改） */
  coordSource: CoordSource;
  /** 单位（自动推断，界面可改） */
  unit: LengthUnit;
  /** 原始坐标包围盒 */
  bbox: BBox;
  /** 楼层外轮廓（来自「楼层外轮廓线」图层，楼栋指纹唯一来源；缺失时为 null） */
  floorOutline: ClosedPolyline | null;
  /** 内部结构外墙（双线外墙，仅用于诊断 / 渲染，不参与指纹） */
  outerWalls: ClosedPolyline[];
  /** 柱子（来自「柱子及窗户线」图层） */
  columns: ClosedPolyline[];
  /** 窗户（来自「柱子及窗户线」图层，按层名/尺寸区分；无法区分时归入 columns） */
  windows: ClosedPolyline[];
  /** 识别到的图层名 → 语义角色映射 */
  layerRoles: Record<string, FloorPlanLayerRole>;
}
