/**
 * 场景全局配置
 *
 * 关键说明：
 * - `center` / `anchor` 使用 WGS84 经纬度（[lng, lat]）。
 *   代码内部会自动完成 WGS84 → GCJ-02 转换，以对齐高德底图（GCJ-02）。
 * - `anchor` 是 GLB 模型放置的锚点，模型原点将对齐到该经纬度。
 * - `anchorOffset` 用于「微调对齐」：以米为单位，[东向, 北向]，正值向东/北偏移。
 */

export interface SceneConfig {
  /** 地图中心（WGS84 [lng, lat]） */
  center: [number, number];
  /** 初始缩放级别 */
  zoom: number;
  /** 初始倾斜角（3D 视角） */
  pitch: number;
  /** 高德地图样式 */
  mapStyle?: string;
  /** GLB 模型文件路径（相对 public 目录） */
  modelUrl: string;
  /** 建筑属性数据源（GeoJSON 文件路径或后端 API URL），留空则用内置示例数据 */
  dataUrl: string;
  /** 房间数据源（楼盘表），GeoJSON 文件路径或后端 API URL，留空则用内置示例数据 */
  roomDataUrl: string;
  /** 模型锚点（WGS84 [lng, lat]），默认 = center */
  anchor?: [number, number];
  /** 锚点微调偏移（米，[东向, 北向]），用于模型与底图的精确对齐 */
  anchorOffset: [number, number];
  /** 模型整体缩放系数（模型单位通常为米，保持 1） */
  modelScale: number;
  /** 模型海拔高度（米） */
  modelElevation: number;
  /** 是否在放置前将模型重新居中（以自身包围盒中心为原点） */
  recenterModel: boolean;
  /**
   * 模型坐标轴旋转（欧拉角，度）。
   * glTF 为 Y-up，而高德 customCoords 为 Z-up（z=高度），
   * 需绕 X 轴 +90° 把 Y 轴转到 Z 轴（[90, 0, 0]）。
   * 若模型朝向不对，再调第三个分量（绕 Z 轴）对齐正北。
   */
  modelRotation: [number, number, number];
  /** 拾取高亮颜色 */
  highlightColor: string;
  /** 悬停高亮颜色 */
  hoverColor: string;
  /** 点击建筑时飞行的目标缩放级别 */
  focusZoom: number;
  /** 楼盘表：每个房间格子的厚度（米） */
  roomCellThickness: number;
  /** 楼盘表：楼层网格悬浮在建筑屋顶上方的高度（米） */
  roomGridOffset: number;
  /** 楼盘表：房间格子之间的间距系数（0~1，越小缝隙越大） */
  roomCellGap: number;
  /** 室内视角：双击进入后的缩放级别 */
  indoorZoom: number;
  /** 室内视角：进入后的倾斜角 */
  indoorPitch: number;
  /** 预留楼层组数（为将来 CAD 室内模型挂载用） */
  defaultFloorCount: number;
  /** 房屋分配提交后端 API 地址（留空则本地模拟） */
  allocationApiUrl: string;
}

/**
 * 海南警察学院（海口市秀英区东山镇定海大道 1 号）
 * WGS84 真实坐标：110.280328, 19.754910
 * （由腾讯地图 GCJ-02 坐标 110.284593, 19.753006 反算得到）
 */
export const DEFAULT_SCENE_CONFIG: SceneConfig = {
  center: [110.280328, 19.75491],
  zoom: 16.5,
  pitch: 55,
  mapStyle: 'amap://styles/whitesmoke',
  modelUrl: '/models/hnjcxy.glb',
  dataUrl: '/data/buildings.geojson',
  roomDataUrl: '/data/rooms.geojson',
  anchor: [110.280328, 19.75491],
  anchorOffset: [0, 0],
  modelScale: 1,
  modelElevation: 0,
  recenterModel: true,
  modelRotation: [90, 0, 0],
  highlightColor: '#38bdf8',
  hoverColor: '#fbbf24',
  focusZoom: 18.5,
  roomCellThickness: 0.8,
  roomGridOffset: 2,
  roomCellGap: 0.92,
  indoorZoom: 20,
  indoorPitch: 40,
  defaultFloorCount: 4,
  allocationApiUrl: '',
};
