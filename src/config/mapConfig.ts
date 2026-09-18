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
  /** 高德地图样式（内置：whitesmoke / light / normal / grey / fresh 等；
   *  也可填高德控制台「自定义地图」发布的样式 ID：amap://styles/<styleId>，
   *  以彻底统一底图色系为项目专属配色）。
   *  注意：数字孪生展示推荐使用浅色底图（whitesmoke / light），
   *  浅色底图下高德 3D 建筑会以浅灰「白模」呈现，叠加路网 / 绿地 / 水系更清晰。 */
  mapStyle?: string;
  /**
   * 底图显示要素（底图降噪用）。
   * 可选值：bg(区域面) / road(道路) / building(建筑) / point(兴趣点 POI)。
   * 默认去掉 point（POI），保留背景 / 道路 / 建筑，让底图更干净。
   */
  mapFeatures: string[];
  /** 是否显示地图文字注记（地名 / 路名等）。底图降噪时设为 false */
  showLabel: boolean;
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
  /**
   * 是否隐藏高德地图左下角的 logo 与版权信息。
   *
   * ⚠️ 合规提醒（务必阅读）：
   * 高德地图 JS API「免费版」的《服务条款》要求必须保留地图 logo 与版权信息，
   * 且 API 会在每次渲染时重新注入这些节点，仅靠删除 DOM 无法彻底去除。
   * 隐藏它们仅在「已获得高德商用授权」的前提下才合规；否则属于违反服务条款，
   * 高德有权限制 / 封禁对应 key 的使用。
   *
   * 因此该开关默认关闭（false）以保证免费版合规；
   * 请在你已与高德签订商用授权、明确允许去除品牌标识后再置为 true。
   */
  hideAMapAttribution: boolean;
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
  // 数字孪生底色：浅灰白底图，周边建筑以浅灰「白模」呈现，路网/绿地/水系清晰可见
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
  hideAMapAttribution: false,
  mapFeatures: ['bg', 'road', 'building'],
  showLabel: false,
};
