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
  /**
   * 俯仰角上限（度）。旋转地图时只允许「水平 / 俯视旋转」，不允许把地图翻过来。
   * 拖动旋转若导致俯仰超过本值，会自动拉回本值。默认 = pitch（保持初始俯视角不变）。
   */
  maxPitch?: number;
  /**
   * 俯仰角下限（度）。默认 0（正上方俯视，最平）。保持 0 可避免地图被「掀起来」。
   */
  minPitch?: number;
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
  /**
   * GLB 节点名 → 真实楼栋名 的别名映射表。
   *
   * 背景：点击 3D 模型 / 搜索得到的名字是「GLB 文件里的节点名」（如 RoofShed_Rig / 63 /
   * Parapet_Obj5），而导入 DXF、查看楼层图用的是 buildingData 里的真实楼栋名（如「教学楼」）。
   * 当两者不一致时，点模型弹出的属性面板与「查看图纸」会因名字对不上而查不到数据。
   *
   * 本表用于手动对齐：key = GLB 节点名（取 resolveMeshBuildingNames 算出的那个），
   * value = buildingData 里的楼栋名。命中别名的优先级高于「按经纬度就近匹配」。
   * 不知道对应关系是正常的——可留空，系统会退化为「按点击点经纬度就近匹配已导入楼栋指纹」。
   *
   * 例：{ '63': '教学楼', 'RoofShed_Rig': '食堂' }
   */
  buildingNameAliases: Record<string, string>;
  /**
   * 模型节点过滤：加载模型时按「节点名（GLB node name）」保留或隐藏部分子节点。
   *
   * 背景：Blender 导出 GLB 会把整个场景一起导出——屋顶棚(RoofShed)、女儿墙(Parapet)、
   * 大门(Door)、廊架(Pergola)、空物体(Empty/CamTarget)、骨架(Rig) 等辅助几何全部进文件，
   * 在地图上并不需要显示。本配置可让加载时自动隐藏它们。
   *
   * - mode: 'exclude' 隐藏命中的节点（默认，保留其余）；'include' 只保留命中的节点。
   * - patterns: 子串匹配（不区分大小写），命中节点名即执行对应操作（含其整棵子树）。
   *
   * 例（默认）：隐藏屋顶棚/女儿墙/大门/廊架/骨架/空物体：
   *   { mode: 'exclude', patterns: ['roof','parapet','door','pergola','rig','empty','camtarget','profile'] }
   *
   * 若只想保留编号为 1~25 的楼本体，可改为 include 模式并列出这些名字：
   *   { mode: 'include', patterns: ['1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','25'] }
   */
  modelNodeFilter?: {
    mode: 'exclude' | 'include';
    patterns: string[];
  };
  /**
   * 视为「建筑（可点击 / 可选中）」的 GLB 节点名白名单。
   *
   * 模型里并非所有网格都是建筑：Blender 导出时会把屋顶棚(RoofShed)、女儿墙(Parapet)、
   * 大门(Door)、廊架(Pergola)、空物体(Empty/CamTarget)、骨架(Rig)，以及非 0–25 的
   * 数字节点一并导出。本集合明确「哪些节点才是建筑」：
   *
   *  - 只有本集合内的节点可被点击、可被选中高亮；
   *  - 点击建筑时弹出的名称只显示该节点的「数字编号」（如 15），而不是建筑上装饰网格
   *    （如 RoofShed_Rig / Parapet_Obj5 等棚架、女儿墙）的名字；
   *  - 不在本集合内的节点：不可点击、无选中效果（命中它们时直接跳过，不弹窗、不高亮）。
   *
   * 当前模型：数字 0–25 为所有建筑节点（其余节点均非建筑）。
   * 将来换模型或编号范围变化，只改这个数组即可。
   */
  buildingNodeNames: string[];
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
  // 旋转限制：地图可水平旋转（绕竖直轴），但俯仰角被锁在 [0, 55] 之间，
  // 不允许把地图「翻过来」或掀得过高。下限 0 = 正上方俯视。
  maxPitch: 55,
  minPitch: 0,
  // 数字孪生底色：浅灰白底图，周边建筑以浅灰「白模」呈现，路网/绿地/水系清晰可见
  mapStyle: 'amap://styles/whitesmoke',
  modelUrl: '/models/hnjcxy.glb',
  dataUrl: '/data/buildings.geojson',
  roomDataUrl: '/data/rooms.geojson',
  anchor: [110.280328, 19.75491],
  anchorOffset: [0, 0],
  // 注意：当前 hnjcxy.glb 实测（应用节点变换后的世界坐标包围盒）为
  //   宽 549 × 高 21 × 深 560（单位，中心基本就在原点，已是 Y-up 站立姿态）。
  // 模型高度仅 21 单位 → 极可能是「米」为单位（一栋约 21 米高的建筑），故 modelScale 取 1。
  // ⚠️ 之前误把高度当成 1003（脏数据）而设成 0.01，结果被压成 0.21 米薄片导致「看不见模型」。
  // 若替换后模型偏大/偏小，只需按真实尺寸调整本值：
  //   最终高度(米) = 21 × modelScale；最终底边宽度(米) = 549 × modelScale。
  //   例：若真实楼宽约 60 米 → modelScale ≈ 60/549 ≈ 0.11；若真实楼高约 40 米 → modelScale ≈ 40/21 ≈ 1.9。
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
  buildingNameAliases: {},
  mapFeatures: ['bg', 'road', 'building'],
  showLabel: false,
  // 隐藏 Blender 一并导出的辅助几何（屋顶棚/女儿墙/大门/廊架/骨架/空物体），只留楼本体可见；
  // 具体的「可点击 / 可选中」范围由 buildingNodeNames 单独控制（数字 0–25 才是建筑）。
  modelNodeFilter: {
    mode: 'exclude',
    patterns: ['roof', 'parapet', 'door', 'pergola', 'rig', 'empty', 'camtarget', 'profile'],
  },
  // 可点击 / 可选中的建筑节点白名单（点击只显示这些节点的数字编号，其余不可点击）
  buildingNodeNames: Array.from({ length: 26 }, (_, i) => String(i)),
};
