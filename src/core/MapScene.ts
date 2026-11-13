/**
 * MapScene —— 高德地图 + Three.js 融合核心
 *
 * 技术要点：
 * 1. 高德地图作为底图（viewMode: '3D'）。
 * 2. 通过 AMap.GLCustomLayer 将 Three.js 场景叠加到地图上，共享同一个 WebGL 上下文。
 * 3. 每帧用 map.customCoords.getCameraParams() 同步地图相机到 Three.js 相机。
 * 4. renderer.autoClear = false 保留底图；renderer.resetState() 重置 GL 状态。
 * 5. 模型放置：WGS84 锚点 → GCJ-02 → customCoords.lngLatToCoord() → 世界坐标。
 * 6. 交互：Raycaster 拾取 Mesh，高亮、悬停、点击、按名称飞行定位。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { wgs84ToGcj02, gcj02ToWgs84 } from '../utils/coordTransform';
import type { SceneConfig } from '../config/mapConfig';
import { ROOM_STATUS_CONFIG, type Room } from '../data/roomData';
import area from '@turf/area';

/** 首屏性能量算基准：模块脚本执行时刻（≈页面交互起点），用于把各阶段耗时统一到「距页面加载」 */
const SCENE_T0 = performance.now();

/** 常驻楼栋名称标签的数据结构 */
interface BuildingLabel {
  node: string; // GLB 节点名（数字主键，0–25）
  display: string; // 显示名（真实楼名，来自 buildingNameAliases）
  obj: THREE.Object3D; // 对应建筑节点（用于按校准后的世界矩阵重算锚点）
  anchor: THREE.Vector3; // 楼栋世界坐标顶端中心（缓存，校准后重建）
  el: HTMLDivElement;
}

/** 拾取结果 */
export interface PickResult {
  /** 被射线命中的 Mesh */
  object: THREE.Object3D;
  /** 可选择的父对象（命名分组，通常是「建筑/道路/水系」） */
  target: THREE.Object3D;
  /** 对象名称 */
  name: string;
  /** 命中点的世界坐标 */
  point: THREE.Vector3;
  /** 命中点对应的 WGS84 经纬度 */
  lngLat: [number, number];
  /** 屏幕坐标（用于 tooltip 定位） */
  screenX: number;
  screenY: number;
  /** 是否命中了房间格子（楼盘表模式） */
  isRoom: boolean;
  /** 命中的房间数据（isRoom 为 true 时有效） */
  room?: Room;
}

/** 测量结果（测距 / 测面） */
export interface MeasureResult {
  mode: 'distance' | 'area';
  /** 测距：各分段长度（米） */
  segments?: number[];
  /** 测距总长度（米）或测面面积（㎡） */
  value: number;
  /** 已打点数 */
  points: number;
}

/**
 * 模型校准（微调对齐）参数。在 config 的基础定位之上叠加，
 * 全部为「增量」，默认 0/1 表示与 config 一致：
 * - offsetX / offsetY：东向 / 北向平移（米），叠加在 config.anchorOffset 之上；
 * - rotationZ：绕竖直轴的朝向微调（度），叠加在 config.modelRotation[2] 之上；
 * - elevation：海拔高度微调（米），叠加在 config.modelElevation 之上；
 * - scale：缩放倍率（1 = 不变），最终缩放 = config.modelScale × scale。
 */
export interface ModelCalibration {
  offsetX: number;
  offsetY: number;
  rotationZ: number;
  elevation: number;
  scale: number;
}

/** 校准参数默认值（与 config 完全一致，未做任何微调） */
export const DEFAULT_CALIBRATION: ModelCalibration = {
  offsetX: 0,
  offsetY: 0,
  rotationZ: 0,
  elevation: 0,
  scale: 1,
};

export interface MapSceneCallbacks {
  onModelProgress?: (percent: number) => void;
  /** 模型加载后处理阶段进度（贴图解码 / 优化 / 检测等），用于在加载遮罩上显示当前步骤，避免「卡在 100%」的观感 */
  onModelStage?: (label: string, done?: number, total?: number) => void;
  onModelReady?: () => void;
  /**
   * 自动取景完成（视角已收敛稳定）时触发。
   * 加载遮罩应保持到本回调之后才揭开——初始取景与迭代微调的视角跳变
   * 都发生在遮罩后面，用户看到的第一个画面就是最终稳定视角。
   * （fitToBuildings 未挂微调时也会同步触发一次。）
   */
  onFitComplete?: () => void;
  onModelError?: (err: unknown) => void;
  onMapError?: (err: unknown) => void;
  /** 悬停（未命中时为 null） */
  onHover?: (result: PickResult | null) => void;
  /** 点击选中（未命中时为 null） */
  onSelect?: (result: PickResult | null) => void;
  /** 双击（未命中时为 null），用于进入室内视角 */
  onDoubleClick?: (result: PickResult | null) => void;
  /**
   * 地图视角变化时触发（平移 / 缩放 / 旋转 / 俯仰 / 飞行）。
   * 用于让锚定在模型节点上的浮层（属性面板、房间详情）跟随节点移动。
   */
  onViewChange?: () => void;
  /** 测量结果更新回调（测距 / 测面；传 null 表示清除） */
  onMeasureUpdate?: (data: MeasureResult | null) => void;
  /** 测量进行中状态变化（true=正在打点，false=已完成/已清除），用于「完成」按钮显隐 */
  onMeasureActive?: (active: boolean) => void;
}

/** 模型数据概览：全部由运行时遍历当前已加载的 GLB 统计得出，不含任何写死/示例数值。
 *  上层在 onModelReady 之后调用 getModelStats() 取用。 */
export interface ModelStats {
  /** 可拾取/可搜索的楼栋节点数（listObjects 口径） */
  buildings: number;
  /** glTF 场景节点总数 */
  nodes: number;
  /** 实际可见的网格数（父级被过滤隐藏的不计入） */
  meshes: number;
  /** 可见网格的顶点总数 */
  vertices: number;
  /** 可见网格的三角面总数 */
  triangles: number;
  /** 去重后的材质数 */
  materials: number;
  /** 去重后的贴图数 */
  textures: number;
  /** GLB 文件字节数（优先取实际下载缓冲长度，退化取 Content-Length） */
  bytes: number;
  /** 下载+解析耗时 ms */
  parseMs: number;
  /** 下载+解析+后处理+挂载总耗时 ms */
  loadMs: number;
  /** 上一帧的 draw call 数（renderer.info，可能为 0） */
  drawCalls: number;
  /** 模型 URL 上的版本号，如 20261112l */
  version: string;
}

const R_METERS_PER_DEG = 111319.49; // 墨卡托经度方向 米/度

export class MapScene {
  private container: HTMLDivElement;
  private config: SceneConfig;
  private callbacks: MapSceneCallbacks;

  private map: any = null;
  private customCoords: any = null;
  private glLayer: any = null;

  private renderer: THREE.WebGLRenderer | null = null;
  private lowEnd = false; // 低配设备标记：用于降低渲染负载（关阴影 / 跳过 PMREM / 像素比封顶）
  private loadStartTs = 0; // 模型下载+解析发起时刻（prefetchModel 或 startModelLoad 入口），用于量「下载+解析」耗时
  private onLoadEntryTs = 0; // 模型解析完成的入口时刻（下载+解析完成后），用于把耗时拆分为「下载/解析」与「后处理」两段
  private modelReadyTs = 0;  // 模型挂载完成（onModelReady 触发前）时刻，用于统计总加载耗时
  private modelBytes = 0;    // GLB 字节数，来自预取缓冲或下载进度事件的 Content-Length
  private modelPrefetchGltf: any = null;   // 已解析完成的 GLTF（来源：预取缓冲或即时 load）
  private modelPrefetchStarted = false;    // 预取是否已发起（防止重复下载同一模型）
  private modelOnLoadRan = false;          // runModelOnLoad 是否已执行（防止重复后处理/挂载）
  private ready = false;                   // initThree 完成（renderer/scene/customCoords 均就绪）标记
  private prefetchStartTs = 0;             // 模型预取发起时刻，用于日志
  private prefetchedBuffer: ArrayBuffer | null = null; // 提前并行下载的 GLB 二进制（await loadAMap 期间），就绪后直接 parse
  private prefetchedUrl = '';              // 与 prefetchedBuffer 对应的模型地址
  private prefetchFetch: Promise<ArrayBuffer> | null = null; // 下载「进行中」的 fetch promise：组件层在 await loadAMap 期间发起，直接交给我们复用，使「模型下载」与「高德 WebGL 初始化」完全并行且不重复拉取
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private modelRoot: THREE.Object3D | null = null;
  private raycaster = new THREE.Raycaster();
  /** 已应用的渲染视口（CSS 像素，three 会再乘 pixelRatio）。尺寸变化时重设，保证模型铺满整块高德画布 */
  private appliedVpW = -1;
  private appliedVpH = -1;
  /** 上一帧的地图视角签名，用于检测视角变化 */
  private lastViewSig = '';
  /** 上一帧用于同步相机的视角签名；与 lastViewSig 一致时说明视角未变，可复用相机、跳过 getCameraParams 重算 */
  private lastCamSyncSig = '';
  /**
   * fitToBuildings 取景后的迭代微调数据。
   * 「距离→缩放」换算依赖高德内部相机模型，可能与实际有偏差（偏近/偏远），
   * 故取景后在 render() 里用真实相机逐帧复核：按实测「出画倍率」比例修正 zoom，
   * 直到全部建筑角点都落在屏幕安全区（收敛于「刚好能看到全部建筑」的最大缩放）。
   * startedAt 超时后放弃（避免与用户操作打架）。
   */
  private fitRefine: {
    corners: THREE.Vector3[];
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    /** 取景中心（GCJ-02 [lng, lat]，= 建筑群实际中心，保证模型居中于屏幕） */
    center: [number, number];
    /** 取景俯仰角（自适应搜索所得，微调全程保持不变） */
    pitch: number;
    /** 上一次我们主动设置的 zoom / center（识别相机是否已生效 / 是否被用户改动） */
    lastZoom: number;
    lastCenter: [number, number];
    /** 剩余迭代次数 */
    tries: number;
    /** 开始时间戳（ms），超时放弃 */
    startedAt: number;
  } | null = null;

  private gcjCenter: [number, number];
  private gcjAnchor: [number, number];
  /** 锚点（含微调偏移）在 customCoords 空间的坐标 */
  private anchorWorld = new THREE.Vector3();

  /** 当前高亮对象（用于 clearHighlight 还原） */
  private highlightedObject: THREE.Object3D | null = null;

  // —— 悬停拾取节流相关字段 ——
  /** 由 mousemove 写入的最新待拾取坐标。
   *  拾取必须「随鼠标移动立即触发」，不能依赖 render() 每帧消费——
   *  AMap 自定义图层在地图静止时未必每帧回调 render，若把拾取挂到 render 里，
   *  鼠标在静止地图上移动就不会触发高亮（这正是高亮失效的根因）。 */
  private hoverLatest: { x: number; y: number } | null = null;
  /** 当前帧是否已排程一次拾取（合并一帧内多次 mousemove，保证每帧至多一次 raycast） */
  private hoverRafScheduled = false;
  /** 上一次实际执行拾取的坐标（位移 < 1px 视为同位置跳过，避免原地抖动重复拾取） */
  private lastHoverPos: { x: number; y: number } | null = null;
  /** 各建筑的世界轴对齐包围盒（AABB），用于 raycast 前做廉价粗筛，避免对整模型全量求交 */
  private buildingBoxes: { obj: THREE.Object3D; box: THREE.Box3 }[] = [];
  /** 校准拖拽时阴影重算的防抖定时器（避免每次 setCalibration 都重算阴影图） */
  private shadowUpdateTimer: number | null = null;
  /** 重绘排程标志：将分散在各处的 map.render() 合并为「每动画帧至多一次」，消除重绘风暴（悬停扫楼/拖拽/量算时 CPU 尖峰的主因） */
  private renderScheduled = false;
  /** 悬停用浏览器原生 pointermove（capture）：绕开高德 map.on('mousemove') 的内部事件代理与按需渲染周期 */
  private hoverDomHandler: ((e: PointerEvent) => void) | null = null;
  /** 上一次上报的悬停结果指纹：鼠标在同一栋楼内移动时不重复触发 Vue 更新 / 高亮 / 底图重绘 */
  private lastHoverKey: string | null = null;
  /** 悬停拾取排程的 rAF id（destroy 时取消，避免跨实例泄漏） */
  private hoverRafId: number | null = null;
  /** 原生指针是否按下：部分输入方式下拖动时 pointermove.buttons 会是 0，不能只靠 buttons 判断 */
  private pointerIsDown = false;
  /** 最近一次视角变化时间戳：拖动/缩放/飞行期间一律不做悬停拾取（停下 90ms 再恢复） */
  private lastViewChangeAt = 0;
  private pointerDownHandler: ((e: PointerEvent) => void) | null = null;
  private pointerUpHandler: ((e: PointerEvent) => void) | null = null;
  /** 内容变更后「同步直绘」的时间戳：防止同一帧内多次 markDirty 重复全场景重绘 */
  private lastImmediateDrawAt = 0;
  /** 被 12ms 节流跳过的直绘请求排程标记：保证最后一次内容变更一定上屏（不能丢弃） */
  private immediateDrawScheduled = false;

  /** 楼盘表：房间格子可视化 */
  private roomGroup: THREE.Group | null = null;
  private roomCellMeshes = new Map<string, THREE.Mesh>();
  private roomFloors: number[] = [];
  private currentRoomFloor = 1;
  private hoveredRoomId: string | null = null;

  /** 室内视图状态 */
  private indoorView = false;
  private indoorTarget: THREE.Object3D | null = null;
  private savedCamera: { zoom: number; center: [number, number]; pitch: number; rotation: number } | null = null;
  /** 初始水平朝向（度）：init 时由 config.initialRotation / ?rot= 解析，供 2D→3D 切换后复原 */
  private initialRotation = 0;
  /** 加载取景的额外屏幕平移 [往左, 往远处]（占屏幕宽/高比例）：init 时由 config.viewNudge / ?nx=&ny= 解析 */
  private viewNudge: [number, number] = [0, 0];

  /** 截图捕获请求 */
  private captureResolve: ((dataUrl: string) => void) | null = null;

  /**
   * 渲染策略：AMap 的 GL 自定义图层每帧都会清掉本层帧缓冲后回调 render()，
   * 因此每帧都必须重新叠加绘制模型（不可整帧跳过，否则模型会闪烁/隐藏）。
   *
   * 直接渲染（每帧只画一次场景，无离屏 RT / 全屏贴图）：
   *  - 模型仅 3644 三角面，逐帧直绘开销可忽略；
   *  - 视图静止时，相机同步已节流（见 render() 内 lastViewSig 判断）只跳过「相机重算」，仍每帧直绘；
   *  - 不用离屏 RT 缓存，从根本上杜绝 RT 缓存与直绘两路视觉不一致导致的整模型闪烁
   *    （悬停高亮切换、拖拽起止等场景尤其明显）。
   * 真正的降载来自：相机同步节流、锚点投影防抖、GLB 并行预取，而非帧缓存。
   */
  private disposed = false;

  /** 低配帧缓存：整场景的离屏渲染结果（视角/内容未变的帧直接贴这张图） */
  private frameRt: THREE.WebGLRenderTarget | null = null;
  /** 帧缓存对应的画布尺寸 key，尺寸变化时重建 */
  private frameRtKey = '';
  /** 全屏贴图用的最小场景（正交相机 + 一个 quad） */
  private blitScene: THREE.Scene | null = null;
  private blitCam: THREE.OrthographicCamera | null = null;
  /** 缓存是否失效（视角变化置真，重绘一次场景；内容变化走 contentDirty 分支） */
  private frameCacheDirty = true;
  /** 场景内容变化（高亮 / 楼盘表 / 房间 / 校准等）：置真时走「RT 渲染 + 全屏贴图」分支，
   *  与空闲帧完全一致，避免「直绘↔贴图」路径切换导致整模型闪烁。内容变化是稀有事件（每次悬停切换），
   *  2 趟开销可忽略；视角变化（拖拽/缩放）则走 frameCacheDirty 直绘分支以保持跟手。 */
  private contentDirty = true;
  /** 离屏缓存是否已过期：活动帧直接渲染到屏幕、跳过了 RT 写入时置真；松手后的首个静止帧再补刷新 */
  private rtStale = false;
  /** 离屏缓存彻底不可用标记：极少数环境下 RT 创建失败，置真后退化直绘，保证模型始终可见 */
  private frameCacheBroken = false;
  /** WebGL 软件渲染标记（SwiftShader/llvmpipe 等）：虚拟机会命中；据此关闭离屏 RT 缓存（软件光栅下空闲 blit 仍全屏 CPU 光栅化，比直绘更费），走直绘兜底 */
  private softwareRender = false;
  /** 离屏 RT 缓存是否启用：仅在「真实弱 GPU（hardwareConcurrency<=4）或用户 ?lowend=1」时启用；
   *  软件渲染/老内核·32位 UA 强制的低配下关闭，改走逐帧直绘兜底，避免 RT 缓存在该类环境反而推高 CPU */
  private rtCacheEnabled = true;
  /** 拖拽/缩放/旋转/飞行「交互中」标记：交互期间用低分辨率 RT 渲染压 CPU，静止后恢复高清 */
  private interacting = false;
  /** 交互静止判定定时器（视角变化后 120ms 无新变化视为静止，退出交互态） */
  private interactTimer: ReturnType<typeof setTimeout> | null = null;
  /** 交互期降分辨率离屏 RT（拖拽/缩放时降填充率压 CPU，静止贴图时拉伸到全屏） */
  private frameRtLow: THREE.WebGLRenderTarget | null = null;
  private lowRtW = 0;
  private lowRtH = 0;
  /** 交互期渲染分辨率倍率（0.6 = 填充率降至 36%）：拖动本就在动，略糊可接受，静止恢复全清 */
  private static readonly INTERACT_SCALE = 0.6;
  /** 全屏贴图材质引用（RT 重建后需指向新纹理） */
  private blitMat: THREE.MeshBasicMaterial | null = null;
  /** 页面不可见时暂停渲染，彻底 0 占用 */
  private paused = false;
  /** visibilitychange 处理器引用，用于 destroy 时移除，避免监听器泄漏 */
  private visibilityHandler: (() => void) | null = null;
  /** 地图创建时间戳，用于量算「AMap 初始化 → GL 上下文就绪」耗时，定位首屏 35s 卡顿归属 */
  private mapCreateTs = 0;
  /** 高亮材质缓存（key: `颜色|原材质uuid`），跨悬停复用克隆材质，避免扫过楼群时反复克隆 */
  private highlightMatCache = new Map<string, THREE.Material>();
  /** 主方向光引用（用于模型放置后按包围盒拟合阴影视锥） */
  private dirLight: THREE.DirectionalLight | null = null;

  // 量算（测距 / 测面）状态
  private AMap: any = null;
  private measureMode: 'none' | 'distance' | 'area' = 'none';
  private measureReportMode: 'distance' | 'area' = 'distance';
  /** 量算顶点（GCJ-02 经纬度） */
  private measurePts: [number, number][] = [];
  /** 量算图形独立渲染场景：主场景渲染完再 clearDepth 叠加，保证永远压在 3D 模型之上 */
  private measureScene: THREE.Scene | null = null;
  /** 量算图形容器（挂在 measureScene，不在主 scene 里） */
  private measureGroup: THREE.Group | null = null;
  /** 预览增量更新用的常驻对象引用（避免每次 pointermove 全量 dispose/重建几何） */
  private measureLineObj: THREE.Line | null = null;
  private measureFillObj: THREE.Mesh | null = null;
  /** 是否处于「测量进行中」（已打点、尚未完成） */
  private measuring = false;
  /** pointermove 跟随预览的 rAF 合并：一帧最多一次几何更新 */
  private measurePreviewRaf = 0;
  private measurePreviewPt: [number, number] | null = null;
  /** 测量期间是否已通知上层清除悬停高亮（避免每次 mousemove 都触发一次回调） */
  private measureHoverCleared = false;
  // 容器级 DOM 监听：避免事件被 GLCustomLayer 画布吞掉，且可点在 3D 模型上
  private measureDownHandler: ((e: PointerEvent) => void) | null = null;
  private measureMoveDomHandler: ((e: PointerEvent) => void) | null = null;
  private measureDblDomHandler: ((e: MouseEvent) => void) | null = null;
  private measureClickDomHandler: ((e: MouseEvent) => void) | null = null;
  private measureDownPos: { x: number; y: number; t: number } | null = null;

  /** 视为「建筑（可点击 / 可选中）」的 GLB 节点名白名单（来自 config.buildingNodeNames） */
  private buildingNames = new Set<string>();

  // —— 常驻楼栋名称标签（无需悬停即显示，钉在每栋楼顶端）——
  private labelLayer: HTMLDivElement | null = null;
  private buildingLabels: BuildingLabel[] = [];
  private selectedBuildingName = '';
  private labelsDirty = true;
  private lastLabelSig = '';
  /** 标签重排节流时间戳：拖动时标签 30fps 足够，避免每帧几十次 DOM 写入拖慢渲染 */
  private lastLabelAt = 0;
  private labelStyleInjected = false;

  /** 模型校准（微调对齐）增量参数，叠加在 config 基础定位之上 */
  private calibration: ModelCalibration = { ...DEFAULT_CALIBRATION };
  /**
   * 俯仰角锁定（防止地图被「翻过来」）。
   * 地图旋转（绕竖直轴的 bearing）始终允许，但俯仰角（pitch）被钳制在
   * [minPitch, maxPitch] 区间内——拖动旋转时只做水平 / 俯视旋转，不会掀翻地图。
   * suppressPitchEvent 用于避免 setPitch 拉回俯仰时触发递归相机事件。
   */
  private suppressPitchEvent = false;

  /** 校准持久化的 localStorage key（按模型文件区分，避免不同模型互相串扰） */
  private get calibrationKey(): string {
    return `hnjcxy-calib::${this.config.modelUrl}`;
  }

  constructor(container: HTMLDivElement, config: SceneConfig, callbacks: MapSceneCallbacks = {}) {
    this.container = container;
    this.config = config;
    this.callbacks = callbacks;
    this.buildingNames = new Set(config.buildingNodeNames || []);

    this.gcjCenter = wgs84ToGcj02(config.center[0], config.center[1]);
    const anchor = config.anchor ?? config.center;
    this.gcjAnchor = wgs84ToGcj02(anchor[0], anchor[1]);
  }

  get centerGcj02(): [number, number] {
    return this.gcjCenter;
  }

  get anchorGcj02(): [number, number] {
    return this.gcjAnchor;
  }

  // -------------------------------------------------------------------------
  // 初始化
  // -------------------------------------------------------------------------
  init(AMap: any): void {
    this.AMap = AMap;
    this.mapCreateTs = performance.now();
    // 低配判定需在建图前完成：低配要据此减少底图要素（去 3D 楼块/标注），削减高德每帧开销。
    this.resolveLowEnd();
    // 初始方位：在【创建地图时就把朝向定死】，页面第一帧显示的就是目标方位，
    // 全程不存在「先正北、加载后再转过去」的旋转动作。
    // 注意取景仍在 fitToBuildings() 里按「正北朝向的等效相机」解析计算，
    // 所以 zoom / center / pitch 与默认朝向时期完全一致（见该方法内的 FIXED_BEARING）。
    // URL 参数 ?rot=<角度> 可临时覆盖配置值，方便不重新构建就试角度。
    const urlRot = new URLSearchParams(window.location.search).get('rot');
    const initialRotation = urlRot !== null && Number.isFinite(Number(urlRot))
      ? Number(urlRot)
      : (this.config.initialRotation ?? 0);
    this.initialRotation = initialRotation;
    // 额外屏幕平移：只改取景中心，模型本身、zoom / pitch / rotation 都不动。
    // URL ?nx=&ny= 可临时覆盖，方便不重新构建就把「往左 / 往远处」的量试到位。
    const urlParams = new URLSearchParams(window.location.search);
    const cfgNudge = this.config.viewNudge ?? [0, 0];
    const nx = urlParams.get('nx');
    const ny = urlParams.get('ny');
    this.viewNudge = [
      nx !== null && Number.isFinite(Number(nx)) ? Number(nx) : cfgNudge[0],
      ny !== null && Number.isFinite(Number(ny)) ? Number(ny) : cfgNudge[1],
    ];
    this.map = new AMap.Map(this.container, {
      center: this.gcjCenter,
      zoom: this.config.zoom,
      pitch: this.config.pitch,
      rotation: initialRotation,
      viewMode: '3D',
      mapStyle: this.config.mapStyle || 'amap://styles/dark',
      zooms: [3, 20],
      showLabel: this.config.showLabel,
      rotationEnable: true,
    });
    // 仅当个别高德版本不认构造参数时才补设一次；发生在地图刚创建、加载遮罩尚未揭开时，
    // 用户看不到任何方位变化。构造参数已生效时不会再调用 setRotation。
    if (initialRotation !== 0 && Math.abs(Number(this.map.getRotation?.()) - initialRotation) > 0.01) {
      try { this.map.setRotation(initialRotation); } catch { /* ignore */ }
    }
    // eslint-disable-next-line no-console
    console.info(`[MapScene] 地图创建即 rotation=${Number(this.map.getRotation?.()).toFixed(1)}°（首帧就是目标方位，无加载后旋转）`);

    // 底图降噪：去除 POI（point）兴趣点，仅保留背景 / 道路 / 建筑
    try {
      this.map.setFeatures(this.config.mapFeatures);
    } catch {
      /* 个别版本不支持 setFeatures，可忽略 */
    }

    // 低配优化：进一步去掉 3D 楼块与标注，只留背景+道路。
    // 平移/缩放时高德每帧都要重绘这些矢量要素与 DOM 标注，是弱机 CPU 的主要消耗之一；
    // 去掉后底图更轻，而我们的 3D 校园模型（GLCustomLayer）完全不受影响、照常显示。
    if (this.lowEnd) {
      try {
        const reduced = (this.config.mapFeatures && this.config.mapFeatures.length
          ? this.config.mapFeatures
          : ['bg', 'road', 'building', 'label', 'point'])
          .filter((f: string) => f !== 'building' && f !== 'label');
        this.map.setFeatures(reduced);
        // eslint-disable-next-line no-console
        console.info(`[MapScene] 低配：底图要素已精简为 [${reduced.join(', ')}]，降低每帧渲染开销`);
      } catch {
        /* 个别版本不支持 setFeatures，可忽略 */
      }
    }

    // 商用授权下隐藏左下角 logo / 版权（免费版请勿开启，会违反高德服务条款）
    if (this.config.hideAMapAttribution) {
      this.container.classList.add('hide-amap-attribution');
    }

    this.customCoords = this.map.customCoords;
    this.customCoords.setCenter(this.gcjCenter);

    // 计算锚点世界坐标（含微调偏移）
    const [ax, ay] = this.customCoords.lngLatToCoord(this.gcjAnchor);
    this.anchorWorld.set(
      ax + this.config.anchorOffset[0],
      ay + this.config.anchorOffset[1],
      this.config.modelElevation,
    );

    // 读取上次保存的校准微调（若有），模型加载时会自动叠加到锚点之上
    this.loadSavedCalibration();

    this.glLayer = new AMap.GLCustomLayer({
      zIndex: 110,
      visible: true,
      init: (gl: WebGLRenderingContext) => this.initThree(gl),
      render: () => this.render(),
    });
    this.map.add(this.glLayer);

    // 交互事件（点击仍用高德事件，悬停改用原生指针事件）
    // 悬停拾取改绑浏览器原生 pointermove（capture）：高德 map.on('mousemove') 需经过其内部事件代理，
    // 而 GLCustomLayer 是「按需渲染」——地图静止时 AMap 可能整秒不回调 render()，仅靠 map.render()
    // 唤醒会把高亮推迟到下一个渲染周期（弱机上表现为接近 1 秒的延迟）。原生事件在捕获阶段即可拿到，
    // 配合 rAF 合帧做到「移动即拾取」，且拖动地图时直接跳过以省 CPU。
    this.hoverDomHandler = (e: PointerEvent) => {
      if (this.disposed) return;
      // ⚠️ 拖动地图时绝不能做悬停拾取：一次拾取会连锁触发 Vue 更新 → 材质克隆/还原
      // → markDirty 同步重绘整场景，拖动每帧再叠加一次全场景渲染就是「移动模型卡顿」的主因。
      // 三重门控：
      //  1) buttons（标准鼠标按下）
      //  2) 自维护的 pointerdown 标志（某些浏览器/触控/合成事件下拖动时 buttons 恒为 0）
      //  3) 视角变化后 90ms 冷却（覆盖滚轮缩放、地图飞行、惯性滑动等无按键的视角变化）
      const now = typeof performance !== 'undefined' ? performance.now() : 0;
      if (e.buttons !== 0 || this.pointerIsDown || now - this.lastViewChangeAt < 90) return;
      this.queueHover(e.clientX, e.clientY);
    };
    this.container.addEventListener('pointermove', this.hoverDomHandler, { capture: true, passive: true });
    this.pointerDownHandler = (e: PointerEvent) => {
      if (e.button === 0 || e.buttons !== 0) this.pointerIsDown = true;
    };
    this.pointerUpHandler = () => { this.pointerIsDown = false; };
    this.container.addEventListener('pointerdown', this.pointerDownHandler, { capture: true, passive: true });
    // pointerup 可能落在容器外，绑到 window 才能保证标志复位
    window.addEventListener('pointerup', this.pointerUpHandler, { capture: true, passive: true });
    window.addEventListener('pointercancel', this.pointerUpHandler, { capture: true, passive: true });
    this.map.on('click', (e: any) => this.handleClick(e));
    this.map.on('dblclick', (e: any) => this.handleDoubleClick(e));
    // 俯仰角锁定：拖动旋转地图时不允许把地图「翻过来」
    this.map.on('camerachange', this.clampPitch);

    // 页面不可见时暂停渲染，彻底 0 占用；回到前台立即补一帧，避免切回时模型缺帧
    if (typeof document !== 'undefined') {
      this.visibilityHandler = () => {
        if (document.hidden) {
          this.paused = true;
        } else {
          this.paused = false;
          // 切回前台时底图缓冲可能已失效，需要高德重绘整帧（并把自定义层一起回调）
          this.markDirty(true);
        }
      };
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  /**
   * 统一判定低配设备：CPU 核心数少 / 设备内存小视为低配。
   * 可用 URL 参数 ?lowend=1 / ?lowend=0 强制覆盖（排查性能问题时用）。
   * 必须在 init() 建图前调用，因为低配要据此精简底图要素。
   */
  private resolveLowEnd(): void {
    let lowEnd =
      (navigator.hardwareConcurrency || 4) <= 4 ||
      (((navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8) <= 4);

    // 软件渲染探测：虚拟机/远程桌面常报「够用」的硬件参数，实则走 SwiftShader/llvmpipe 软件光栅，
    // 任何 WebGL 调用都是纯 CPU 开销，降质无效、必须靠「按需渲染」来救。
    // 用一次性临时上下文读取 UNMASKED_RENDERER，命中即强制低配（?lowend=0 可强制关闭）。
    try {
      const tmp = document.createElement('canvas');
      const tgl = (tmp.getContext('webgl2') || tmp.getContext('webgl')) as WebGLRenderingContext | null;
      if (tgl) {
        // 优先用调试扩展拿到真实渲染器名（部分浏览器会屏蔽，返回空 → 退而取标准 RENDERER）
        const dbg = tgl.getExtension('WEBGL_debug_renderer_info');
        let r = dbg ? String(tgl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
        if (!r && (tgl as WebGL2RenderingContext).RENDERER) {
          r = String(tgl.getParameter((tgl as WebGL2RenderingContext).RENDERER));
        }
        // eslint-disable-next-line no-console
        console.info('[MapScene] WebGL 渲染器 =', r);
        const rs = r.toLowerCase();
        this.softwareRender = /swiftshader|llvmpipe|software|microsoft basic render|mesa|apple paravirtual|virtualbox|angle \(software/.test(rs);
        if (this.softwareRender) lowEnd = true;
        // 释放临时上下文，避免占用浏览器有限的 WebGL 上下文配额
        tgl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    } catch { /* ignore */ }

    // 32 位 / 老旧 Chromium 内核（如 360极速浏览器 Chromium 86）识别：
    // 这类浏览器进程地址空间受限、GPU 能力弱，即便 hardwareConcurrency/deviceMemory 报“够用”，
    // 持续渲染下 CPU 仍会打满。UA 命中“Chromium 主版本 < 100”或“32 位构建”即强制低配，
    // 复用下方已有的全部低配降级（关 AA、像素比 1、关阴影、跳过 PMREM、贴图≤512、RT 空闲只贴图）。
    try {
      const ua = navigator.userAgent || '';
      const m = ua.match(/Chrom(?:e|ium)\/(\d+)/);
      const major = m ? parseInt(m[1], 10) : NaN;
      const is32Bit = /WOW64|Win32|i686|i386/i.test(ua) && !/x86_64|aarch64/.test(ua);
      if ((!Number.isNaN(major) && major < 100) || is32Bit) {
        lowEnd = true;
      }
    } catch { /* ignore */ }

    try {
      const forced = new URLSearchParams(location.search).get('lowend');
      if (forced === '1') lowEnd = true;
      else if (forced === '0') lowEnd = false;
    } catch { /* ignore */ }
    this.lowEnd = lowEnd;
    if (this.lowEnd) {
      // eslint-disable-next-line no-console
      console.info(`[MapScene] 低配模式生效（software=${this.softwareRender}）：启用离屏 RT 合成，空闲帧仅全屏贴图，压低 CPU`);
    }
  }

  private initThree(gl: WebGLRenderingContext): void {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    // eslint-disable-next-line no-console
    console.info(
      `[MapScene] GL 上下文就绪：距地图创建 ${Math.round(performance.now() - this.mapCreateTs)}ms，` +
        `距页面加载 ${Math.round(performance.now() - SCENE_T0)}ms`,
    );

    // 低配设备探测：CPU 核心数少 / 设备内存小 → 关闭抗锯齿、像素比封顶为 1，
    // 否则弱机平移/缩放地图时每帧渲染开销过大，CPU 瞬间 100%。
    // 可用 URL 参数 ?lowend=1 / ?lowend=0 强制覆盖（用于测试/排查性能问题）。
    // 注意：判定逻辑已抽到 resolveLowEnd() 并在 init() 建图前执行，这里直接复用，避免重复实现。
    const lowEnd = this.lowEnd;
    try {
      this.renderer = new THREE.WebGLRenderer({
        context: gl,
        antialias: !lowEnd,
        alpha: true,
        powerPreference: lowEnd ? 'low-power' : 'high-performance',
      });
    } catch (err) {
      // WebGL 上下文不兼容（如 three r163+ 不再支持 WebGL 1）时，把错误抛给上层
      this.callbacks.onMapError?.(err);
      return;
    }
    // 像素比封顶：retina 屏 dpr=2/3 时片元量按平方放大，是弱 GPU 拖动掉帧的主因之一。
    // 非低配封顶到 1.5（较 2 大幅削减片元量、换取更跟手；肉眼清晰度几乎无感差异），低配封顶 1。
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowEnd ? 1 : 1.5));
    this.renderer.setSize(width, height, false);
    this.renderer.autoClear = false;
    // 场景内全部材质均为不透明（已在加载时把半透明/透射玻璃降级为 opaque），
    // 关闭逐对象排序可省掉每帧一次的 draw call 排序开销（弱机每帧一笔纯 CPU 浪费）。
    this.renderer.sortObjects = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // 阴影策略（低配 CPU 100% 的首要根因）：
    // 校园场景是静态的，阴影图只需在模型放置后计算一次。three 的 shadowMap.autoUpdate 默认为 true，
    // 会令 AMap 自定义图层每帧回调 render() 时都把整张阴影图从光源视角重绘一遍（≈整场景双倍绘制），
    // 取景动画期间持续渲染 → 低配机器 CPU 瞬间打满。这里改为「自动更新关闭 + needsUpdate 单次触发」，
    // 阴影只在模型就绪后渲染一次，之后每帧复用缓存，负载骤降。
    // 低配机器则直接关闭阴影（由环境光/半球光/主补光兜底），换取流畅加载。
    this.renderer.shadowMap.enabled = !this.lowEnd;
    this.renderer.shadowMap.type = this.lowEnd ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, width / height, 1, 1 << 30);

    // 色调映射：
    // - WebGL2 下保留 ACESFilmic：配合 IBL 环境贴图，PBR 质感真实。
    // - WebGL1（高德 GLCustomLayer 多数环境）下 PMREM/IBL 必然失败，场景无任何环境光，
    //   若再用 ACES 会把 LDR 立面贴图整体压暗、去饱和，观感即「材质丢失 / 发灰」。
    //   故 WebGL1 改用 LinearToneMapping（不压暗），保留贴图原始色，材质清晰可见。
    const isWebGL2 = !!this.renderer?.capabilities?.isWebGL2;
    this.renderer.toneMapping = isWebGL2 ? THREE.ACESFilmicToneMapping : THREE.LinearToneMapping;
    // 曝光略微下调：WebGL1 走 LinearToneMapping（不做高光压缩），原 1.12 会把
    // 烘焙立面的浅色（底图 0.65/墙 0.7~0.9）直接放大到 1.0 溢出成纯白，
    // 砖纹/门窗的色彩对比被洗掉，观感即「光线过白、颜色不明显」。(s470)
    this.renderer.toneMappingExposure = isWebGL2 ? 0.95 : 1.0;

    // 环境贴图（IBL）：PBR 材质需要环境光照才能呈现正确质感（尤其是金属度/粗糙度与边缘反射）。
    // 缺少 scene.environment 时，很多外立面材质会因为没有环境反射而显得「发灰、发暗、像没贴图」，
    // 这正是「GLB 材质丢失」最常见的原因（下方 setupLights 的环境/半球/主补光仅作兜底，无法替代 IBL 反射）。
    // 故「始终」生成环境贴图——它决定了材质正确观感，不能因 lowEnd 跳过；代价仅是加载时一次性的
    // PMREM 渲染（位于加载遮罩之后、模型挂载之前，不进入逐帧循环，对运行期 CPU/帧率无影响）。
    // 历史坑：早先实现在 lowEnd 下跳过 PMREM，导致 360极速等被强制低配的环境里楼栋整体发灰/发暗、观感像材质丢失；
    //       现改为始终生成，材质恢复正确，且 CPU 优化旋钮（像素比/阴影/RT缓存/抗锯齿）仍由 lowEnd 独立控制。
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environment = envTex;
      pmrem.dispose();
    } catch {
      /* 极少数 WebGL 环境下 PMREM 不可用，退化为基础灯光照明（不影响几何显示） */
    }

    // 量算图层：独立于模型，始终绘制在模型之上
    // 量算图形放在独立 scene：renderer.sortObjects=false 会让 renderOrder 失效，
    // 且 measureGroup 比 modelRoot 更早加入主 scene，导致线/面被后画的建筑盖住。
    // 改为「主场景渲染完 → clearDepth → 单独渲 measureScene」的 overlay pass，
    // 既不依赖对象排序，也保持贴地坐标（z=0.5）不产生视差偏移。
    this.measureScene = new THREE.Scene();
    this.measureGroup = new THREE.Group();
    this.measureScene.add(this.measureGroup);

    this.setupLights();
    this.ready = true;
    this.startModelLoad(this.config.modelUrl);
  }

  /**
   * 启动模型加载（由 initThree 在 GL 上下文就绪后调用）：
   * - 若组件层已并行预取好 GLB 缓冲（setPrefetchedBuffer），则直接 parse，跳过网络等待；
   * - 否则退回普通下载（仅一次，与预取互斥，避免重复拉取）。
   * 与「等高德 GL 就绪」解耦：模型下载+解析可与地图初始化期间重叠，首屏不再被串行卡住。
   */
  private startModelLoad(url: string): void {
    if (this.modelOnLoadRan) return;  
    if (this.modelPrefetchGltf) {
      this.runModelOnLoad(this.modelPrefetchGltf);
      return;
    }
    if (this.prefetchFetch) {
      // 组件层已把「下载中的 fetch」交给我们：复用该次网络请求，避免重复拉取；
      // 不在此阻塞——fetch 完成（通常已与高德 WebGL 初始化并行）后直接 parse。
      this.modelPrefetchStarted = true;
      this.prefetchStartTs = this.loadStartTs || performance.now();
      if (!this.loadStartTs) this.loadStartTs = this.prefetchStartTs;
      this.prefetchFetch
        .then((buf: ArrayBuffer) => {
          if (this.modelOnLoadRan || this.disposed) return;
          this.prefetchedBuffer = buf;
          this.prefetchedUrl = url;
          this.prefetchFetch = null;
          this.parsePrefetched(url);
        })
        .catch(() => {
          // 预取失败：退回自行下载
          this.modelPrefetchStarted = false;
          this.prefetchFetch = null;
          this.startModelLoad(url);
        });
      return;
    }
    if (this.prefetchedBuffer) {
      this.parsePrefetched(url);
      return;
    }
    if (this.modelPrefetchStarted) return; // 预取已在进行，runModelOnLoad 会在其完成时触发
    this.modelPrefetchStarted = true;
    this.prefetchStartTs = this.loadStartTs || performance.now();
    if (!this.loadStartTs) this.loadStartTs = this.prefetchStartTs;
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        this.modelPrefetchGltf = gltf;
        this.onLoadEntryTs = performance.now();
        if (this.ready) this.runModelOnLoad(gltf);
      },
      (event: ProgressEvent) => {
        if (event.lengthComputable) {
          this.modelBytes = event.total; // 无预取缓冲时，用 Content-Length 兜底
          this.callbacks.onModelProgress?.(Math.round((event.loaded / event.total) * 100));
        }
      },
      (err) => {
        this.callbacks.onModelError?.(err);
      },
    );
  }

  /**
   * 接收组件层在 await loadAMap 期间提前下载好的 GLB 二进制（与高德脚本加载并行）。
   * 高德 GL 上下文就绪后，initThree 会走 parsePrefetched 直接解析这份缓冲，
   * 从而把「等高德」与「下模型」两段串行等待重叠，缩短首屏。
   */
  setPrefetchedBuffer(buf: ArrayBuffer, url: string): void {
    if (this.modelPrefetchStarted || this.modelOnLoadRan) return;
    this.modelPrefetchStarted = true;
    this.prefetchedBuffer = buf;
    this.prefetchedUrl = url;
    this.prefetchStartTs = performance.now();
    if (!this.loadStartTs) this.loadStartTs = this.prefetchStartTs;
    // eslint-disable-next-line no-console
    console.info(
      `[MapScene] 收到并行预取缓冲：距页面加载 ${Math.round(performance.now() - SCENE_T0)}ms，` +
        `距地图创建 ${Math.round(performance.now() - this.mapCreateTs)}ms，大小 ${Math.round(buf.byteLength / 1024)}KB`,
    );
    if (this.ready && !this.modelOnLoadRan) this.parsePrefetched(url);
  }

  /**
   * 接管组件层在 await loadAMap 期间已发起、尚在进行中的 GLB 下载（fetch in flight）。
   * 与「等高德 GL 就绪后再下载」不同，这里把 fetch promise 直接交给我们，
   * 使「模型下载」与「高德 WebGL 初始化（软件光栅下最慢的一段）」完全并行，
   * 且不会触发重复下载（startModelLoad 检测到 prefetchFetch 即复用本次请求）。
   */
  setPrefetchFetch(p: Promise<ArrayBuffer>): void {
    if (this.modelPrefetchStarted || this.modelOnLoadRan) return;
    this.modelPrefetchStarted = true;
    this.prefetchFetch = p;
    this.prefetchStartTs = performance.now();
    if (!this.loadStartTs) this.loadStartTs = this.prefetchStartTs;
    // eslint-disable-next-line no-console
    console.info(`[MapScene] 接管并行预取（fetch in flight）：距页面加载 ${Math.round(performance.now() - SCENE_T0)}ms`);
  }

  /** 用提前下载的缓冲直接解析 GLB（不再经网络），触发后处理与挂载 */
  private parsePrefetched(url: string): void {
    if (this.modelOnLoadRan || !this.prefetchedBuffer) {
      // 缓冲未就绪：退回普通下载
      this.startModelLoad(url);
      return;
    }
    if (this.modelPrefetchGltf) {
      this.runModelOnLoad(this.modelPrefetchGltf);
      return;
    }
    const buf = this.prefetchedBuffer;
    this.modelBytes = buf.byteLength; // 记录体积后再释放缓冲
    this.prefetchedBuffer = null; // 释放，避免长期持有大块内存
    const loader = new GLTFLoader();
    const path = url.substring(0, url.lastIndexOf('/') + 1);
    this.onLoadEntryTs = performance.now();
    // eslint-disable-next-line no-console
    console.info(`[MapScene] 预取缓冲开始解析：距页面加载 ${Math.round(performance.now() - SCENE_T0)}ms`);
    loader.parse(
      buf,
      path,
      (gltf) => {
        this.modelPrefetchGltf = gltf;
        this.onLoadEntryTs = performance.now();
        // eslint-disable-next-line no-console
        console.info(
          `[MapScene] 模型下载+解析完成：${Math.round(this.onLoadEntryTs - this.loadStartTs)}ms，` +
            `距页面加载 ${Math.round(this.onLoadEntryTs - SCENE_T0)}ms`,
        );
        if (this.ready) this.runModelOnLoad(gltf);
      },
      (err) => {
        this.callbacks.onModelError?.(err);
      },
    );
  }

  private setupLights(): void {
    if (!this.scene) return;
    // ⚠️ s470 过曝修复：下面四盏灯的强度原先合计 4.75（0.7+1.15+2.0+0.9），
    // 是历史上「WebGL1 无 IBL → 楼栋发灰发暗」时逐步调高的兜底值。但后来
    // initThree() 已改为「始终生成 scene.environment（RoomEnvironment PMREM）」，
    // IBL 现在恒定生效，于是 IBL + 4.75 强光叠加 → 严重过曝：烘焙出来的浅色立面
    // 与底图被推向纯白、砖纹与门窗的色彩对比被洗掉，即用户反馈的「光线过于白、
    // 建筑原先的色彩不明显」。s470 把直接光总量降到 2.15（约原值 45%）后用户又反馈
    // 「有点像早上6点的光亮」偏暗；s471 回调到 3.04（≈原值 64%、s470 的 1.4 倍），
    // 位于「过曝 4.75」与「偏暗 2.15」之间，配合 exposure 0.95/1.0 让色彩可读又不过亮。
    // 若日后仍觉得偏亮/偏暗，只需整体等比微调下面四个数（保持 0.50:0.72:1.40:0.42 比例）。
    // 环境光：保证背光面/底面也有基础照明，避免模型在深色地图底图上糊成一片暗灰。
    const amb = new THREE.AmbientLight('#ffffff', 0.5);
    this.scene.add(amb);

    // 半球光：天空白、地面浅灰蓝，让朝上的立面与底面过渡自然、不发灰发暗。
    const hemi = new THREE.HemisphereLight('#ffffff', '#b3bcc9', 0.72);
    this.scene.add(hemi);

    // 主光（带阴影）
    const dir = new THREE.DirectionalLight('#ffffff', 1.4);
    dir.position.set(-200, 400, 150);
    dir.castShadow = true;
    // 阴影相机：默认 ±5 的正交视锥对 300+ 单位的大场景太小，会把楼栋错误压暗成暗斑；
    // 放宽到足以覆盖整片校园，并加 normalBias 抑制自阴影锯齿(acne)造成的黑斑。视锥中心在
    // 光源 target（默认原点），模型放置后会在 fitShadowToModel() 里按实际位置再对齐一次。
    // s483：normalBias 0.6→1.0。±500m 视锥/2048² 阴影图下每 texel≈0.5m，0.6 不足以
    // 抑制大平面（地面/幕墙）自阴影波纹（实测开阔地被压暗最多 -70/255）；1.0 实测
    // acne std 17.7→1.2（波纹彻底消失），且残留最小、贴地阴影脱节风险最低。
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 1600;
    dir.shadow.camera.left = -500;
    dir.shadow.camera.right = 500;
    dir.shadow.camera.top = 500;
    dir.shadow.camera.bottom = -500;
    dir.shadow.bias = -0.0006;
    dir.shadow.normalBias = 1.0;
    this.dirLight = dir;
    this.scene.add(dir);

    // 补光：从主光对侧打一盏弱光，照亮背光面，使材质细节（贴图、纹理）清晰可辨
    const fill = new THREE.DirectionalLight('#dfe7f0', 0.42);
    fill.position.set(220, 180, -160);
    fill.castShadow = false;
    this.scene.add(fill);
  }

  // -------------------------------------------------------------------------
  // 模型加载与地理对齐放置
  // -------------------------------------------------------------------------
  /**
   * 模型下载+解析完成后的统一后处理与挂载（原 loadModel 的 onLoad 主体）。
   * 不论模型来自「组件层并行预取缓冲（setPrefetchedBuffer）」还是「initThree 内 startModelLoad 自行下载」，
   * 都走这里。入口前的 onLoadEntryTs 已由发起下载处记录（= 解析完成时刻）。
   */
  private async runModelOnLoad(gltf: any): Promise<void> {
    if (this.disposed) return;
    this.modelRoot = gltf.scene as THREE.Object3D;

        // 按配置过滤节点：隐藏 Blender 一并导出的辅助几何（屋顶棚/女儿墙/大门/廊架/骨架/空物体等），
        // 只保留楼本体，避免地图上出现无关网格。需在居中/命名解析前执行。
        this.applyNodeFilter();

        this.modelRoot.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;

            // ⚠️ 屋面类材质（Roof_*）用在「无顶棚」楼栋的平屋面上。
            // 根因：平屋面是半光泽材质(rough≈0.8) + 强制 DoubleSide + IBL(envMapIntensity=0.7)，
            // 会随相机角度出现「一块亮一块暗」的镜面/环境反射斑（有顶棚的楼被盖板遮挡看不见）。
            // 关掉「接收阴影」可顺手消除设备自投影硬边，但真正消除角度相关斑块的办法是
            // 把屋面改成纯漫反射（下方在材质遍历里把 rough=1 / metal=0 / envMapIntensity=0）。
            // 这里保留 castShadow（屋面在地面投下的阴影不受影响）。
            const _mats = Array.isArray((child as THREE.Mesh).material)
              ? (child as THREE.Mesh).material as THREE.Material[]
              : [(child as THREE.Mesh).material as THREE.Material];
            const _isRoof = _mats.some((m) => !!m && /Roof/i.test(m.name));
            if (_isRoof) child.receiveShadow = false;

            // ⚠️ AMap GLCustomLayer 提供的是 WebGL1 上下文，而 three r162 中
            // MeshPhysicalMaterial 的 transmission（透射/玻璃）着色器会生成
            // textureLod / textureSize / isinf 等 GLSL3 专属代码，在 WebGL1 下
            // 编译失败（Shader Error 1282），导致窗户等材质损坏并拖累整体渲染。
            // 这里把带 transmission 的材质降级为普通半透明材质：保留玻璃观感，
            // 但不再走 WebGL2-only 的透射路径。
            const mats = Array.isArray((child as THREE.Mesh).material)
              ? (child as THREE.Mesh).material as THREE.Material[]
              : [(child as THREE.Mesh).material as THREE.Material];
            for (const mat of mats) {
              const pm = mat as THREE.MeshPhysicalMaterial;
              if (pm && (pm as any).isMeshPhysicalMaterial && (pm.transmission ?? 0) > 0) {
                pm.transmission = 0;
                pm.thickness = 0;
                // opaque: the transmission-glass fallback was semi-transparent and got double-blended against the
                // offscreen RT's transparent black background, causing shimmer between direct-draw and blit paths.
                pm.transparent = false;
                pm.opacity = 1;
                pm.roughness = Math.max(pm.roughness ?? 0.1, 0.12);
                pm.metalness = pm.metalness ?? 0;
                pm.depthWrite = true;
                pm.needsUpdate = true;
              }
              // 抗黑面加固：真实建筑立面在「WebGL1 无环境贴图」或「部分面法线朝内」时，从某些角度会发黑。
              // 1) 金属度异常的立面（如图书馆被误设为 metalness=1.0）在无 IBL 时会渲染成纯黑 → 压到非反光范围；
              // 2) 双面渲染，避免单面剔除导致「从外侧看到内侧空洞/背景」而显黑（某些角度黑面最常见根因）。
              const sm = mat as THREE.MeshStandardMaterial;
              if (sm && (sm as any).isMeshStandardMaterial) {
                if ((sm.metalness ?? 0) > 0.5) sm.metalness = 0.1;
                if (sm.side !== THREE.DoubleSide) sm.side = THREE.DoubleSide;
                // s470：RoomEnvironment IBL 默认强度 1.0 会把漫反射基色整体提亮泛白，
                // 与已下调的直接光配合收敛到 0.7 —— 环境反射仍在（金属/粗糙度、背光面
                // 不发灰），但烘焙贴图里的砖纹/门窗/底图浅灰能重新显出层次。
                sm.envMapIntensity = 0.7;
                // s480 屋面反光斑修复：屋面(Roof_*)、屋顶太阳能板(Solar_Panel/RT_Solar)
                // 及其它屋顶设备(RT_*)改为纯漫反射。根因：这些材质 roughness 0.15~0.8 半光泽，
                // 在 RoomEnvironment IBL 下产生随相机角度移动的「一块亮一块暗」反射斑
                //（无顶棚楼栋的裸屋面/板阵尤其明显，有顶棚的被盖板遮挡看不见）。
                // s481 扩展：BK_Facade_*（烘焙立面/窗带贴图，窗户图案在贴图里）
                // 同样半光泽(0.32~0.5)，其反光斑贴着楼顶边缘出现（用户仍见
                // 「楼顶一块亮一块暗」）；一并哑光，观感由烘焙贴图保证。
                // 池塘水面(BK_M_Pond_Water)的反光是自然现象，保留不动。
                if (/Roof|^RT_|Solar_Panel|^BK_Facade|Canopy/i.test(mat.name)) {
                  sm.roughness = 1.0;
                  sm.metalness = 0.0;
                  // 注意：envMapIntensity 必须保留 0.7，不能归零——
                  // roughness=1 时 IBL 反射是完全模糊的半球均匀值（无任何随视角
                  // 移动的斑块），但仍是屋面的重要环境亮度来源；归零会让
                  // 屋面/顶棚发灰发暗（s481 教训）。
                }
                // s484 z-fighting 修复（楼顶「一块亮一块暗随角度移动」的真正根因）：
                // 每栋楼的檐口盖板(EaveC_*，材质 Roof_Edge)是一块 0.4m 厚的板，
                // 其底面与屋面板(Roof_Tier_*，本楼 mesh)的顶面【完全共面 dz=0】
                // （琴剑楼实测 dz=+0.0000，底面积 2602m² 甚至比屋面 2478m² 还大）。
                // 双面渲染下，从上方看「檐口底面的背面」与「屋面顶面」逐像素抢深度，
                // 胜者随相机角度翻转 → 整片屋顶游走花斑。与材质反光(s480)、
                // 阴影痤疮(s483)相互独立，所以前几轮修复后仍残留。
                // ① 恢复单面渲染：底面背面从上方被剔除（从下方看檐口悬挑底面仍是
                //    正面，不受影响）；
                // ② polygonOffset 把檐口面推后，琴剑楼那种「与屋面同高的上翻檐口
                //    平台」等残余共面也确定由屋面获胜。
                if (/Roof_Edge/i.test(mat.name)) {
                  sm.side = THREE.FrontSide;
                  sm.polygonOffset = true;
                  sm.polygonOffsetFactor = 2;
                  sm.polygonOffsetUnits = 2;
                }
                // s484 地面同理：Lawn_GapFill（草地补丁层）顶面与 Lawn_Campus_Fill
                // 顶面共面 z=0.0000，也是游走花斑源；推后让主草地层稳定获胜。
                if (/^Lawn_GapFill/i.test(child.name)) {
                  sm.polygonOffset = true;
                  sm.polygonOffsetFactor = 1;
                  sm.polygonOffsetUnits = 1;
                }
                sm.needsUpdate = true;
              }
            }
          }
        });

        this.placeModelAtAnchor();
        this.fitShadowToModel();

        // —— 后处理整体重构为「分片 + 阶段进度」——
        // 旧实现虽有 yield，但每段本身仍是一个整块同步循环（108 张贴图逐张处理），
        // 低配机器上表现为「进度到 100% 后界面卡死近 30 秒才出模型」。
        // 现在每段拆成 ~14ms 小片、片间让出一帧并回报阶段（onModelStage），
        // 加载遮罩全程显示「正在做什么 / 做到第几张」，主线程也不再被一次性打满。
        await this.yieldToEventLoop();
        if (this.disposed) return;

        // 一次性收集去重贴图（避免每段各 traverse 一遍），后续各段都基于这张列表分片执行
        const textures = this.collectTextures(this.modelRoot);
        const mapPairs = this.collectMatMapPairs(this.modelRoot);
        this.facadeCache.clear();

        // 并行预解码：ImageBitmap 路径（现代浏览器 GLTFLoader 默认）在解析阶段已完成解码，
        // 此处为空操作；若回落到 HTMLImageElement 路径，则并行触发浏览器解码——
        // 旧流程解码发生在首次 drawImage 时逐张串行触发，108 张在低配 CPU 上是十几秒的串行开销。
        this.callbacks.onModelStage?.('解码贴图', 0, textures.length);
        await this.predecodeTextures(textures);
        if (this.disposed) return;

        let clampedCount = 0;
        let npotFixed = 0;
        let materialFixed = 0;
        let textureReduced = 0;
        // 两种模式共用「安全的贴图适配」流程，保证材质观感一致，避免低配下楼栋发灰 / 贴图被改 / 非楼栋材质被误伤：
        //  - 缩放超大贴图：防止 WebGL1 的 MAX_TEXTURE_SIZE 超限导致材质回退为白/灰平面（=「材质丢失」）。
        //  - NPOT 适配：WebGL1 下「NPOT 尺寸 + mipmap」会被驱动丢弃，导致黑/空白；改为无 mipmap+线性+钳制（WebGL2 跳过）。
        //  - 检测并替换均匀黑损坏贴图：修复 GLB 导出/烘焙失败的黑墙（此修复经用户确认有效）。
        // 注：早期实现在低配分支用「缩到 ≤256 + 关 mipmap」处理所有贴图（含非建筑对象），会令材质发灰/变糊、观感像丢失；现已弃用该路径。
        await this.runChunked(textures, '缩放超大贴图', (tex) => {
          if (this.clampTextureToMaxSize(tex)) clampedCount++;
        });
        if (this.disposed) return;
        await this.runChunked(textures, '适配 WebGL1 贴图', (tex) => {
          if (this.makeTextureWebGL1Safe(tex)) npotFixed++;
        });
        if (this.disposed) return;
        // 仅当确为「软件光栅(SwiftShader)且贴图极大」时，再温和降一次尺寸以压低逐帧填充率；
        // 保留 mipmap 与过滤方式，不伤观感。32 位/老内核 UA 强制的低配（如 360极速）不在此列——
        // 其瓶颈在 AMap 自身逐帧重绘，降纹理无效且会改观感，故跳过。
        if (this.lowEnd && this.softwareRender) {
          await this.runChunked(textures, '优化贴图', (tex) => {
            if (this.reduceTextureForLowEnd(tex)) textureReduced++;
          });
          if (this.disposed) return;
        }
        await this.runChunked(mapPairs, '检测损坏贴图', (pair) => {
          if (this.fixMatMapIfBlack(pair)) materialFixed++;
        });
        if (this.disposed) return;
        // 所有贴图处理完成后再挂入场景：避免在「让出帧」期间 AMap 提前渲染、把全分辨率贴图先上传一遍 GPU
        // （那样低配机器仍会先承受一次 450MB 上传峰值）。挂入后 AMap 第一次渲染拿到的就是已降级的贴图。
        this.scene!.add(this.modelRoot);
        // 合并同材质重复网格（削减 draw call / 拖动卡顿）：在取景、楼栋 AABB、标签之前完成，
        // 使后续包围盒 / 拾取基于合并后的几何。
        this.simplifyDrawCalls();
        const caps = this.renderer?.capabilities;
        const shadowState = this.renderer?.shadowMap?.enabled ? '单次(静态缓存)' : '关(低配)';
        // eslint-disable-next-line no-console
        console.info(
          `[MapScene] GLB 加载完成：isWebGL2=${caps?.isWebGL2 ?? '?'}，MAX_TEXTURE_SIZE=${caps?.maxTextureSize ?? '?'}，` +
            `低配=${this.lowEnd}，阴影=${shadowState}，`
            + `超限缩放=${clampedCount} 张，NPOT 材质降级=${npotFixed} 张，黑图替换=${materialFixed} 张，低配贴图降级=${textureReduced} 张`,
        );

        this.callbacks.onModelStage?.('准备渲染');
        // 加载阶段 GL 画布/底图刚就绪，需要一次完整的高德整帧
        this.markDirty(true);
        // 取景前先构建各建筑世界 AABB，供后续悬停拾取做粗筛（避免全模型 raycast）。
        this.refreshBuildingBoxes();
        // 构建常驻楼栋名称标签（钉在每栋楼顶端，无需悬停即显示）。
        this.buildBuildingLabels();
        // 取景：按当前屏幕把缩放精确推到「刚好能看到全部建筑」的最大级别。
        // 取景挂了迭代微调时，onFitComplete 由 endFitRefine() 在收敛后触发；
        // 未挂微调（fitToBuildings 内部提前返回）时在这里同步补一次，
        // 保证上层（加载遮罩）总能等到「取景完成」。
        this.fitToBuildings();
        // 阴影只算一次：模型已放置/取景完毕，唤醒一次阴影图渲染（shadowMap.autoUpdate=false 时
        // 需靠 needsUpdate 触发；渲染后 three 会自清零，后续帧复用缓存，不再每帧重绘）。
        if (this.renderer?.shadowMap?.enabled) this.renderer.shadowMap.needsUpdate = true;
        if (!this.fitRefine) {
          if (this.loadStartTs && this.onLoadEntryTs) {
            const parseMs = Math.round(this.onLoadEntryTs - this.loadStartTs);
            const postMs = Math.round(performance.now() - this.onLoadEntryTs);
            // eslint-disable-next-line no-console
            console.info(
              `[MapScene] 取景完成：下载+解析=${parseMs}ms，后处理=${postMs}ms，` +
                `距页面加载合计=${Math.round(performance.now() - SCENE_T0)}ms，` +
                `距地图创建合计=${Math.round(performance.now() - this.mapCreateTs)}ms`,
            );
          }
          this.callbacks.onFitComplete?.();
        }
        this.modelReadyTs = performance.now();
        this.callbacks.onModelReady?.();
        // 首屏主动补帧：确保 GLCustomLayer 第一时间被绘制，不依赖高德按需渲染在「无视角变化」时
        // 主动重绘——否则首帧可能不绘制，表现为「遮罩揭开后模型仍不显示 / 需开控制台才出现」。
        this.requestRender();
        setTimeout(() => this.requestRender(), 250);
  }

  /**
   * 模型就绪后自动取景：以「建筑群实际中心」为可见区中心（模型居中），
   * 把缩放推到最大——建筑角点刚好触及可见区边缘，即「模型刚好填满整个屏幕」。
   * 可见区 = 屏幕 − 顶部/底部悬浮 UI（标题徽标/搜索框/工具栏、操作提示胶囊）
   * − 左右 8px 防裁边。
   *
   * 做法：
   * 1. 取全部「建筑节点」（buildingNodeNames）的逐楼栋角点（模型没有命名建筑节点时
   *    退化为整模型包围盒），并求建筑群中心 → 相机中心（而非配置的 center，
   *    因为道路/地形等非建筑网格会让模型整体中心偏离建筑群中心，导致「模型不在屏幕中间」）；
   * 2. 俯仰角自适应：单一俯仰角下投影高宽比 ≠ 屏幕高宽比时，最大放大只能贴满
   *    横或竖一边（另一边留白）。二分搜索使「投影高宽比 == 可见区高宽比」的俯仰角
   *    （保持正面斜视观感，夹在 [35°, 75°]），使最大放大同时贴满四边；
   * 3. 沿视线方向二分搜索「能让全部角点都落在可见区内」的最小相机距离（透视投影
   *    逐角点精确计算），再按实测屏幕偏移平移取景中心（双向居中）并重新收紧距离；
   * 4. 由「相机到视中心距离 ∝ 2^(-zoom)」关系（以当前实测 zoom/距离为基准）换算出
   *    目标缩放级别并立即应用，从而在任意分辨率屏幕上都刚好框住全部建筑；
   *    残余偏差由 refineFitStep 在 render() 里用真实相机逐帧收敛（居中 + 填满）。
   */
  private fitToBuildings(): void {
    if (!this.map || !this.customCoords || !this.modelRoot) return;
    const params = this.customCoords.getCameraParams?.();
    if (!params?.position || !params?.lookAt || !params?.up) return;
    if (!(params.fov > 0 && params.fov < 180)) return;

    // 1) 全部建筑的世界包围盒与角点。逐楼栋（逐 mesh）取角点而非只取整体包围盒的
    //    8 个角：校园呈 L 形 / 凹形 / 斜向布局时更贴身，能在「全部建筑都可见」的
    //    前提下放得更大（整体包围盒的空白角会把取景无谓地推远）。
    //    同时按「建筑节点」归并各自的包围盒，用于诊断最外侧节点（检查是否有远离
    //    主楼群的小构筑物把取景范围撑大）。
    const box = new THREE.Box3();
    const corners: THREE.Vector3[] = [];
    const nodeBoxes = new Map<string, THREE.Box3>();
    const pushCorners = (b: THREE.Box3): void => {
      for (const x of [b.min.x, b.max.x]) {
        for (const y of [b.min.y, b.max.y]) {
          for (const z of [b.min.z, b.max.z]) corners.push(new THREE.Vector3(x, y, z));
        }
      }
    };
    let hasBuilding = false;
    this.modelRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible) return;
      const owner = this.owningBuildingOf(mesh);
      if (!owner) return;
      hasBuilding = true;
      const meshBox = new THREE.Box3().setFromObject(mesh);
      box.union(meshBox);
      pushCorners(meshBox);
      const known = nodeBoxes.get(owner.name);
      if (known) known.union(meshBox);
      else nodeBoxes.set(owner.name, meshBox.clone());
    });
    if (!hasBuilding) {
      box.setFromObject(this.modelRoot);
      pushCorners(box);
    }
    if (box.isEmpty()) return;

    // 诊断：水平/深度方向最外侧的建筑节点名（发现「远离主楼群的小构筑物撑大取景」时便于排查）
    const extremeNodes = (): string => {
      let minXn = '', maxXn = '', minYn = '', maxYn = '';
      nodeBoxes.forEach((b, n) => {
        if (!minXn || b.min.x < (nodeBoxes.get(minXn)?.min.x ?? Infinity)) minXn = n;
        if (!maxXn || b.max.x > (nodeBoxes.get(maxXn)?.max.x ?? -Infinity)) maxXn = n;
        if (!minYn || b.min.y < (nodeBoxes.get(minYn)?.min.y ?? Infinity)) minYn = n;
        if (!maxYn || b.max.y > (nodeBoxes.get(maxYn)?.max.y ?? -Infinity)) maxYn = n;
      });
      return `x[${minXn}~${maxXn}] y[${minYn}~${maxYn}]`;
    };

    // 2) 当前相机基准（customCoords 世界坐标，z 为高度）：
    //    - bearing：相机方位（视中心→相机的水平单位向量），取景全程保持当前朝向不变；
    //    - (zoom0, dist0)：实测「缩放级别 ↔ 相机到视中心距离」基准，用于距离→zoom 换算。
    //    视中心 look 取「建筑群中心在地面上的投影」（高德 lookAt 即地面中心点）。
    const centerWorld = box.getCenter(new THREE.Vector3());
    let look = new THREE.Vector3(centerWorld.x, centerWorld.y, 0);
    const camPos = new THREE.Vector3(params.position[0], params.position[1], params.position[2]);
    const oldLook = new THREE.Vector3(params.lookAt[0], params.lookAt[1], params.lookAt[2]);
    const dist0 = camPos.distanceTo(oldLook);
    const zoom0 = Number(this.map.getZoom?.());
    if (!(dist0 > 0) || !Number.isFinite(zoom0)) return;
    // FIXED_BEARING：地图初始方位已在 init 用 rotation 定死。取景解析一律使用
    // 「正北朝向」的等效相机方位（rotation=0 时相机在视中心正南、朝北看），
    // 使 zoom / center / pitch 与默认朝向时期完全一致——换朝向不改变模型大小、俯仰与居中。
    // dist0 / zoom0 取自真实相机，与方位无关，故距离→zoom 换算仍然成立。
    const bearing = new THREE.Vector3(0, -1, 0);
    const UP = new THREE.Vector3(0, 0, 1);

    // 屏幕边距（px → NDC）：目标是「模型刚好填满整个屏幕」，但顶 / 底要避开
    // SceneView 的悬浮 UI（顶部 16px 起有标题徽标 / 搜索框 / 工具栏一行，底部有
    // 操作提示胶囊），模型顶 / 底不能藏到这些浮层后面；左右无浮层仅留 8px 防裁边。
    // 注意 NDC y=+1 是屏幕顶部、-1 是底部。
    const padX = 8;
    const padTop = 58;
    const padBottom = 52;
    const W = this.container.clientWidth || 1;
    const H = this.container.clientHeight || 1;
    const minX = -1 + (padX / W) * 2;
    const maxX = 1 - (padX / W) * 2;
    const minY = -1 + (padBottom / H) * 2;
    const maxY = 1 - (padTop / H) * 2;
    /** 可见区（避开顶 / 底悬浮 UI）的屏幕中心（px）——「居中」以它为准 */
    const visCy = (padTop + (H - padBottom)) / 2;

    // 默认取景微调：把模型在屏幕上向左偏移（fr*W 像素），给右侧留出空间，
    // 避免模型永远死板地居中。正值 = 模型偏左。
    // 与 ZOOM_BONUS 的取舍：左移越大、放大越大，左侧越容易被画面边缘裁切；
    // 但用户明确表示「左侧看不见也没关系」，故大幅左移（0.12）：放平（pitch 大）后
    // 横向余量本就很小，左移会切到左侧建筑/树木属可接受范围。
    const MODEL_SHIFT_FRAC = 0.12;
    const shiftPx = MODEL_SHIFT_FRAC * W;
    // 默认取景：把模型在屏幕上向下（朝观察者 / 近处）偏移，让上方多留空间，
    // 视觉上模型「往面前拖」。正值 = 模型偏下（屏幕 y 更大）。
    // 取 0.11：参考图里模型重心约在画面 60% 高度处，且偏前（近处建筑贴近下缘），故较之前 0.08 加大。
    const MODEL_SHIFT_DOWN_FRAC = 0.11;
    const shiftDownPx = MODEL_SHIFT_DOWN_FRAC * H;
    // 默认取景在「刚好填满」基础上额外放大一点点（zoom 等级），让模型显得更大些。
    // 注意：放大过多会与左移叠加导致左侧被画面边缘裁切，故保持与左移相匹配的小值。
    const ZOOM_BONUS = 0.14;

    // 解析试验相机：在指定俯仰角 pitchDeg（高德约定 0=正上方俯视，越大越平视）、
    // 视中心与距离下透视投影全部角点，检查是否都落在屏幕边距内。
    const testCam = new THREE.PerspectiveCamera(params.fov, W / H, 1, 1e7);
    const tmp = new THREE.Vector3();
    const dirAt = (pitchDeg: number): THREE.Vector3 => {
      const elev = THREE.MathUtils.degToRad(90 - pitchDeg); // 相机仰角（高于地平线）
      const c = Math.cos(elev);
      return new THREE.Vector3(bearing.x * c, bearing.y * c, Math.sin(elev));
    };
    const placeTestCam = (lk: THREE.Vector3, dir: THREE.Vector3, d: number): void => {
      testCam.up.copy(UP);
      testCam.position.copy(lk).addScaledVector(dir, d);
      testCam.lookAt(lk);
      testCam.updateMatrixWorld(true);
    };
    const inMargins = (): boolean =>
      corners.every((c) => {
        const p = tmp.copy(c).project(testCam);
        return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
      });

    /** 在俯仰角 pitchDeg 下二分搜索「全部角点都在屏幕内」的最小相机距离，并量测此时的角点包围盒 */
    const searchAt = (pitchDeg: number): { d: number; w: number; h: number } => {
      const dir = dirAt(pitchDeg);
      const fitsAt = (d: number): boolean => {
        placeTestCam(look, dir, d);
        return inMargins();
      };
      const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
      let lo = Math.max(radius, 1);
      let hi = dist0 * 4;
      let guard = 0;
      while (!fitsAt(hi) && guard++ < 8) hi *= 2;
      if (!fitsAt(hi)) return { d: Infinity, w: 0, h: 0 };
      for (let i = 0; i < 36 && hi - lo > 1; i++) {
        const mid = (lo + hi) / 2;
        if (fitsAt(mid)) hi = mid;
        else lo = mid;
      }
      placeTestCam(look, dir, hi);
      let bxMin = Infinity, bxMax = -Infinity, byMin = Infinity, byMax = -Infinity;
      for (const c of corners) {
        const p = tmp.copy(c).project(testCam);
        bxMin = Math.min(bxMin, (p.x * 0.5 + 0.5) * W);
        bxMax = Math.max(bxMax, (p.x * 0.5 + 0.5) * W);
        byMin = Math.min(byMin, (-p.y * 0.5 + 0.5) * H);
        byMax = Math.max(byMax, (-p.y * 0.5 + 0.5) * H);
      }
      return { d: hi, w: bxMax - bxMin, h: byMax - byMin };
    };

    // 3) 俯仰角自适应：找一个俯仰角使「最大放大时建筑群投影的高宽比 == 屏幕高宽比」，
    //    此时最大放大会同时贴满横竖四边（模型刚好填满整个屏幕）。
    //    投影高宽比随俯仰角增大（越平视）而单调减小；搜索范围夹在 [PITCH_MIN, PITCH_MAX]
    //    保持「从上俯视」观感（俯角 30°–45°，pitch 60–45），不出现视角过低。
    //    PITCH_MIN=PITCH_MAX=35（对应俯角 55°）：本版按用户参考图把加载视角钉在 55° 高空俯瞰，
    //    比上一版 40°（pitch=50）更俯视、地面更平、模型「往面前倾斜」的观感明显减弱（接近平放）。
    //    钉死后 fit 不会为「填满屏幕」再调俯仰，保证默认俯角严格 55°。
    //    手动拖动上限仍由 config.maxPitch=75 控制（可拖到更平/更斜），不影响加载默认值。
    const PITCH_MIN = 70;
    const PITCH_MAX = 70;
    // 俯仰角匹配目标：可见区（避开顶 / 底悬浮 UI）的高宽比，而非整屏
    const screenRatio = (H - padTop - padBottom) / Math.max(W - 2 * padX, 1);
    let pitch = THREE.MathUtils.clamp(this.config.pitch, PITCH_MIN, PITCH_MAX);
    let fit = searchAt(pitch);
    if (fit.d === Infinity) return;
    if (Math.abs(fit.h / fit.w - screenRatio) > 0.01) {
      const fa = searchAt(PITCH_MIN);
      const fb = searchAt(PITCH_MAX);
      if (fa.d !== Infinity && fa.h / fa.w <= screenRatio) {
        pitch = PITCH_MIN; // 最俯视一端投影仍偏「扁」：宽度贴满、垂直留白
        fit = fa;
      } else if (fb.d !== Infinity && fb.h / fb.w >= screenRatio) {
        pitch = PITCH_MAX; // 最平视一端投影仍偏「高」：高度贴满、水平留白
        fit = fb;
      } else {
        // 二分逼近「投影高宽比 == 屏幕高宽比」
        let a = PITCH_MIN;
        let b = PITCH_MAX;
        for (let i = 0; i < 14; i++) {
          const mid = (a + b) / 2;
          const fm = searchAt(mid);
          if (fm.d === Infinity) { a = mid; continue; }
          pitch = mid;
          fit = fm;
          if (Math.abs(fm.h / fm.w - screenRatio) < 0.004) break;
          if (fm.h / fm.w > screenRatio) a = mid;
          else b = mid;
        }
      }
    }

    // —— 屏幕双向居中 + 距离收紧 ——
    // 距离二分只保证「全部角点都在屏幕内」，但视中心取包围盒几何中心时，
    // 透视近大远小会让包围盒在屏幕上整体偏侧 / 偏低（模型不在屏幕中间）。
    // 用同一解析相机实测包围盒中心的屏幕偏移，沿「相机右方向 / 前方向」的
    // 地面投影按实测灵敏度（px/米）平移取景中心；平移后再重新二分收紧距离
    // （居中后往往还能放得更大）。「全部建筑可见」优先：收紧失败即回退平移。
    const pxOf = (pt: THREE.Vector3): { x: number; y: number } => {
      const p = pt.clone().project(testCam);
      return { x: (p.x * 0.5 + 0.5) * W, y: (-p.y * 0.5 + 0.5) * H };
    };
    const bboxOffset = (): { offX: number; offY: number } => {
      let bxMin = Infinity, bxMax = -Infinity, byMin = Infinity, byMax = -Infinity;
      for (const c of corners) {
        const s = pxOf(c);
        bxMin = Math.min(bxMin, s.x); bxMax = Math.max(bxMax, s.x);
        byMin = Math.min(byMin, s.y); byMax = Math.max(byMax, s.y);
      }
      // 「居中」目标 = 可见区中心（水平仍取屏幕中心，垂直避开顶 / 底悬浮 UI）。
      // 叠加 shiftDownPx：让模型整体向下（朝观察者）偏移一点点。
      return { offX: (bxMin + bxMax) / 2 - W / 2, offY: (byMin + byMax) / 2 - (visCy + shiftDownPx) };
    };
    for (let iter = 0; iter < 3; iter++) {
      placeTestCam(look, dirAt(pitch), fit.d);
      const { offX, offY } = bboxOffset();
      if (Math.abs(offX) < 1 && Math.abs(offY) < 1) break;
      // 相机右方向 / 前方向在地面（xoy 平面，z 为高度）上的投影，作为平移基向量
      const right = new THREE.Vector3().setFromMatrixColumn(testCam.matrixWorld, 0);
      const fwd = look.clone().sub(testCam.position);
      const rightG = new THREE.Vector3(right.x, right.y, 0);
      const fwdG = new THREE.Vector3(fwd.x, fwd.y, 0);
      if (rightG.lengthSq() < 1e-6 || fwdG.lengthSq() < 1e-6) break;
      rightG.normalize();
      fwdG.normalize();
      // 灵敏度探测：视中心沿基向量走 1 米对应的屏幕位移（px/米）。
      // 方向推导：视中心右移 Δ → 画面内容整体左移 Δ·dx px（内容与相机反向移动），
      // 故居中修正取 +off/d（旧实现取负号，方向反了导致越修越偏、被复核回退）。
      const p0 = pxOf(look);
      const dx = pxOf(look.clone().addScaledVector(rightG, 1)).x - p0.x;
      const dy = pxOf(look.clone().addScaledVector(fwdG, 1)).y - p0.y;
      const look2 = look.clone();
      // 居中目标偏移 shiftPx：让模型在屏幕上偏左一点点（offX 最终收敛到 -shiftPx）
      if (Math.abs(dx) > 1e-6) look2.addScaledVector(rightG, (offX + shiftPx) / dx);
      if (Math.abs(dy) > 1e-6) look2.addScaledVector(fwdG, offY / dy);
      // 平移后重新收紧距离（居中后常可再放大）；放不下 / 距离异常暴涨则回退平移
      const prevLook = look.clone();
      look.copy(look2);
      const fit2 = searchAt(pitch);
      if (fit2.d === Infinity || fit2.d > fit.d * 1.3) {
        look.copy(prevLook); // fit 仍对应 prevLook，无需重算
      } else {
        fit = fit2;
      }
    }

    // 取景中心（建筑群屏幕居中后的地面点）→ GCJ-02 经纬度
    const [wlng, wlat] = this.worldToWgs84(look);
    let fitCenter: [number, number] = wgs84ToGcj02(wlng, wlat);

    // 距离 → 缩放级别：d ∝ 2^(-zoom)，以实测 (zoom0, dist0) 为基准换算；夹在地图缩放范围 [3, 20] 内
    const zoomFit = Math.min(Math.max(zoom0 + Math.log2(dist0 / fit.d), 3), 20);
    // 先应用自适应俯仰角（config.maxPitch 已放宽到与 PITCH_MAX 一致，不会被俯仰钳制拉回）
    this.setPitchSafe(pitch);
    const finalZoom = +(zoomFit + ZOOM_BONUS).toFixed(3);
    // 在「刚好填满」基础上额外放大一点点（ZOOM_BONUS），让模型显得更大些
    this.map.setZoomAndCenter(finalZoom, fitCenter, true);

    // —— 额外屏幕平移：模型在画面里再往左 / 往远处（屏幕上）各挪一点 ——
    // 用高德自己的「容器像素 ↔ 经纬度」换算做精确平移。不能用上面解析相机的 px/米
    // 灵敏度：那是「世界点相对固定斜视相机」的投影灵敏度，而平移地图 center 的屏幕
    // 灵敏度由 zoom 决定；斜视下两者差好几倍，直接套用会把几十像素放大成几百像素。
    // 只改取景中心：zoom / pitch / rotation 一律不变，模型世界坐标也不动。
    const [nudgeL, nudgeF] = this.viewNudge;
    if (Math.abs(nudgeL) > 1e-6 || Math.abs(nudgeF) > 1e-6) {
      try {
        // 内容左移 nudgeL*W、上移 nudgeF*H ⟺ 新取景中心 = 当前视图里容器坐标
        // (W/2 + nudgeL*W, H/2 + nudgeF*H) 对应的地面点；设为中心后原中心会显示在
        // (W/2 - nudgeL*W, H/2 - nudgeF*H)，即整体往左、往上（远处）挪。
        const converter = this.map.containerToLngLat || this.map.pixelToLngLat;
        const ll = converter.call(this.map, new this.AMap.Pixel(W / 2 + nudgeL * W, H / 2 + nudgeF * H));
        const nudgedCenter: [number, number] = [ll.getLng(), ll.getLat()];
        this.map.setZoomAndCenter(finalZoom, nudgedCenter, true);
        fitCenter = nudgedCenter; // 低配 / 微调路径也以平移后的中心为准
        // eslint-disable-next-line no-console
        console.info(`[MapScene] 取景平移：左 ${(nudgeL * W).toFixed(0)}px / 远处 ${(nudgeF * H).toFixed(0)}px（zoom/pitch/rotation 不变）`);
      } catch {
        // 个别高德版本没有容器↔经纬度换算：保持原取景，不影响加载
        // eslint-disable-next-line no-console
        console.warn('[MapScene] 取景平移不可用（containerToLngLat 缺失），已跳过');
      }
    }
    // eslint-disable-next-line no-console
    console.info(
      `[MapScene] 自动取景：估算 zoom=${zoomFit.toFixed(2)}、pitch=${pitch.toFixed(1)}（建筑角点 ${corners.length} 个，` +
        `最近取景距离 ${fit.d.toFixed(0)}m / 当前 ${dist0.toFixed(0)}m，投影宽高 ${fit.w.toFixed(0)}×${fit.h.toFixed(0)}px ` +
        `vs 屏幕 ${W}×${H}px，最外侧节点 ${extremeNodes()}）` +
        `，应用 zoom=${(zoomFit + ZOOM_BONUS).toFixed(3)} / rotation=${Number(this.map.getRotation?.()).toFixed(1)}°`,
    );

    // 低配设备：跳过逐帧迭代微调。微调每帧调用 setZoomAndCenter 会反复触发高德底图瓦片重载，
    // 是加载期 CPU 瞬间 100% 且 loading 拖到 5~10s 的主要来源；直接以估算 zoom 取景并立即显示模型，
    // 换取更快的首次加载。取景精度略有下降，但对低配机器利大于弊。
    // 初始方位已定死时也跳过逐帧微调：refineFitStep 用的是「真实相机」（该方位），
    // 会按新方位重新居中 / 收紧缩放，改变上面按正北基准算好的 zoom / center，
    // 破坏「只换朝向、取景不变」。解析取景实测已足够准（不微调时最终 zoom 与收敛值一致）。
    if (this.lowEnd || this.initialRotation !== 0) {
      if (this.modelRoot) this.modelRoot.visible = true;
      return; // 不挂 fitRefine → loadModel 中 `if (!this.fitRefine) onFitComplete()` 会照常揭开遮罩
    }

    // 挂迭代微调：上面的换算若与高德实际相机模型有偏差，会在 render() 里用真实相机
    // 逐帧修正（先居中、再俯仰均衡、最后按「填满倍率」收紧缩放），见 refineFitStep。
    // 微调期间隐藏模型：各步修正都是立即生效的跳变，若模型可见，逐帧摆动会被
    // 看成「加载时模型抖动两下」；底图自身调整无参照物、肉眼几乎无感。
    // 收敛 / 超时 / 异常时由 endFitRefine() 恢复显示（模型出现即在最终稳定位置）。
    this.modelRoot.visible = false;
    this.fitRefine = {
      corners,
      minX,
      maxX,
      minY,
      maxY,
      center: fitCenter,
      pitch,
      lastZoom: +zoomFit.toFixed(3),
      lastCenter: fitCenter,
      tries: 20,
      startedAt: performance.now(),
    };
  }

  /** 结束取景微调：恢复模型显示（微调期间隐藏以避免逐帧修正被看成「加载时抖动」），
   *  并通知上层取景已完成（加载遮罩可以揭开了） */
  private endFitRefine(): void {
    if (!this.fitRefine) return; // 幂等：重复调用不重复回调
    this.fitRefine = null;
    if (this.loadStartTs && this.onLoadEntryTs) {
      const parseMs = Math.round(this.onLoadEntryTs - this.loadStartTs);
      const postMs = Math.round(performance.now() - this.onLoadEntryTs);
      // eslint-disable-next-line no-console
      console.info(`[MapScene] 取景完成：下载+解析=${parseMs}ms，后处理=${postMs}ms，合计=${parseMs + postMs}ms`);
    }
    if (this.modelRoot && !this.modelRoot.visible) {
      this.modelRoot.visible = true;
      // 揭开加载遮罩前补一帧完整底图，避免首帧只有模型没有底图
      this.markDirty(true);
    }
    this.callbacks.onFitComplete?.();
  }

  /**
   * 取景迭代微调（在 render() 中相机已与地图同步后调用，每帧最多一步）。
   * 用真实相机投影全部建筑角点得到屏幕包围盒，按优先级逐步收敛到「居中 + 填满」：
   *  1) 包围盒中心偏离可见区中心 → 按实测灵敏度（px/米）平移取景中心（居中优先：
   *     已在屏幕内的包围盒居中后必然仍在屏幕内，收紧缩放不会把它推出屏幕）；
   *  2) 两方向填满率失衡（fX≠fY，解析俯仰角估计与真实相机有系统偏差）→ 微调
   *     俯仰角使投影高宽比贴合可见区高宽比（俯仰角越大越平视、投影越扁）；
   *  3) 填满倍率 f = min(fX, fY) 偏离 1 → 按 log2(f) 修正 zoom（f>1 还能放大、
   *     f<1 出画需拉远；f<1 与居中状态无关，必定成立）。
   * 包围盒居中（±3px）且两方向 |log2(f)| < 0.01、或迭代用尽 / 超时即结束。
   */
  private refineFitStep(): void {
    const v = this.fitRefine;
    if (!v) return;
    if (performance.now() - v.startedAt > 600) {
      this.endFitRefine(); // 超时放弃（如用户已开始操作地图），恢复模型显示；放宽收敛容差后正常几帧即收敛，此处仅为兜底。
      // 微调每帧 setZoomAndCenter 会触发高德底图瓦片重载（见 fitToBuildings 注释），是加载期 CPU 尖峰的主源，
      // 故把上限压到 600ms：解析取景（fitToBuildings）已给出接近满屏的估算，600ms 微调足够收敛到肉眼无感，
      // 既保帧又控加载时长；低配设备本就跳过微调（同注释）。
      return;
    }
    if (!this.map || !this.camera || !this.customCoords) return;
    const zoomNow = Number(this.map.getZoom?.());
    if (!Number.isFinite(zoomNow)) return;
    // 相机还停在旧状态（本次设置的 zoom / center / pitch 尚未生效）或已被外部
    // 改动 → 本帧跳过，等待设置的视角真正落地后再测量
    if (Math.abs(zoomNow - v.lastZoom) > 0.01) return;
    const cNow = this.map.getCenter?.();
    if (cNow) {
      if (Math.abs(Number(cNow.lng) - v.lastCenter[0]) > 1e-6) return;
      if (Math.abs(Number(cNow.lat) - v.lastCenter[1]) > 1e-6) return;
    }
    if (Math.abs(Number(this.map.getPitch?.()) - v.pitch) > 0.2) return;

    // 真实相机投影全部角点 → 屏幕包围盒
    this.camera.updateMatrixWorld(true);
    const W = this.container.clientWidth || 1;
    const H = this.container.clientHeight || 1;
    let lx = Infinity, hx = -Infinity, ly = Infinity, hy = -Infinity;
    for (const c of v.corners) {
      const p = c.clone().project(this.camera);
      lx = Math.min(lx, (p.x * 0.5 + 0.5) * W);
      hx = Math.max(hx, (p.x * 0.5 + 0.5) * W);
      ly = Math.min(ly, (-p.y * 0.5 + 0.5) * H);
      hy = Math.max(hy, (-p.y * 0.5 + 0.5) * H);
    }
    // 可见区（NDC 边距 → px）：左右对称；顶 / 底边距不同（避开悬浮 UI）
    const leftPx = ((1 + v.minX) / 2) * W;
    const rightPx = ((1 + v.maxX) / 2) * W;
    const topPx = ((1 - v.maxY) / 2) * H;
    const bottomPx = ((1 - v.minY) / 2) * H;
    const visCy = (topPx + bottomPx) / 2;
    // 默认取景：让模型在屏幕上向左偏移（与 fitToBuildings 的 shiftPx 一致，用户接受左侧裁切）；
    // 同时向下（朝观察者）偏移 shiftDownPx（与 fitToBuildings 的 shiftDownPx 一致，0.11）
    // 与 fitToBuildings 的默认平移保持一致，再叠加 config.viewNudge 的额外量，
    // 避免低配 / 微调路径与解析取景落在不同位置。
    const shiftPx = (0.12 + this.viewNudge[0]) * W;
    const shiftDownPx = (0.11 - this.viewNudge[1]) * H;
    const offX = (lx + hx) / 2 - (leftPx + rightPx) / 2;
    const offY = (ly + hy) / 2 - (visCy + shiftDownPx);
    // 两方向填满率：包围盒宽 / 高分别占可见区宽 / 高的比例（>1 有富余、<1 出画）
    const availW = Math.max(rightPx - leftPx, 1);
    const availH = Math.max(bottomPx - topPx, 1);
    const fX = availW / Math.max(hx - lx, 1e-6);
    const fY = availH / Math.max(hy - ly, 1e-6);
    const err = Math.log2(Math.min(fX, fY));
    const done = (reason: string): void => {
      // 在「刚好填满」基础上额外放大一点点（ZOOM_BONUS），让模型显得更大些
      const zEnd = Number(this.map.getZoom?.() ?? zoomNow) + 0.14;
      this.map.setZoomAndCenter(+zEnd.toFixed(3), v.center, true);
      this.endFitRefine(); // 结束微调并恢复模型显示
      // eslint-disable-next-line no-console
      console.info(
        `[MapScene] 取景收敛（${reason}）：zoom=${zEnd.toFixed(2)}、pitch=${v.pitch.toFixed(1)}，` +
          `角点屏幕范围 x[${lx.toFixed(0)}~${hx.toFixed(0)}]/${W}，y[${ly.toFixed(0)}~${hy.toFixed(0)}]/${H}`,
      );
    };
    if (
      Math.abs(offX + shiftPx) <= 6 && Math.abs(offY) <= 6 &&
      Math.abs(Math.log2(fX)) < 0.02 && Math.abs(Math.log2(fY)) < 0.02
    ) {
      done('居中且填满'); // 已收敛：两方向都贴满可见区（容差放宽为 6px / 2%，肉眼无感，避免死循环跑到超时）
      return;
    }
    if (v.tries <= 0) {
      done('迭代用尽'); // 兜底结束并输出诊断
      return;
    }
    v.tries -= 1;

    // 1) 居中优先：平移取景中心（保持 zoom 不变），下一帧再复核 / 收紧缩放
    if (Math.abs(offX) > 3 || Math.abs(offY) > 3) {
      const params = this.customCoords.getCameraParams?.();
      if (!params?.lookAt) return;
      const lookW = new THREE.Vector3(params.lookAt[0], params.lookAt[1], params.lookAt[2]);
      const rightW = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const rightG = new THREE.Vector3(rightW.x, rightW.y, 0);
      const fwdG = new THREE.Vector3(
        lookW.x - this.camera.position.x,
        lookW.y - this.camera.position.y,
        0,
      );
      if (rightG.lengthSq() < 1e-6 || fwdG.lengthSq() < 1e-6) {
        done('无法居中'); // 纯俯视等极端情况，放弃居中
        return;
      }
      rightG.normalize();
      fwdG.normalize();
      // 灵敏度探测（真实相机）：视中心沿基向量走 1 米对应的屏幕位移（px/米）
      const cam = this.camera; // 闭包内 TS 不保留 this.camera 的非空收窄，取局部引用
      const prj = (pt: THREE.Vector3): { x: number; y: number } => {
        const q = pt.clone().project(cam);
        return { x: (q.x * 0.5 + 0.5) * W, y: (-q.y * 0.5 + 0.5) * H };
      };
      const p0 = prj(lookW);
      const dx = prj(lookW.clone().addScaledVector(rightG, 1)).x - p0.x;
      const dy = prj(lookW.clone().addScaledVector(fwdG, 1)).y - p0.y;
      // 修正方向：视中心右移 → 内容左移，故取 +off/d；0.9 阻尼防过冲。
      // 叠加 shiftPx：让模型最终在屏幕上偏左一点点（offX 收敛到 -shiftPx）。
      const look2 = lookW.clone();
      if (Math.abs(dx) > 1e-6) look2.addScaledVector(rightG, (0.9 * (offX + shiftPx)) / dx);
      if (Math.abs(dy) > 1e-6) look2.addScaledVector(fwdG, (0.9 * offY) / dy);
      const [wl, wt] = this.worldToWgs84(look2);
      v.center = wgs84ToGcj02(wl, wt);
      v.lastCenter = v.center;
      this.map.setZoomAndCenter(zoomNow, v.center, true);
      return;
    }

    // 2) 俯仰角均衡：两方向填满率失衡（解析估计与真实相机有系统偏差）时，
    //    微调俯仰角把投影高宽比拉到与可见区一致——fY 富余（偏扁）→ 俯仰角调小
    //    （更俯视、投影变高），fX 富余（偏高）→ 俯仰角调大。
    //    高度投影 ln(h) 对俯仰角的灵敏度 ≈ -cot(仰角)（弧度→度换算后每度），
    //    需要的相对高度变化 = fY/fX - 1，据此估算步长；0.8 阻尼防过冲。
    if (Math.abs(Math.log2(fY / fX)) > 0.02) {
      const theta = THREE.MathUtils.degToRad(90 - v.pitch); // 相机仰角
      // |d ln h / d pitch| = cot(仰角)（每弧度）→ 每度；俯视极限下灵敏度趋 0，兜底 0.05
      const sens = Math.max(1 / Math.max(Math.tan(theta), 1e-3), 0.05) * (Math.PI / 180);
      const dp = THREE.MathUtils.clamp(-(Math.log(fY / fX) / sens) * 0.8, -3, 3);
      const pMin = Math.max(this.config.minPitch ?? 0, 5);
      const pMax = Math.min(this.config.maxPitch ?? 75, 80);
      const pNew = THREE.MathUtils.clamp(v.pitch + dp, pMin, pMax);
      if (Math.abs(pNew - v.pitch) >= 0.05) {
        v.pitch = +pNew.toFixed(2);
        this.setPitchSafe(v.pitch);
        return; // 等俯仰角生效后下一帧复测（zoom / center 不动）
      }
      // 已抵俯仰角上下限：不再均衡，退化为只按短板收紧缩放（另一方向留白）
    }

    // 3) 收紧扣缩放：f>1 拉近放大、f<1 拉远保证全部建筑可见；0.9 阻尼防过冲
    const z = Math.min(Math.max(zoomNow + 0.9 * err, 3), 20);
    if (Math.abs(z - zoomNow) < 0.001) {
      done('已抵 zoom 上下限');
      return;
    }
    v.lastZoom = +z.toFixed(3);
    this.map.setZoomAndCenter(v.lastZoom, v.center, true);
  }

  /** 收集模型中所有去重后的贴图（7 个常用贴图槽位），供后处理各段分片执行 */
  private collectTextures(root: THREE.Object3D): THREE.Texture[] {
    const seen = new Set<THREE.Texture>();
    const out: THREE.Texture[] = [];
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const mat = m as THREE.MeshStandardMaterial;
        if (!mat) continue;
        const maps: Array<THREE.Texture | null | undefined> = [
          mat.map,
          mat.roughnessMap,
          mat.metalnessMap,
          mat.normalMap,
          mat.emissiveMap,
          mat.aoMap,
          mat.alphaMap,
        ];
        for (const tex of maps) {
          if (tex && !seen.has(tex)) {
            seen.add(tex);
            out.push(tex);
          }
        }
      }
    });
    return out;
  }

  /** 收集（材质, baseColor 贴图）去重对：黑图检测按纹理去重（同一纹理在楼栋间共享材质时只处理一次） */
  private collectMatMapPairs(
    root: THREE.Object3D,
  ): Array<{ mat: THREE.MeshStandardMaterial; tex: THREE.Texture }> {
    const seen = new Set<THREE.Texture>();
    const out: Array<{ mat: THREE.MeshStandardMaterial; tex: THREE.Texture }> = [];
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const mat = m as THREE.MeshStandardMaterial;
        if (!mat || !mat.map || seen.has(mat.map)) continue;
        seen.add(mat.map);
        out.push({ mat, tex: mat.map });
      }
    });
    return out;
  }

  /**
   * 把单张贴图缩放到 WebGL 上下文 MAX_TEXTURE_SIZE 上限以内（超过才处理，返回是否被缩放）。
   * 高德 GLCustomLayer 在多数环境下提供的是 WebGL1 上下文，其单张贴图尺寸上限
   * （常见 4096 或更低）可能小于建模软件导出的大贴图；超限的贴图上传会失败，
   * 对应材质退化为白色/灰色平面，观感即「材质丢失」。
   * 缩放通过离屏 canvas 重绘实现，不改原始模型文件。
   */
  private clampTextureToMaxSize(tex: THREE.Texture): boolean {
    const hwMax = this.renderer?.capabilities?.maxTextureSize ?? 4096;
    // s471: GLB now ships a handful of 2048px facade atlases for the largest
    // buildings (sharper). A 2048x2048 RGBA texture costs 16MB of VRAM; on a
    // low-end integrated GPU 8+ of those plus ~60 x 1024 can overflow shared
    // memory and cause the stutter / failed load the user reported. Cap them
    // at 1024 in lowEnd mode (reuse the existing canvas downscale path below);
    // capable machines keep the full resolution. 1024 is still well above the
    // old "<=256" low-end path that made every facade look washed out.
    const maxSize = this.lowEnd ? Math.min(hwMax, 1024) : hwMax;
    if (typeof document === 'undefined') return false; // 非浏览器环境（如测试）跳过
    const img = tex.image as { width?: number; height?: number } | undefined;
    if (!img || !img.width || !img.height) return false;
    const longest = Math.max(img.width, img.height);
    if (longest <= maxSize) return false;
    const scale = maxSize / longest;
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    try {
      ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);
    } catch {
      return false; // 极少数 ImageBitmap/跨域情况下 drawImage 可能抛错，保留原贴图
    }
    tex.image = canvas;
    tex.needsUpdate = true;
    return true;
  }

  /**
   * 让单张贴图在 WebGL1 下可安全渲染（修复「部分建筑材质丢失」），返回是否被降级。
   *
   * 根因：高德 GLCustomLayer 多数环境给的是 **WebGL1** 上下文。GLTFLoader 默认给贴图开启
   * `generateMipmaps=true` + 三线性过滤，而 WebGL1 规范**不支持「非 2 的幂(NPOT)尺寸纹理 + mipmap」**——
   * 这类纹理会被驱动直接丢弃，对应材质渲染成黑色/空白，观感即「建筑材质丢失」（仅部分贴图为 NPOT，
   * 故表现为「某些」而非「全部」建筑）。
   *
   * 处理：WebGL1 下对 NPOT 贴图降级为「关闭 mipmap + minFilter 退为 LinearFilter + wrap 退为
   * ClampToEdgeWrapping」，这是 WebGL1 对 NPOT 纹理唯一合法的渲染方式（代价是远处略有锯齿）。
   * WebGL2 原生支持 NPOT + mipmap，调用方直接跳过。且仅对「非 2 的幂(NPOT)」尺寸降级：
   * POT 纹理（无论 wrap 是 Repeat 还是 Clamp）在 WebGL1 中均完全合法，必须原样保留——
   * 否则会破坏本用于平铺(Repeat)的立面贴图：强制 ClampToEdge 后墙面只采样到贴图边缘像素，
   * 整面渲染成纯色，观感即「材质丢失」。
   */
  private makeTextureWebGL1Safe(tex: THREE.Texture): boolean {
    const caps = this.renderer?.capabilities;
    if (!caps || caps.isWebGL2) return false; // WebGL2 原生支持 NPOT，无需降级
    const img = tex.image as { width?: number; height?: number } | undefined;
    const w = img?.width ?? 0;
    const h = img?.height ?? 0;
    const isPOT = w > 0 && h > 0 && (w & (w - 1)) === 0 && (h & (h - 1)) === 0;
    if (isPOT) return false;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return true;
  }

  /** 黑图检测的 32×32 采样画布上下文（懒创建、跨贴图复用；document 不存在时为 null） */
  private blackSampleCtx: CanvasRenderingContext2D | null | undefined;
  /** 黑图替换生成的立面纹理缓存（按原纹理 uuid），每次模型加载后处理前清空 */
  private facadeCache = new Map<string, THREE.Texture>();

  /**
   * GLB 文件本身存在「渲染后纯黑」的损坏立面贴图（导出或贴图烘焙失败所致，其像素几乎
   * 完全一致、方差≈0），会让对应楼栋渲染成黑墙，观感即「材质丢失」。无法凭空还原真实立面
   * 照片，因此把「整体偏暗且方差极小（均匀黑占位图）」的 baseColor 贴图
   * 自动替换为程序化生成的建筑立面纹理（墙+窗格），让这些楼从「黑盒子」变成正常的墙+窗格外观。
   *
   * 判据刻意使用「方差极小」而非「平均亮/暗」或「贴图尺寸」：
   *  - 偏暗但带真实立面细节的合法贴图（例如食堂深色立面，std 很大）不会被误判；
   *  - 模型里大量 16×16 的小贴图（太阳能板、屋顶、女儿墙、沥青地面等）虽小但属合法材质，
   *    绝不以「尺寸」作为判定，避免把正常楼栋/屋顶/地面的材质误改。
   * 仅此「均匀黑」一类会被启发式替换，其余材质一律原样保留。
   * 返回是否发生了替换。（旧实现 fixMaterialTextures 的逐材质版本，拆出以便分片执行，行为一致。）
   */
  private fixMatMapIfBlack(pair: { mat: THREE.MeshStandardMaterial; tex: THREE.Texture }): boolean {
    if (typeof document === 'undefined') return false; // 非浏览器环境（如测试）跳过
    if (this.blackSampleCtx === undefined) {
      const sampler = document.createElement('canvas');
      sampler.width = 32;
      sampler.height = 32;
      this.blackSampleCtx = sampler.getContext('2d', { willReadFrequently: true });
    }
    const sctx = this.blackSampleCtx;
    if (!sctx) return false;
    const { mat, tex } = pair;
    const img = tex.image as CanvasImageSource | undefined;
    if (!img) return false;
    try {
      // 采样 32×32 算出灰度均值与标准差；仅「均值低且方差极小（均匀黑）」判定为损坏占位图。
      sctx.clearRect(0, 0, 32, 32);
      sctx.drawImage(img, 0, 0, 32, 32);
      const data = sctx.getImageData(0, 0, 32, 32).data;
      const n = data.length / 4;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      const mean = sum / n;
      let varSum = 0;
      for (let i = 0; i < data.length; i += 4) {
        const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        varSum += (l - mean) * (l - mean);
      }
      const std = Math.sqrt(varSum / n);
      if (mean < 40 && std < 16) {
        mat.map = this.facadeFor(tex);
        mat.needsUpdate = true;
        return true;
      }
    } catch {
      // 采样失败（图片未就绪等）则跳过，不影响其它材质
    }
    return false;
  }

  /** 同一张损坏黑图可能被多个材质复用；按原纹理 uuid 缓存生成的立面纹理，保证复用一致 */
  private facadeFor(tex: THREE.Texture): THREE.Texture {
    let t = this.facadeCache.get(tex.uuid);
    if (!t) {
      // 用原纹理 uuid 派生一个稳定变体，避免所有楼长得一模一样。
      let h = 0;
      for (let i = 0; i < tex.uuid.length; i++) h = (h * 31 + tex.uuid.charCodeAt(i)) >>> 0;
      t = this.makeFacadeTexture(h % 4);
      this.facadeCache.set(tex.uuid, t);
    }
    return t;
  }

  /** 生成一张程序化建筑立面纹理（墙 + 窗格网格），variants 控制配色与窗格密度 */
  private makeFacadeTexture(variant: number): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext('2d')!;
    const palettes = [
      { wall: '#cdd6e0', frame: '#aeb8c4', glass: '#33485f' },
      { wall: '#d8d2c4', frame: '#bdb29c', glass: '#3a4a52' },
      { wall: '#c9d8d2', frame: '#a9bcb2', glass: '#2f4a4a' },
      { wall: '#d3c9d6', frame: '#b6a8bc', glass: '#3b3350' },
    ];
    const p = palettes[variant % palettes.length];
    ctx.fillStyle = p.wall;
    ctx.fillRect(0, 0, 256, 256);
    const cols = 4;
    const rows = 6;
    const mx = 16;
    const my = 14;
    const cw = (256 - mx * 2) / cols;
    const ch = (256 - my * 2) / rows;
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const x = mx + col * cw + 4;
        const y = my + r * ch + 4;
        const w = cw - 8;
        const h = ch - 8;
        // 窗框
        ctx.fillStyle = p.frame;
        ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
        // 玻璃
        ctx.fillStyle = p.glass;
        ctx.fillRect(x, y, w, h);
        // 高光
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(x, y, w, Math.max(2, h * 0.18));
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * 让出主线程一帧（优先 rAF，退化到 setTimeout），避免大段同步处理在低配机器上一次性阻塞、卡死 UI。
   * 用于把「加载时 108 张贴图处理 + 首帧 GPU 上传」拆成多个可被打断的小段，让加载遮罩持续刷新、CPU 不被打满。
   */
  private yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
      else setTimeout(resolve, 0);
    });
  }

  /**
   * 分片执行逐项处理：每片耗时不超过 ~14ms，片间让出一帧并回报阶段进度（onModelStage）。
   * 把原本「整块同步」的贴图循环拆开——低配机器上单段同步循环可达十几秒，表现为
   * 「进度 100% 后遮罩卡死」；拆片后遮罩持续刷新、主线程不再被一次性打满。
   */
  private async runChunked<T>(
    items: readonly T[],
    label: string,
    step: (item: T) => void,
  ): Promise<void> {
    if (items.length === 0) return;
    const t0 = performance.now();
    let sliceStart = t0;
    for (let i = 0; i < items.length; i++) {
      step(items[i]);
      if (performance.now() - sliceStart > 14 && i < items.length - 1) {
        this.callbacks.onModelStage?.(label, i + 1, items.length);
        await this.yieldToEventLoop();
        if (this.disposed) return;
        sliceStart = performance.now();
      }
    }
    this.callbacks.onModelStage?.(label, items.length, items.length);
    // eslint-disable-next-line no-console
    console.info(`[MapScene] ${label}：${items.length} 项，耗时 ${Math.round(performance.now() - t0)}ms`);
  }

  /**
   * 并行触发贴图解码（仅 HTMLImageElement 路径需要；ImageBitmap 路径在 GLB 解析期已解码）。
   * 旧流程里解码发生在首次 drawImage 时逐张串行触发，108 张在低配 CPU 上是十几秒的串行开销；
   * 交给浏览器并行解码（img.decode() 在浏览器内部线程池执行）后墙钟时间大幅缩短。
   */
  private async predecodeTextures(textures: readonly THREE.Texture[]): Promise<void> {
    if (typeof HTMLImageElement === 'undefined') return;
    const imgs: HTMLImageElement[] = [];
    for (const tex of textures) {
      const img = tex.image;
      if (img instanceof HTMLImageElement && typeof img.decode === 'function') imgs.push(img);
    }
    if (!imgs.length) return;
    const t0 = performance.now();
    await Promise.allSettled(imgs.map((img) => img.decode()));
    // eslint-disable-next-line no-console
    console.info(`[MapScene] 贴图并行解码：${imgs.length} 张，耗时 ${Math.round(performance.now() - t0)}ms`);
  }

  /**
   * 软件光栅环境下的温和贴图降尺寸（返回是否实际发生了降尺寸，仅用于计数）。
   * 仅当「lowEnd 且确为软件光栅(SwiftShader)」且贴图最长边 > 1024 时才重绘到较小 canvas：
   *  - 软件光栅下整条 GL 流水线在 CPU 上跑，缩小极大贴图可略降逐帧填充率；
   *  - 但**保留 mipmap 与过滤方式**（不关、不改），否则楼栋/非楼栋材质会发灰、变糊、闪烁，观感像材质丢失；
   *  - 32 位/老内核 UA 强制的低配（如 360极速浏览器）走不到这里：其瓶颈在 AMap 自身逐帧重绘，
   *    降纹理既无效又伤观感，故直接跳过（见 runModelOnLoad 中的调用门控）。
   */
  private reduceTextureForLowEnd(tex: THREE.Texture): boolean {
    if (!this.lowEnd || !this.softwareRender) return false;
    if (typeof document === 'undefined') return false; // 非浏览器环境（如测试）跳过
    const MAX = 1024; // 仅对极大贴图温和降尺寸；保留 mipmap，避免观感退化
    const img = tex.image as { width?: number; height?: number } | undefined;
    const w = img?.width ?? 0;
    const h = img?.height ?? 0;
    if (!w || !h) return false;
    const longest = Math.max(w, h);
    if (longest <= MAX) return false;
    const scale = MAX / longest;
    const nw = Math.max(1, Math.round(w * scale));
    const nh = Math.max(1, Math.round(h * scale));
    try {
      const canvas = document.createElement('canvas');
      canvas.width = nw;
      canvas.height = nh;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        // 不改动 generateMipmaps / minFilter / anisotropy：保留原材质观感，仅缩小像素量
        ctx.drawImage(img as CanvasImageSource, 0, 0, nw, nh);
        tex.image = canvas;
        tex.needsUpdate = true;
        return true;
      }
    } catch {
      /* 个别 ImageBitmap/跨域 drawImage 抛错则保留原图 */
    }
    return false;
  }

  /**
   * 加载后合并「同材质」网格，削减 draw call 数量（CPU 端绘制调用是拖动卡顿主因之一）。
   * 策略（零拾取 / 高亮风险）：
   *  - 非楼栋网格（道路 / 标线 / 球场 / 水面 / 草地 / 树木 / 装饰）：跨全模型按材质合并 → 永不参与拾取；
   *  - 楼栋网格：仅在「同一栋楼内」按材质合并，保留楼栋节点 → 悬停高亮 / 射线拾取仍可逐栋向上回溯；
   *  - 排除：房间格子（需逐层可见性）、被 modelNodeFilter 隐藏的节点子树（合并会解除隐藏并重入包围盒 / 阴影）、
   *    以及依赖 Object 坐标生成 UV 的树木叶 / 干材质（烘焙世界变换会破坏其贴图采样）。
   * 注意：仅当同组网格数 ≥ 2 才真正合并（单网格无收益，保留原样，绝不删除几何）。
   */
  private simplifyDrawCalls(): void {
    if (!this.modelRoot) return;
    const root = this.modelRoot; // 局部 const，供闭包内类型收窄（属性无法跨闭包收窄）
    const isBuildingName = (n: string): boolean => this.buildingNames.has(n);
    const filter = this.config.modelNodeFilter;
    const hidePats = ((filter && filter.patterns) || []).map((p) => p.toLowerCase()).filter(Boolean);

    // 该网格（含任一祖先）是否处于被 modelNodeFilter 隐藏的子树内
    const isHiddenNode = (o: THREE.Object3D): boolean => {
      let p: THREE.Object3D | null = o;
      while (p && p !== root) {
        if (hidePats.some((pat) => (p!.name || '').toLowerCase().includes(pat))) return true;
        p = p.parent;
      }
      return false;
    };
    // 该网格所属楼栋节点（向上找首个名为建筑编号的祖先）
    const buildingAncestorOf = (o: THREE.Object3D): THREE.Object3D | null => {
      let p = o.parent;
      while (p && p !== root) {
        if (isBuildingName(p.name)) return p;
        p = p.parent;
      }
      return null;
    };
    const attrSig = (g: THREE.BufferGeometry): string => {
      const names = Object.keys(g.attributes).sort().join(',');
      return (g.index ? 'I' : 'N') + '|' + names;
    };

    root.updateMatrixWorld(true);
    interface MergeItem { geom: THREE.BufferGeometry; mesh: THREE.Mesh; }
    const groups = new Map<string, { mat: THREE.Material; parent: THREE.Object3D; items: MergeItem[] }>();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry || !mesh.geometry.attributes.position) return;
      const ud = mesh.userData as Record<string, unknown> | undefined;
      if (ud && (ud.isRoom || ud.room)) return; // 房间格子：逐层可见性，保留
      if (Array.isArray(mesh.material)) return; // 多材质网格：保留
      const mat = mesh.material as THREE.Material | undefined;
      if (!mat) return;
      if (/(^|_)Leaf(_|$)|Trunk|Tree/i.test(mat.name || '')) return; // 树木叶/干：Object 坐标 UV，烘焙会破坏
      if (isHiddenNode(mesh)) return; // 被节点过滤隐藏：合并会解除隐藏并污染包围盒/阴影
      const ancestor = buildingAncestorOf(mesh);
      const targetParent = ancestor ?? root;
      mesh.updateWorldMatrix(true, false);
      const invParent = new THREE.Matrix4().copy(targetParent.matrixWorld).invert();
      const xf = new THREE.Matrix4().multiplyMatrices(invParent, mesh.matrixWorld);
      const g = mesh.geometry.clone();
      g.applyMatrix4(xf);
      const sig = attrSig(g);
      const key = (ancestor ? 'B:' + ancestor.uuid : 'N') + '|' + mat.uuid + '|' + sig;
      let grp = groups.get(key);
      if (!grp) { grp = { mat, parent: targetParent, items: [] }; groups.set(key, grp); }
      grp.items.push({ geom: g, mesh });
    });

    let mergedCount = 0;
    const consumed: THREE.Mesh[] = [];
    for (const grp of groups.values()) {
      if (grp.items.length < 2) continue; // 单网格无收益，保留原样
      let merged: THREE.BufferGeometry | null = null;
      try { merged = mergeGeometries(grp.items.map((i) => i.geom), false); } catch { merged = null; }
      if (!merged) continue; // 属性不兼容等：放弃该组合并，保留原网格
      const m = new THREE.Mesh(merged, grp.mat);
      m.name = (grp.parent === root ? 'MergedNB_' : 'MergedB_') + mergedCount;
      // 保留源网格的阴影标志（源网格统一 cast/receive=true，见 runModelOnLoad 的 traverse）；
      // 合并网格若不设会丢失建筑阴影，故继承首项的标志（同组同类型，结果一致）。
      const src0 = grp.items[0].mesh;
      m.castShadow = src0.castShadow;
      m.receiveShadow = src0.receiveShadow;
      grp.parent.add(m);
      mergedCount++;
      for (const it of grp.items) consumed.push(it.mesh);
      for (const it of grp.items) it.geom.dispose(); // 已并入 merged 的克隆体，安全释放
    }
    for (const mesh of consumed) { if (mesh.parent) mesh.parent.remove(mesh); }

    // eslint-disable-next-line no-console
    console.info(
      `[MapScene] 网格合并：候选同材质组已折叠，新增 ${mergedCount} 个合并网格，` +
        `移除原网格 ${consumed.length} 个；场景 draw call 显著下降（仅同材质重复网格被合并）`,
    );
  }

  /**
   * 按 modelNodeFilter 配置隐藏/保留模型节点。
   * 子串匹配节点名（不区分大小写）；命中后对该节点整棵子树设置 visible=false。
   */
  private applyNodeFilter(): void {
    const filter = this.config.modelNodeFilter;
    if (!filter || !this.modelRoot) return;
    const mode = filter.mode === 'include' ? 'include' : 'exclude';
    const pats = (filter.patterns || []).map((p) => p.toLowerCase());
    if (pats.length === 0) return;

    const matches = (name: string): boolean => {
      const n = (name || '').toLowerCase();
      return pats.some((p) => p !== '' && n.includes(p));
    };

    this.modelRoot.traverse((child) => {
      const hit = matches((child as THREE.Object3D).name);
      if (mode === 'exclude') {
        if (hit) child.visible = false;
      } else {
        // include 模式：只保留命中节点（及其子树）。若节点本身未命中但存在命中的祖先，仍保留。
        let ancestorHit = false;
        let p = child.parent;
        while (p) {
          if (matches(p.name)) {
            ancestorHit = true;
            break;
          }
          p = p.parent;
        }
        if (!hit && !ancestorHit) child.visible = false;
      }
    });
  }

  /**
   * 计算模型「可见部分」的世界包围盒。
   * 与 Box3.setFromObject 的区别：跳过自身或任一祖先 visible=false 的网格 —— 节点过滤
   * 隐藏的辅助几何（大门/廊架/相机靶等，可能被挪到离场景几百上千米外）不应参与包围盒，
   * 否则会把居中/阴影/取景的参考中心整体带偏。
   */
  private visibleModelBox(): THREE.Box3 | null {
    if (!this.modelRoot) return null;
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    let has = false;
    const walk = (o: THREE.Object3D, ancestorVisible: boolean): void => {
      const selfVisible = ancestorVisible && o.visible;
      if (selfVisible) {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry) {
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          const bb = mesh.geometry.boundingBox!;
          for (const X of [bb.min.x, bb.max.x]) {
            for (const Y of [bb.min.y, bb.max.y]) {
              for (const Z of [bb.min.z, bb.max.z]) {
                v.set(X, Y, Z).applyMatrix4(mesh.matrixWorld);
                box.expandByPoint(v);
                has = true;
              }
            }
          }
        }
      }
      for (const child of o.children) walk(child, selfVisible);
    };
    walk(this.modelRoot, true);
    return has ? box : null;
  }

  private placeModelAtAnchor(): void {
    if (!this.modelRoot) return;

    // 可选：以模型包围盒中心为原点重新居中。
    // 关键：必须平移「几何本身」(geometry.translate)，不能只改 modelRoot.position——
    // 因为后面 position 会被 anchorWorld 整体覆盖，若只改 position 做居中会被抹掉，
    // 导致几何中心并不在原点：一旦模型在建模软件里不是以原点为中心（CAD/BIM 常以真实坐标为原点），
    // 旋转与定位都会围绕偏离建筑中心的「原点」进行，模型被甩到锚点远处、半进半出视野。
    if (this.config.recenterModel) {
      this.modelRoot.updateMatrixWorld(true);
      // 只统计「可见网格」：nodeFilter 隐藏的杂物（如被挪到 (1000,0,-1000) 的 Entrance_Door_2）
      // 仍是 modelRoot 子树的一员，Box3.setFromObject 不看 visible，会把包围盒中心撑偏 400+ 米。
      const box = this.visibleModelBox();
      if (box && !box.isEmpty()) {
        // 只做「水平居中 + 底面落地」：绝不能把整个包围盒中心搬原点，否则建筑底面被压到地面以下 → 模型「钻到地图底部」。
        // 局部坐标下 Y 为高度方向（modelRotation[90°,0,0] 会把它转到世界 Z 向上），
        // 故仅平移 X/Z 使水平中心对齐原点，并把底面(minY)抬到 y=0，旋转后即立于地面 z=0。
        const cx = (box.min.x + box.max.x) / 2;
        const cz = (box.min.z + box.max.z) / 2;
        const minY = box.min.y;
        const worldDelta = new THREE.Vector3(-cx, -minY, -cz);
        const inv = new THREE.Matrix3();
        this.modelRoot.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh && mesh.geometry) {
            // 关键：烘焙进几何的位移必须先除掉该 mesh 的节点缩放（linear matrixWorld 的逆）。
            // 否则带大缩放的节点（如 Ground_Base 的 780×1×800）会把位移放大数百倍，
            // 地面被甩到几十万米外 —— 表现为「导出模型看不到底图」。
            inv.setFromMatrix4(mesh.matrixWorld).invert();
            const t = worldDelta.clone().applyMatrix3(inv);
            mesh.geometry.translate(t.x, t.y, t.z);
          }
        });
        // 几何已水平居中且底面落地，重置 position 以便后续统一在锚点定位
        this.modelRoot.position.set(0, 0, 0);
        this.modelRoot.updateMatrixWorld(true);
      }
    }

    // 坐标轴旋转（Y-up → Z-up 等）
    const [rx, ry, rz] = this.config.modelRotation;
    this.modelRoot.rotation.set(
      THREE.MathUtils.degToRad(rx),
      THREE.MathUtils.degToRad(ry),
      THREE.MathUtils.degToRad(rz),
    );

    this.modelRoot.position.set(this.anchorWorld.x, this.anchorWorld.y, this.anchorWorld.z);
    this.modelRoot.scale.setScalar(this.config.modelScale);
    this.modelRoot.updateMatrixWorld(true);

    // 应用（叠加）校准微调量
    this.applyCalibration();
    this.freezeModelMatrices();
    // 调试辅助：把实例暴露到 window，便于外部 Playwright 排查场景状态（不影响正常功能）
    if (typeof window !== 'undefined') {
      (window as unknown as { __map: unknown }).__map = this;
      const w2 = window as unknown as { __maps?: unknown[] };
      (w2.__maps = w2.__maps || []).push(this);
    }
  }

  /**
   * 把主方向光的阴影相机对齐到模型实际位置。
   * 模型经 placeModelAtAnchor 放在 anchorWorld（远离世界原点），而 DirectionalLight 的 target 默认在原点，
   * 若不修正，阴影正交视锥会以原点为中心、覆盖不到建筑，导致阴影为错乱的暗斑甚至整片压暗。
   * 这里把光源 target 设到模型包围盒中心并加入场景图，使 ±500 的视锥正确罩住整片校园。
   */
  private fitShadowToModel(): void {
    if (!this.dirLight || !this.modelRoot) return;
    // 同 placeModelAtAnchor：只统计可见网格，避免被隐藏的远处杂物把阴影相机中心带偏
    const box = this.visibleModelBox() ?? new THREE.Box3().setFromObject(this.modelRoot);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    this.dirLight.target.position.copy(center);
    this.scene?.add(this.dirLight.target);
    this.dirLight.target.updateMatrixWorld(true);
    // 视锥已设为 ±500 宽，足以覆盖本场景；更新一次让投影矩阵生效
    this.dirLight.shadow.camera.updateProjectionMatrix();
    if (this.renderer?.shadowMap) this.renderer.shadowMap.needsUpdate = true;
  }

  /**
   * 冻结模型子树的本地矩阵自动更新：GLB 放置完成后变换永不变化（校准只改 modelRoot 自身），
   * 关闭子节点的 matrixAutoUpdate 后，每帧 updateMatrixWorld 只遍历、不再对每个节点做
   * 四元数→矩阵的合成运算——几百个节点的场景上这是每帧一笔可观的纯 CPU 开销。
   * 校准仍可用：modelRoot 自身保持自动更新，applyCalibration 的 updateMatrixWorld(true) 会强制重算。
   */
  private freezeModelMatrices(): void {
    if (!this.modelRoot) return;
    this.modelRoot.traverse((o) => {
      if (o !== this.modelRoot) o.matrixAutoUpdate = false;
    });
    this.modelRoot.updateMatrixWorld(true);
  }

  /**
   * 把当前 calibration 增量叠加到模型变换上（在 config 基础定位之上）。
   * 仅在模型已加载（modelRoot 存在）时生效；可在运行时实时调用以实现「拖滑块即时预览」。
   */
  private applyCalibration(): void {
    if (!this.modelRoot) return;
    const c = this.calibration;

    // 朝向：config.modelRotation[2]（Z 分量 = 绕竖直轴，即正北对齐）叠加微调量
    const [rx, ry, rz] = this.config.modelRotation;
    this.modelRoot.rotation.set(
      THREE.MathUtils.degToRad(rx),
      THREE.MathUtils.degToRad(ry),
      THREE.MathUtils.degToRad(rz + c.rotationZ),
    );

    // 平移：锚点世界坐标叠加 东向/北向/高程 微调（单位均为米，与 config.anchorOffset 同坐标系）
    this.modelRoot.position.set(
      this.anchorWorld.x + c.offsetX,
      this.anchorWorld.y + c.offsetY,
      this.anchorWorld.z + c.elevation,
    );

    // 缩放：config.modelScale × 校准倍率
    this.modelRoot.scale.setScalar(this.config.modelScale * c.scale);
    this.modelRoot.updateMatrixWorld(true);
    this.refreshBuildingBoxes(); // 校准后重建建筑 AABB，保证悬停粗筛与模型位置同步
    this.markDirty();
  }

  /** 重建各建筑的世界 AABB（校准/加载后调用），供悬停拾取做廉价粗筛，避免全模型 raycast */
  private refreshBuildingBoxes(): void {
    if (!this.modelRoot) {
      this.buildingBoxes = [];
      return;
    }
    this.modelRoot.updateMatrixWorld(true);
    const boxes: { obj: THREE.Object3D; box: THREE.Box3 }[] = [];
    for (const name of this.buildingNames) {
      const obj = this.modelRoot.getObjectByName(name);
      if (!obj) continue;
      boxes.push({ obj, box: new THREE.Box3().setFromObject(obj) });
    }
    this.buildingBoxes = boxes;
  }

  // -------------------------------------------------------------------------
  // 常驻楼栋名称标签（无需悬停即显示）
  // -------------------------------------------------------------------------
  private ensureLabelStyle(): void {
    if (this.labelStyleInjected) return;
    if (document.getElementById('bld-labels-style')) {
      this.labelStyleInjected = true;
      return;
    }
    const style = document.createElement('style');
    style.id = 'bld-labels-style';
    // 标签为纯展示 DOM（pointer-events:none），坐标由 render() 每帧用相机投影写入。
    style.textContent =
      '.bld-label{position:absolute;transform:translate(-50%,-100%);pointer-events:none;' +
      'font-size:12px;line-height:1;padding:3px 7px;border-radius:6px;white-space:nowrap;' +
      'background:rgba(17,24,39,.78);color:#fff;border:1px solid rgba(255,255,255,.15);' +
      'box-shadow:0 1px 4px rgba(0,0,0,.35);user-select:none;will-change:transform;' +
      'transition:opacity .12s ease;z-index:5;font-family:inherit}' +
      '.bld-label::after{content:"";position:absolute;left:50%;top:100%;transform:translateX(-50%);' +
      'border:5px solid transparent;border-top-color:rgba(17,24,39,.78)}' +
      '.bld-label--active{background:rgba(37,99,235,.92);border-color:#fff;font-weight:600}' +
      '.bld-label--hidden{display:none}';
    document.head.appendChild(style);
    this.labelStyleInjected = true;
  }

  private createLabelLayer(): void {
    if (this.labelLayer) return;
    const layer = document.createElement('div');
    layer.className = 'bld-label-layer';
    layer.style.position = 'absolute';
    layer.style.inset = '0';
    layer.style.overflow = 'hidden';
    layer.style.pointerEvents = 'none';
    layer.style.zIndex = '4';
    this.container.appendChild(layer);
    this.labelLayer = layer;
  }

  /** 为每个建筑节点创建一枚常驻标签，并缓存其世界锚点（楼栋顶端中心） */
  private buildBuildingLabels(): void {
    if (!this.modelRoot) return;
    this.ensureLabelStyle();
    this.createLabelLayer();
    for (const l of this.buildingLabels) l.el.remove();
    this.buildingLabels = [];
    this.modelRoot.updateMatrixWorld(true);
    const aliases = this.config.buildingNameAliases || {};
    // 调试开关：URL 带 ?nodeids=1 时标签显示 GLB 原始节点号，用于核对「目视楼栋 ↔ 节点编号」映射
    const debugNodeIds = typeof location !== 'undefined' &&
      new URLSearchParams(location.search).has('nodeids');
    for (const node of this.buildingNames) {
      const obj = this.modelRoot.getObjectByName(node);
      if (!obj) continue;
      const el = document.createElement('div');
      el.className = 'bld-label';
      const display = debugNodeIds ? `节点${node}` : (aliases[node] ?? node);
      el.textContent = display;
      el.dataset.node = node;
      this.labelLayer!.appendChild(el);
      this.buildingLabels.push({ node, display, obj, anchor: new THREE.Vector3(), el });
    }
    this.rebuildLabelAnchors();
    this.labelsDirty = true;
    this.updateBuildingLabels();
  }

  /**
   * 重算每枚标签的世界锚点（模型放置 / 校准位移后需重算）。
   *
   * 做法：对每栋楼（节点对象 entry.obj）遍历其整棵子树，找出「世界包围盒体积最大」
   * 的那个 mesh 作为该楼的主楼体，把标签钉在该 mesh 的水平中心 + 楼顶高度。
   *
   * 为什么取最大 mesh 而不是整棵子树包围盒：
   * 个别楼栋节点在 Blender 里混入了极小（甚至被误放的）子网格——例如某个小方块装饰。
   * 若用 setFromObject(整棵子树) 求包围盒，会把远处真楼和这个偶发小方块一起框进去，
   * 中心落到两者之间的空地，标签就「飘」到楼外了。取体积最大的主楼体可免疫这种干扰，
   * 标签永远钉在真正的楼身上。这也顺带解决了「教学楼(2) 的标签被误建小方块带偏」的问题。
   * 仍可用 config.buildingLabelOffsets[node] = [dx, dy] 做最终微调。
   */
  private rebuildLabelAnchors(): void {
    if (!this.modelRoot) return;
    this.modelRoot.updateMatrixWorld(true);
    for (const entry of this.buildingLabels) {
      // 选子树下「世界包围盒体积最大」的 mesh 作为主楼体（忽略偶尔混入的极小/误放子网格）
      let best: THREE.Box3 | null = null;
      let bestVol = -1;
      entry.obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const b = new THREE.Box3().setFromObject(mesh);
        if (b.isEmpty()) return;
        const s = b.getSize(new THREE.Vector3());
        const v = s.x * s.y * s.z;
        if (v > bestVol) {
          bestVol = v;
          best = b;
        }
      });
      const anchor = new THREE.Vector3();
      if (!best) {
        entry.obj.getWorldPosition(anchor);
      } else {
        const b = best as THREE.Box3;
        const c = b.getCenter(new THREE.Vector3());
        anchor.set(c.x, c.y, b.max.z); // 钉在楼顶高度
      }
      const off = this.config.buildingLabelOffsets?.[entry.node];
      if (off) {
        anchor.x += off[0] ?? 0;
        anchor.y += off[1] ?? 0;
      }
      entry.anchor.copy(anchor);
    }
  }

  /** 每帧（或视角/选中变化时）把标签投影到屏幕并定位；密集时做简单纵向去重叠 */
  private updateBuildingLabels(): void {
    if (!this.labelLayer || this.buildingLabels.length === 0 || !this.camera) return;
    if (!this.labelsDirty && this.lastViewSig === this.lastLabelSig) return;
    // 拖动时视角每帧都变，但常驻标签 30fps 足够跟上，不必每帧写几十次 DOM。
    // 内容变化（选中/校准）走 labelsDirty，仍然立即重排，不做节流。
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (!this.labelsDirty && this.lastViewSig !== this.lastLabelSig &&
        now - this.lastLabelAt < 32) return;
    this.lastLabelAt = now;
    this.lastLabelSig = this.lastViewSig;
    this.labelsDirty = false;

    // ⚠️ 容器尺寸只读一次。此前循环里每枚标签都调 projectToScreen()，其内部要读
    // clientWidth/clientHeight；循环中又穿插 classList/style 写入，构成典型的
    // 「读-写交替 layout thrash」——拖动时每帧强制浏览器重排几十次，是卡顿的一大来源。
    const W = this.container.clientWidth || 1;
    const H = this.container.clientHeight || 1;
    const margin = 24;
    const v = new THREE.Vector3();
    const placements: Array<{ entry: BuildingLabel; x: number; y: number }> = [];
    for (const entry of this.buildingLabels) {
      v.copy(entry.anchor).project(this.camera);
      if (v.z > 1 || v.z < -1) {
        entry.el.classList.add('bld-label--hidden');
        continue;
      }
      const x = (v.x * 0.5 + 0.5) * W;
      const y = (-v.y * 0.5 + 0.5) * H;
      if (x < -margin || x > W + margin || y < -margin || y > H + margin) {
        entry.el.classList.add('bld-label--hidden');
        continue;
      }
      placements.push({ entry, x, y });
    }

    // 由下往上放置（y 大者优先），与已放置标签过近则隐藏（选中楼栋始终保留）
    placements.sort((a, b) => b.y - a.y);
    const shown: Array<{ x: number; y: number }> = [];
    const MIN_DX = 80;
    const MIN_DY = 18;
    for (const p of placements) {
      const active = p.entry.node === this.selectedBuildingName;
      let hidden = false;
      if (!active) {
        for (const s of shown) {
          if (Math.abs(s.x - p.x) < MIN_DX && Math.abs(s.y - p.y) < MIN_DY) {
            hidden = true;
            break;
          }
        }
      }
      if (hidden) {
        p.entry.el.classList.add('bld-label--hidden');
        continue;
      }
      shown.push({ x: p.x, y: p.y });
      p.entry.el.classList.remove('bld-label--hidden');
      p.entry.el.classList.toggle('bld-label--active', active);
      // 像素级取整 + 变化才写：避免每帧对同一位置重复写 DOM 触发样式重算
      const left = `${Math.round(p.x)}px`;
      const top = `${Math.round(p.y)}px`;
      if (p.entry.el.style.left !== left) p.entry.el.style.left = left;
      if (p.entry.el.style.top !== top) p.entry.el.style.top = top;
    }
  }

  /** 设置当前选中楼栋（高亮其常驻标签）。node 为空字符串表示取消选中。 */
  setSelectedBuilding(node: string): void {
    if (this.selectedBuildingName === node) return;
    this.selectedBuildingName = node || '';
    this.labelsDirty = true; // 触发一次重排以切换 active 样式（即使视角静止）
  }

  private destroyLabels(): void {
    for (const l of this.buildingLabels) l.el.remove();
    this.buildingLabels = [];
    if (this.labelLayer) {
      this.labelLayer.remove();
      this.labelLayer = null;
    }
  }

  /** 设置/微调校准参数（增量叠加到基准，传入部分字段即可） */
  setCalibration(partial: Partial<ModelCalibration>): void {
    this.calibration = { ...this.calibration, ...partial };
    this.applyCalibration();
    // 模型位移/旋转/缩放后，标签的世界锚点需重算，否则标签仍钉在旧位置
    if (this.buildingLabels.length) this.rebuildLabelAnchors();
    this.labelsDirty = true;
    // 模型位移/旋转/缩放后，缓存的阴影图需重算一次（autoUpdate=false 时靠 needsUpdate 触发；
    // 仅阴影开启时生效，低配已关闭阴影则无操作）。
    // 用防抖取代「每次调用都重算」：拖拽滑块/模型时 setCalibration 每帧触发，若每帧都重绘阴影图
    // 会让整场景每帧双倍绘制，CPU 飙到 50%+。改为停手 120ms 后才算一次，拖拽期间复用旧阴影。
    this.scheduleShadowUpdate();
  }

  /** 阴影图重算防抖：连续校准期间不每帧重绘阴影（否则拖模型 CPU 50%+），停手后算一次即可 */
  private scheduleShadowUpdate(): void {
    if (!this.renderer?.shadowMap?.enabled) return;
    if (this.shadowUpdateTimer !== null) clearTimeout(this.shadowUpdateTimer);
    this.shadowUpdateTimer = window.setTimeout(() => {
      this.shadowUpdateTimer = null;
      if (this.renderer?.shadowMap) this.renderer.shadowMap.needsUpdate = true;
    }, 120);
  }

  /** 读取当前生效的校准参数 */
  getCalibration(): ModelCalibration {
    return { ...this.calibration };
  }

  /** 重置校准为默认值（与 config 一致） */
  resetCalibration(): void {
    this.calibration = { ...DEFAULT_CALIBRATION };
    this.applyCalibration();
  }

  /** 把当前校准量烘焙进 config 对应的「绝对定位字段」，返回可直接粘贴进 mapConfig 的片段文本 */
  exportCalibrationSnippet(): string {
    const c = this.calibration;
    const [rx, ry, rz] = this.config.modelRotation;
    const anchorOffset: [number, number] = [
      +(this.config.anchorOffset[0] + c.offsetX).toFixed(3),
      +(this.config.anchorOffset[1] + c.offsetY).toFixed(3),
    ];
    const modelRotation: [number, number, number] = [
      rx,
      ry,
      +(rz + c.rotationZ).toFixed(3),
    ];
    const modelElevation = +(this.config.modelElevation + c.elevation).toFixed(3);
    const modelScale = +(this.config.modelScale * c.scale).toFixed(4);
    return [
      `anchorOffset: [${anchorOffset[0]}, ${anchorOffset[1]}],`,
      `modelRotation: [${modelRotation[0]}, ${modelRotation[1]}, ${modelRotation[2]}],`,
      `modelElevation: ${modelElevation},`,
      `modelScale: ${modelScale},`,
    ].join('\n');
  }

  /** 从 localStorage 读取已保存的校准（按模型文件区分） */
  loadSavedCalibration(): void {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(this.calibrationKey) : null;
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<ModelCalibration>;
      this.calibration = { ...DEFAULT_CALIBRATION, ...saved };
    } catch {
      /* 解析失败则忽略，使用默认 */
    }
  }

  /** 将当前校准写入 localStorage（刷新后保持） */
  saveCalibration(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(this.calibrationKey, JSON.stringify(this.calibration));
      }
    } catch {
      /* 存储不可用时静默失败 */
    }
  }

  // -------------------------------------------------------------------------
  // 交互：拾取 / 高亮
  // -------------------------------------------------------------------------
  /**
   * 悬停拾取统一入口（入参为浏览器视口像素）。
   * 由原生 pointermove 捕获阶段直接驱动，不经过高德事件代理，也不依赖 GLCustomLayer 的按需渲染回调。
   * 三级降载：位置去重（<1px 跳过）→ rAF 合帧（每帧至多一次 raycast）→ 结果去重（同楼栋内移动零后续开销）。
   */
  private queueHover(clientX: number, clientY: number): void {
    if (this.measureMode !== 'none') {
      // 测量期间只需清除一次悬停高亮，避免高频触发 Vue 更新与 clearHighlight。
      if (!this.measureHoverCleared) {
        this.measureHoverCleared = true;
        this.lastHoverPos = null;
        this.lastHoverKey = null;
        this.callbacks.onHover?.(null);
      }
      return;
    }
    this.measureHoverCleared = false;
    const canvas = this.renderer?.domElement as HTMLCanvasElement | undefined;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    if (!isFinite(x) || !isFinite(y)) return;
    // 位移 < 1px 视为同位置，跳过重复拾取（避免原地抖动反复 raycast）
    if (this.lastHoverPos && Math.abs(this.lastHoverPos.x - x) < 1 && Math.abs(this.lastHoverPos.y - y) < 1) {
      return;
    }
    this.hoverLatest = { x, y };
    if (this.hoverRafScheduled) return;
    this.hoverRafScheduled = true;
    this.hoverRafId = requestAnimationFrame(() => {
      this.hoverRafScheduled = false;
      this.hoverRafId = null;
      if (this.disposed) return;
      const p = this.hoverLatest;
      if (!p) return;
      const result = this.pick(p.x, p.y);
      this.lastHoverPos = { x: p.x, y: p.y };
      // 结果去重：鼠标仍在同一栋楼（或同一片空地）上时，不再上抛 Vue 更新、
      // 不再 clearHighlight/highlight 重建材质、不再唤醒整张高德底图重绘。
      // 这是「扫楼时 CPU 飙升」与「弱机高亮滞后」的关键削减点。
      const key = result
        ? (result.isRoom ? `R:${result.room?.roomNo ?? result.name}` : `B:${result.name}`)
        : 'N';
      if (key === this.lastHoverKey) return;
      this.lastHoverKey = key;
      this.callbacks.onHover?.(result);
    });
  }

  private handleClick(e: any): void {
    if (this.measureMode !== 'none') return; // 测量时由测量点击处理，不触发拾取
    const { x, y } = this.pixelOf(e);
    this.callbacks.onSelect?.(this.pick(x, y));
  }

  private handleDoubleClick(e: any): void {
    if (this.measureMode !== 'none') return; // 测量结束由测量 dblclick 处理
    const { x, y } = this.pixelOf(e);
    this.callbacks.onDoubleClick?.(this.pick(x, y));
  }

  private pixelOf(e: any): { x: number; y: number } {
    // 优先用原生事件相对「渲染画布」的像素：与 renderCachedFrame 中实际渲染视口严格同源，
    // 可避免 AMap e.pixel 与画布参考系存在偏差时导致的拾取错位（悬停命中位置偏移）。
    const native = e?.originEvent as MouseEvent | undefined;
    const canvas = this.renderer?.domElement as HTMLCanvasElement | undefined;
    if (native && canvas && typeof native.clientX === 'number') {
      const r = canvas.getBoundingClientRect();
      const x = native.clientX - r.left;
      const y = native.clientY - r.top;
      if (isFinite(x) && isFinite(y)) return { x, y };
    }
    const p = e?.pixel;
    const x = p?.x ?? p?.getX?.() ?? 0;
    const y = p?.y ?? p?.getY?.() ?? 0;
    return { x, y };
  }

  /** 根据容器内像素坐标拾取模型中的对象（含房间格子） */
  pick(px: number, py: number): PickResult | null {
    if (!this.camera) return null;
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    const ndc = new THREE.Vector2((px / width) * 2 - 1, -(py / height) * 2 + 1);

    this.raycaster.setFromCamera(ndc, this.camera);

    // 候选收窄（性能优化）：先用廉价 AABB 测试，只对「射线可能穿过」的建筑做精确求交，
    // 悬停命中建筑时仅对该建筑子树求交（mesh 数大幅减少），这是把悬停 CPU 降下来的关键。
    // 但若粗筛未命中任何建筑，则回退到「整模型求交」——因为某些建筑节点可能为不含 mesh 的
    // 空 Group（其 AABB 退化），或 AABB 随校准/取景存在偏差，直接据此拒绝会漏选、导致高亮失效。
    // 回退整模型虽略增开销，但 mousemove 已节流到每帧最多一次，实际负载可控，且保证高亮 100% 正确。
    const candidates: THREE.Object3D[] = [];
    for (const { obj, box } of this.buildingBoxes) {
      if (this.raycaster.ray.intersectsBox(box)) candidates.push(obj);
    }

    const targets: THREE.Object3D[] = [];
    if (candidates.length > 0) {
      for (const c of candidates) targets.push(c); // fast path：仅命中建筑子树
    } else if (this.modelRoot) {
      targets.push(this.modelRoot); // 粗筛未命中：回退整模型，避免漏选导致高亮失效
    }
    if (this.roomGroup) targets.push(this.roomGroup);
    if (targets.length === 0) return null;

    const intersects = this.raycaster.intersectObjects(targets, true);
    if (intersects.length === 0) return null;

    for (const hit of intersects) {
      const mesh = hit.object as THREE.Mesh;
      const screenX = px;
      const screenY = py;

      // 命中了房间格子
      if (mesh.userData.isRoom) {
        const room = mesh.userData.room as Room;
        return {
          object: mesh,
          target: mesh,
          name: room.roomNo,
          point: hit.point.clone(),
          lngLat: this.worldToWgs84(hit.point),
          screenX,
          screenY,
          isRoom: true,
          room,
        };
      }

      // 1) 直接命中的是「建筑节点（或其后代）」→ 返回该建筑的数字节点名
      const bObj = this.owningBuildingOf(mesh);
      if (bObj) {
        return this.makeBuildingPick(bObj, hit, px, py);
      }

      // 2) 命中的是非建筑网格（道路 / 水系 / 杂项数字节点 / 装饰等）：
      //    它们不属于任何建筑节点，按需求「不可点击、不可选中、也不显示节点信息」。
      // 直接 return null（最顶层命中优先），避免「点道路却选中建筑 / 道路处显示建筑编号」的问题。
      // （装饰网格已通过 modelNodeFilter 隐藏，本分支主要拦截仍可见的道路/杂项节点。）
      return null;
    }

    return null;
  }

  /** 构造「命中建筑」的拾取结果：名称用建筑的数字节点名（如 15），高亮对象锁定整栋楼 */
  private makeBuildingPick(
    bObj: THREE.Object3D,
    hit: THREE.Intersection,
    px: number,
    py: number,
  ): PickResult {
    return {
      object: bObj,
      target: bObj,
      name: bObj.name, // 显示「数字节点」，而非装饰网格名
      point: hit.point.clone(),
      lngLat: this.worldToWgs84(hit.point),
      screenX: px,
      screenY: py,
      isRoom: false,
    };
  }

  /** 从命中的 mesh 向上（含自身）查找是否属于某栋「建筑节点」 */
  private owningBuildingOf(obj: THREE.Object3D): THREE.Object3D | null {
    let cur: THREE.Object3D | null = obj;
    while (cur && cur !== this.modelRoot) {
      if (cur.name && this.buildingNames.has(cur.name)) return cur;
      cur = cur.parent;
    }
    return null;
  }

  /**
   * 高亮对象（整棵子树）。
   * 采用「克隆原材质 + 叠加 emissive 发光」策略（而非替换为单一纯色材质）：
   *  - 保留原材质的 side / 透明度 / 贴图，避免开口外壳在 FrontSide 下漏出内部导致「空心」；
   *  - 保留建筑原有外观细节，仅叠加高亮色发光，选中/悬停反馈清晰且不空洞。
   */
  highlight(obj: THREE.Object3D | null, color: string): void {
    // 幂等：已是同一对象则跳过克隆/还原，避免每次 mousemove 都重复重建材质（高亮 churn 是悬停 CPU 的次要来源）。
    if (obj && obj === this.highlightedObject) return;
    this.clearHighlight();
    if (!obj) return;
    const tint = new THREE.Color(color);
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (!mesh.userData.__origMaterial) mesh.userData.__origMaterial = mesh.material;
      const orig = mesh.userData.__origMaterial;
      const origArr = Array.isArray(orig) ? orig : [orig];
      // 材质克隆缓存：同一（原材质, 高亮色）组合只克隆一次，跨悬停/跨楼栋复用。
      // 低配机器上 mousemove 扫过楼群时每栋楼都要克隆整套材质，缓存后复用零克隆开销。
      const cloned = origArr.map((m) => {
        const cacheKey = `${color}|${(m as THREE.Material).uuid}`;
        let c = this.highlightMatCache.get(cacheKey);
        if (!c) {
          c = (m as THREE.Material).clone();
          const anyMat = c as unknown as { emissive?: THREE.Color; emissiveIntensity?: number };
          if (anyMat.emissive) {
            anyMat.emissive.copy(tint);
            anyMat.emissiveIntensity = Math.max(anyMat.emissiveIntensity ?? 0, 0.6);
          }
          this.highlightMatCache.set(cacheKey, c);
        }
        return c;
      });
      mesh.material = Array.isArray(orig) ? cloned : cloned[0];
    });
    this.highlightedObject = obj;
    this.markDirty();
  }

  /** 清除高亮：还原原材质（缓存的高亮材质保留复用，不 dispose，随 destroy 统一释放） */
  clearHighlight(): void {
    if (!this.highlightedObject) return;
    this.highlightedObject.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh && mesh.userData.__origMaterial) {
        mesh.material = mesh.userData.__origMaterial;
        mesh.userData.__origMaterial = undefined;
      }
    });
    this.highlightedObject = null;
    this.markDirty();
  }

  // -------------------------------------------------------------------------
  // 楼盘表：房间可视化
  // -------------------------------------------------------------------------

  /**
   * 在指定建筑上方生成「楼盘表」房间格子，按楼层分组，用状态色表示房间状态。
   * 网格悬浮在建筑屋顶上方，楼层切换时只显示当前楼层。
   */
  showRooms(building: THREE.Object3D, rooms: Room[]): void {
    this.clearRooms();
    if (!this.scene || rooms.length === 0) return;

    const box = new THREE.Box3().setFromObject(building);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const footprintW = Math.max(size.x, 1);
    const footprintD = Math.max(size.y, 1);

    // 按楼层分组
    const byFloor = new Map<number, Room[]>();
    for (const r of rooms) {
      const f = r.floor ?? 1;
      if (!byFloor.has(f)) byFloor.set(f, []);
      byFloor.get(f)!.push(r);
    }
    this.roomFloors = [...byFloor.keys()].sort((a, b) => a - b);
    if (this.roomFloors.length === 0) return;

    this.roomGroup = new THREE.Group();
    const baseZ = box.max.z + this.config.roomGridOffset;
    const minFloor = this.roomFloors[0];

    for (const floor of this.roomFloors) {
      const floorRooms = byFloor.get(floor)!;
      const cols = Math.ceil(Math.sqrt(floorRooms.length));
      const rows = Math.ceil(floorRooms.length / cols);
      const cellW = footprintW / cols;
      const cellD = footprintD / rows;
      const z = baseZ + (floor - minFloor) * 0.5;

      floorRooms.forEach((room, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = center.x - footprintW / 2 + (col + 0.5) * cellW;
        const y = center.y - footprintD / 2 + (row + 0.5) * cellD;

        const color = ROOM_STATUS_CONFIG[room.status]?.deep ?? '#888888';
        const mat = new THREE.MeshStandardMaterial({
          color,
          roughness: 0.5,
          metalness: 0.1,
          emissive: 0x000000,
          emissiveIntensity: 0,
          transparent: false,  // opaque: avoid shimmer on room tiles
          opacity: 1,
        });
        const geo = new THREE.BoxGeometry(
          cellW * this.config.roomCellGap,
          cellD * this.config.roomCellGap,
          this.config.roomCellThickness,
        );
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, y, z);
        mesh.userData.isRoom = true;
        mesh.userData.room = room;
        mesh.userData.floor = floor;
        this.roomGroup!.add(mesh);
        this.roomCellMeshes.set(room.id, mesh);
      });
    }

    this.scene.add(this.roomGroup);
    this.currentRoomFloor = minFloor;
    this.applyRoomFloorVisibility();
    this.markDirty();
  }

  /** 切换到指定楼层（只显示该楼层的房间格子） */
  setRoomFloor(floor: number): void {
    this.currentRoomFloor = floor;
    this.applyRoomFloorVisibility();
  }

  private applyRoomFloorVisibility(): void {
    this.roomCellMeshes.forEach((mesh) => {
      mesh.visible = mesh.userData.floor === this.currentRoomFloor;
    });
  }

  /** 当前楼盘表的楼层列表 */
  getRoomFloors(): number[] {
    return this.roomFloors;
  }

  /** 高亮房间格子（悬停/选中），intensity 0 表示取消 */
  highlightRoom(roomId: string | null, intensity: number): void {
    this.roomCellMeshes.forEach((mesh) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (!mat.emissive) return;
      if (roomId && mesh.userData.room?.id === roomId) {
        mat.emissive.set('#ffffff');
        mat.emissiveIntensity = intensity;
      } else {
        mat.emissiveIntensity = 0;
      }
    });
    this.markDirty();
  }

  /** 分配模式：批量设置选中房间（高亮为青色），其余取消 */
  setSelectedRooms(roomIds: Set<string>): void {
    this.roomCellMeshes.forEach((mesh) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const id = (mesh.userData.room as Room | undefined)?.id;
      if (id && roomIds.has(id)) {
        mat.emissive.set('#22d3ee');
        mat.emissiveIntensity = 0.65;
      } else {
        mat.emissive.set('#000000');
        mat.emissiveIntensity = 0;
      }
    });
  }

  /** 更新房间状态并刷新格子颜色（分配成功后调用） */
  updateRoomStatus(roomId: string, status: Room['status']): void {
    const mesh = this.roomCellMeshes.get(roomId);
    if (!mesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.color.set(ROOM_STATUS_CONFIG[status]?.deep ?? '#888888');
    if (mesh.userData.room) (mesh.userData.room as Room).status = status;
    this.markDirty();
  }

  /** 清除楼盘表可视化 */
  clearRooms(): void {
    if (this.roomGroup) {
      this.roomGroup.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose?.();
          const mat = mesh.material as any;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
          else mat?.dispose?.();
        }
      });
      this.scene?.remove(this.roomGroup);
      this.roomGroup = null;
    }
    this.roomCellMeshes.clear();
    this.roomFloors = [];
    this.hoveredRoomId = null;
    this.markDirty();
  }

  /** 是否处于楼盘表模式 */
  get isRoomMode(): boolean {
    return this.roomGroup !== null;
  }

  // -------------------------------------------------------------------------
  // 室内 3D 模型预留接口 & 室内视角
  // -------------------------------------------------------------------------

  /** 为建筑预留楼层组结构（作为将来 CAD 导入室内模型的挂载点），返回楼层组数组 */
  reserveFloorGroups(building: THREE.Object3D, floorCount: number): THREE.Group[] {
    const groups: THREE.Group[] = [];
    for (let f = 1; f <= floorCount; f++) {
      const name = `__indoor_floor_${f}`;
      let g = building.children.find((c) => c.name === name) as THREE.Group | undefined;
      if (!g) {
        g = new THREE.Group();
        g.name = name;
        g.userData.floor = f;
        building.add(g);
      }
      groups.push(g);
    }
    return groups;
  }

  /** 挂载室内 glTF/GLB 模型到指定建筑的指定楼层（预留挂载点） */
  mountIndoorModel(building: THREE.Object3D, floor: number, url: string): Promise<THREE.Object3D | null> {
    const groups = this.reserveFloorGroups(building, this.config.defaultFloorCount);
    const group = groups[floor - 1];
    if (!group) return Promise.resolve(null);

    return new Promise((resolve) => {
      const loader = new GLTFLoader();
      loader.load(
        url,
        (gltf) => {
          if (this.disposed) {
            resolve(null);
            return;
          }
          // 清空该楼层旧室内模型
          for (const old of [...group.children]) group.remove(old);
          const indoor = gltf.scene;
          indoor.name = `__indoor_floor_${floor}_model`;
          group.add(indoor);
          resolve(indoor);
        },
        undefined,
        () => resolve(null),
      );
    });
  }

  /** 双击建筑进入室内视角（保存当前视角、拉近、半透明化建筑、预留楼层组） */
  private clampPitch = (): void => {
    if (this.suppressPitchEvent || !this.map) return;
    const limit = this.config.maxPitch ?? this.config.pitch;
    const min = this.config.minPitch ?? 0;
    const p = this.map.getPitch();
    if (p > limit + 0.05 || p < min - 0.05) {
      this.suppressPitchEvent = true;
      this.map.setPitch(Math.min(Math.max(p, min), limit));
      Promise.resolve().then(() => { this.suppressPitchEvent = false; });
    }
  };

  private setPitchSafe = (p: number): void => {
    this.suppressPitchEvent = true;
    this.map?.setPitch(p);
    Promise.resolve().then(() => { this.suppressPitchEvent = false; });
  };

  enterIndoorView(building: THREE.Object3D): void {
    if (!this.map) return;
    this.savedCamera = {
      zoom: this.map.getZoom(),
      center: this.map.getCenter() as [number, number],
      pitch: this.map.getPitch(),
      rotation: this.map.getRotation(),
    };

    const wp = new THREE.Vector3();
    building.getWorldPosition(wp);
    const [lng, lat] = this.worldToWgs84(wp);
    const [glng, glat] = wgs84ToGcj02(lng, lat);
    this.map.setZoomAndCenter(this.config.indoorZoom, [glng, glat], false, 500);
    this.setPitchSafe(this.config.indoorPitch);

    this.reserveFloorGroups(building, this.config.defaultFloorCount);
    this.setBuildingTranslucent(building, true);
    this.indoorView = true;
    this.indoorTarget = building;
    this.markDirty(); // 材质半透明化 + 楼层分组需立即上屏（不依赖相机动画触发）
  }

  /** 退出室内视角（恢复原视角、还原建筑材质） */
  exitIndoorView(): void {
    if (this.indoorTarget) this.setBuildingTranslucent(this.indoorTarget, false);
    this.indoorView = false;
    this.indoorTarget = null;
    if (this.savedCamera && this.map) {
      const [glng, glat] = this.savedCamera.center;
      this.map.setZoomAndCenter(this.savedCamera.zoom, [glng, glat], false, 500);
      this.setPitchSafe(this.savedCamera.pitch);
      this.map.setRotation(this.savedCamera.rotation);
      this.savedCamera = null;
    }
    this.markDirty(); // 材质还原需立即上屏
  }

  get isIndoorView(): boolean {
    return this.indoorView;
  }

  /** 当前量算模式（'none' 表示已结束但结果仍保留在地图上） */
  get measuringMode(): 'none' | 'distance' | 'area' {
    return this.measureMode;
  }

  // -------------------------------------------------------------------------
  // 视图切换（2.5D / 三维，切换后保留当前定位与朝向）
  // 2D 已按需求移除：SceneView 工具栏不再有 2D 按钮，这里也不再提供 2D 分支。
  // 2.5D 目前因缺少 2.5D 图/素材，SceneView 只保留「（待开发）」置灰占位按钮并禁用 setView 分支；
  // 此处保留 2.5D 分支实现，恢复时只需按 SceneView 占位条注释把按钮接回并删除 setView() 中的禁用判断。
  // 说明：AMap JSAPI 2.0 没有运行时的 setViewMode（仅构造参数 viewMode 支持），
  // 2.5D / 三维都运行在 3D 模式下，仅俯仰角不同（2.5D=35、三维=config.pitch）。
  // 如需恢复 2D：参数类型加回 '2d'，并加回 setViewMode('2D') / pitch=0 / rotation=0 分支。
  // -------------------------------------------------------------------------
  setMapView(mode: '2.5d' | '3d'): void {
    if (!this.map) return;
    if (this.indoorView) this.exitIndoorView(); // 若在室内，先退出并恢复原视角
    const center = this.map.getCenter();
    const zoom = this.map.getZoom();
    // 兼容兜底：旧版 1.4 才有 setViewMode，2.0 不存在，故先 typeof 判断
    if (typeof this.map.setViewMode === 'function') {
      try { this.map.setViewMode('3D'); } catch { /* ignore */ }
    }
    this.setPitchSafe(mode === '2.5d' ? 35 : this.config.pitch);
    // 若朝向被手动转到 0（正北朝上），切回立体视角时恢复默认朝向
    if (this.initialRotation !== 0 && Math.abs(this.map.getRotation?.() ?? 0) < 0.01) {
      this.map.setRotation(this.initialRotation);
    }
    this.map.setZoomAndCenter(zoom, center, true);
    this.markDirty(); // 视角参数变化需立即上屏
  }

  // -------------------------------------------------------------------------
  // 量算：测距（连续打点）/ 测面（闭合多边形）
  // 关键修复：
  //  1. AMap GLCustomLayer 的 WebGL 画布会盖住地图矢量覆盖物，旧实现用
  //     AMap Polyline/Polygon 绘制，导致量算图形被 3D 模型挡住、点不到模型。
  //     现改为在 Three.js 场景内绘制（measureGroup），始终显示在模型之上。
  //  2. 旧实现用 map.on('click'/'dblclick')，事件易被 GLCustomLayer 吞掉，
  //     且禁用 doubleClickZoom 后 map 的 dblclick 不再可靠触发。现改用容器级
  //     DOM 监听 + map.containerToLngLat 取坐标，点在模型上也照样拾取；
  //     结束有三条等价路径：容器 dblclick / SceneView 引导条的「完成测量」按钮（或 Enter 键）。
  //     SceneView 在测量进行时会常驻一条操作引导条，避免用户不知道「如何结束」。
  // -------------------------------------------------------------------------
  startMeasure(mode: 'distance' | 'area'): void {
    if (!this.map || !this.scene) return;
    this.stopMeasure();
    this.measureMode = mode;
    this.measureReportMode = mode;
    this.measuring = true;
    this.bindMeasureDom();
    // 测量期间禁用双击放大，避免与「双击结束」冲突（DOM dblclick 仍会触发）
    try { this.map.setStatus({ doubleClickZoom: false }); } catch { /* ignore */ }
    this.callbacks.onMeasureActive?.(true);
  }

  /** 主动结束测量（保留结果图形），与双击结束等效 */
  completeMeasure(): void {
    this.finishMeasure();
  }

  stopMeasure(): void {
    this.measuring = false;
    this.unbindMeasureDom();
    this.clearMeasureGraphics();
    this.measurePts = [];
    try { this.map?.setStatus({ doubleClickZoom: true }); } catch { /* ignore */ }
    this.measureMode = 'none';
    this.callbacks.onMeasureUpdate?.(null);
    this.callbacks.onMeasureActive?.(false);
    // 立即重绘一帧，确保清除后的画面（无线段）即时反映，不留残影
    this.requestRender();
  }

  /** 绑定容器级 DOM 事件（穿透 GLCustomLayer，可点在模型上）
   *  用 window + 捕获阶段监听，避免被高德内部 stopPropagation 拦截；
   *  并用 container.contains(target) 过滤掉工具栏等地图外区域的点击。 */
  private bindMeasureDom(): void {
    if (!this.container) return;
    const inMap = (t: EventTarget | null) => t instanceof Node && this.container!.contains(t);
    this.measureDownHandler = (e: PointerEvent) => {
      if (e.button !== 0 || !inMap(e.target)) return; // 仅地图内左键
      this.measureDownPos = { x: e.clientX, y: e.clientY, t: Date.now() };
    };
    this.measureMoveDomHandler = (e: PointerEvent) => {
      // 仅在测量进行中才显示跟随预览线，避免已完成测量在鼠标移动时出现多余预览
      if (!this.measuring || this.measurePts.length === 0 || !inMap(e.target)) return;
      // 拖动地图/模型时完全不更新预览：此时高德自身每帧都在重绘，再叠加
      // 「重建几何 + 强制整场景重绘 + 额外 map.render()」正是 CPU 直线上升的根因。
      if (e.buttons !== 0) return;
      // 未按下时也用 rAF 合并：一个动画帧最多一次几何更新
      this.scheduleMeasurePreview(e.clientX, e.clientY);
    };
    this.measureDblDomHandler = (e: MouseEvent) => {
      if (!inMap(e.target)) return;
      e.preventDefault();
      if (this.measuring) this.finishMeasure(); // 仅测量进行中才结束（空闲 armed 时不触发）
    };
    this.measureClickDomHandler = (e: MouseEvent) => {
      const down = this.measureDownPos;
      this.measureDownPos = null;
      if (!down || !inMap(e.target)) return;
      // 区分「点击打点」与「拖拽平移地图」：移动过大或按住过久视为地图操作
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const held = Date.now() - down.t;
      if (moved > 5 || held > 600) return;
      const ll = this.pixelToGcj(e);
      if (!ll) return;
      if (!this.measuring) {
        // 工具仍选中（armed）但未在测量：视为开始一次新的同类型测量，
        // 无需再次点击工具栏按钮；点「清除」前可一直连续测量
        this.measurePts = [];
        this.measuring = true;
        this.clearMeasureGraphics();
        if (this.measureMode !== 'none') this.measureReportMode = this.measureMode;
        this.callbacks.onMeasureUpdate?.(null); // 清掉上一处测量结果面板
        this.callbacks.onMeasureActive?.(true);
      }
      this.addMeasurePoint(ll);
    };
    const opt = { capture: true } as AddEventListenerOptions;
    window.addEventListener('pointerdown', this.measureDownHandler, opt);
    window.addEventListener('pointermove', this.measureMoveDomHandler, opt);
    window.addEventListener('dblclick', this.measureDblDomHandler, opt);
    window.addEventListener('click', this.measureClickDomHandler, opt);
  }

  /** 合并一帧内的多次 pointermove：只保留最后一个坐标，下一帧增量更新一次预览线 */
  private scheduleMeasurePreview(clientX: number, clientY: number): void {
    this.measurePreviewPt = [clientX, clientY];
    if (this.measurePreviewRaf) return;
    this.measurePreviewRaf = requestAnimationFrame(() => {
      this.measurePreviewRaf = 0;
      const p = this.measurePreviewPt;
      this.measurePreviewPt = null;
      if (!p || !this.measuring || this.disposed) return;
      const ll = this.pixelToGcj({ clientX: p[0], clientY: p[1] });
      if (ll) this.updateMeasurePreview(ll);
    });
  }

  /** 取消尚未执行的预览帧（停止/重新测量时避免多余重绘） */
  private cancelMeasurePreview(): void {
    if (this.measurePreviewRaf) {
      cancelAnimationFrame(this.measurePreviewRaf);
      this.measurePreviewRaf = 0;
    }
    this.measurePreviewPt = null;
  }

  private unbindMeasureDom(): void {
    this.cancelMeasurePreview();
    if (!this.container) return;
    const opt = { capture: true } as AddEventListenerOptions;
    if (this.measureDownHandler) window.removeEventListener('pointerdown', this.measureDownHandler, opt);
    if (this.measureMoveDomHandler) window.removeEventListener('pointermove', this.measureMoveDomHandler, opt);
    if (this.measureDblDomHandler) window.removeEventListener('dblclick', this.measureDblDomHandler, opt);
    if (this.measureClickDomHandler) window.removeEventListener('click', this.measureClickDomHandler, opt);
    this.measureDownHandler = null;
    this.measureMoveDomHandler = null;
    this.measureDblDomHandler = null;
    this.measureClickDomHandler = null;
    this.measureDownPos = null;
  }

  /** GCJ-02 经纬度间的测地距离（米），自包含 Haversine，避免依赖 AMap 不存在的 map.getDistance */
  private gcjDistance(a: [number, number], b: [number, number]): number {
    const R = 6378137; // 地球半径（米）
    const rad = Math.PI / 180;
    const lat1 = a[1] * rad;
    const lat2 = b[1] * rad;
    const dLat = (b[1] - a[1]) * rad;
    const dLng = (b[0] - a[0]) * rad;
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /** 屏幕像素（相对容器）→ GCJ-02 经纬度 */
  private pixelToGcj(e: { clientX: number; clientY: number }): [number, number] | null {    if (!this.map || !this.AMap) return null;
    const rect = this.container.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    try {
      const pixel = new this.AMap.Pixel(px, py);
      const converter = this.map.containerToLngLat || this.map.pixelToLngLat;
      const ll = converter.call(this.map, pixel);
      return [ll.getLng(), ll.getLat()];
    } catch {
      return null;
    }
  }

  private addMeasurePoint(pt: [number, number]): void {
    // 忽略与上一点的重复（双击产生的第二次 click）
    const n = this.measurePts.length;
    if (n > 0 && this.gcjDistance(this.measurePts[n - 1], pt) < 0.3) return;
    this.measurePts.push(pt);
    this.renderMeasure();
  }

  private finishMeasure(): void {
    if (!this.measuring) return; // 已结束（如双击的第二次触发），避免重复处理
    const minPts = this.measureReportMode === 'area' ? 3 : 2;
    if (this.measurePts.length < minPts) {
      // 点数不足：取消本次打点，但保留工具（armed），不清除已完成的其它结果
      this.measuring = false;
      this.measurePts = [];
      this.clearMeasureGraphics();
      this.callbacks.onMeasureUpdate?.(null);
      this.callbacks.onMeasureActive?.(false);
      this.requestRender();
      return;
    }
    this.measuring = false;
    // 注意：保留 measureMode（armed 工具），不置 'none'、不解除 DOM 监听、
    // 不恢复双击缩放 —— 这样地图处于该工具的 armed 状态，下次在地图上点击即可
    // 直接开始一次新的同类型测量，无需再次点击工具栏按钮；只有点「清除」才退出。
    if (this.measureReportMode === 'area') {
      this.renderMeasure(); // 闭合多边形（不再追加预览点，measureMode 仍为 'area' 故填充可见）
    }
    this.callbacks.onMeasureActive?.(false);
    this.reportMeasure();
  }

  /** GCJ-02 经纬度 → 地图世界坐标（与模型同一坐标系，地面高度 z 略抬以避免被模型遮挡） */
  private gcjToWorld(pt: [number, number]): THREE.Vector3 {
    const [x, y] = this.customCoords.lngLatToCoord(pt);
    return new THREE.Vector3(x, y, 0.5);
  }

  private clearMeasureGraphics(): void {
    if (!this.measureGroup) return;
    // 圆点共享同一份 geometry/material，用 Set 去重避免重复 dispose
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    for (let i = this.measureGroup.children.length - 1; i >= 0; i--) {
      const obj = this.measureGroup.children[i] as any;
      if (obj.geometry) geos.add(obj.geometry);
      const mat = obj.material;
      if (Array.isArray(mat)) mat.forEach((m: THREE.Material) => mats.add(m));
      else if (mat) mats.add(mat);
      this.measureGroup.remove(obj);
    }
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    this.measureLineObj = null;
    this.measureFillObj = null;
  }

  /** 跟随鼠标的预览：只替换折线/填充的几何，不重建圆点、不重复上报面板、不整组 dispose。
   *  这样 pointermove 每帧的开销从「销毁重建 N 个对象」降到「更新 1~2 个小 buffer」。 */
  private updateMeasurePreview(cursor: [number, number]): void {
    if (!this.measureGroup || !this.customCoords) return;
    if (!this.measureLineObj) { this.renderMeasure(cursor); return; }
    const worldPts = [...this.measurePts, cursor].map((p) => this.gcjToWorld(p));
    const linePts = this.measureMode === 'area' && worldPts.length >= 3
      ? [...worldPts, worldPts[0]]
      : worldPts;
    this.measureLineObj.geometry.dispose();
    this.measureLineObj.geometry = new THREE.BufferGeometry().setFromPoints(linePts);

    if (this.measureFillObj) {
      if (this.measureMode === 'area' && worldPts.length >= 3) {
        const shape = new THREE.Shape();
        shape.moveTo(worldPts[0].x, worldPts[0].y);
        for (let i = 1; i < worldPts.length; i++) shape.lineTo(worldPts[i].x, worldPts[i].y);
        shape.closePath();
        this.measureFillObj.geometry.dispose();
        this.measureFillObj.geometry = new THREE.ShapeGeometry(shape);
        this.measureFillObj.visible = true;
      } else {
        this.measureFillObj.visible = false;
      }
    }
    this.requestRender();
  }

  /** 完整重建量算图形（打点 / 结束 / 清除时调用；图形由 overlay pass 绘制在模型之上） */
  private renderMeasure(cursor?: [number, number]): void {
    if (!this.measureGroup || !this.customCoords) return;
    this.clearMeasureGraphics();
    const pts = cursor ? [...this.measurePts, cursor] : this.measurePts;
    if (pts.length === 0) { this.reportMeasure(); return; }

    const worldPts = pts.map((p) => this.gcjToWorld(p));
    const color = this.measureMode === 'distance' ? 0x38bdf8 : 0xf59e0b;

    // 添加顺序即视觉层级（sortObjects=false，transparent 队列按遍历顺序绘制）：
    // 半透明填充在最下 → 边线 → 顶点圆点在最上。三者统一放 transparent 队列，
    // 避免 three 把 opaque 线/圆点先画、再被后画的填充覆盖。
    // 测面：半透明闭合填充（既能看见面，又不遮死下面的建筑）
    if (this.measureMode === 'area' && worldPts.length >= 3) {
      const shape = new THREE.Shape();
      shape.moveTo(worldPts[0].x, worldPts[0].y);
      for (let i = 1; i < worldPts.length; i++) shape.lineTo(worldPts[i].x, worldPts[i].y);
      shape.closePath();
      const fillGeo = new THREE.ShapeGeometry(shape);
      const fillMat = new THREE.MeshBasicMaterial({
        color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.32, side: THREE.DoubleSide,
      });
      fillMat.toneMapped = false;
      const fill = new THREE.Mesh(fillGeo, fillMat);
      fill.renderOrder = 998;
      this.measureGroup.add(fill);
      this.measureFillObj = fill;
    }

    // 折线 / 多边形边：测面时闭合首尾，使轮廓成为封闭环
    const linePts = this.measureMode === 'area' && worldPts.length >= 3
      ? [...worldPts, worldPts[0]]
      : worldPts;
    const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
    const lineMat = new THREE.LineBasicMaterial({
      color, depthTest: false, depthWrite: false, transparent: true, opacity: 1,
    });
    lineMat.toneMapped = false;
    const line = new THREE.Line(lineGeo, lineMat);
    line.renderOrder = 999;
    this.measureGroup.add(line);
    this.measureLineObj = line;

    // 顶点圆点（略放大，便于在俯视/斜视下辨认）
    const dotGeo = new THREE.SphereGeometry(2.2, 12, 12);
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, depthTest: false, depthWrite: false, transparent: true, opacity: 1,
    });
    dotMat.toneMapped = false;
    for (const wp of worldPts) {
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.copy(wp);
      dot.renderOrder = 1000;
      this.measureGroup.add(dot);
    }

    this.reportMeasure();
    // AMap 2.0 GLCustomLayer 空闲时按需渲染：不打这行，新增的线条不会立即重绘
    this.requestRender();
  }

  /** 强制地图（含 GLCustomLayer）重绘一帧，确保量算图形即时可见。走 scheduleRender 合并，避免重绘风暴 */
  private requestRender(): void {
    this.frameCacheDirty = true; // 低配帧缓存：内容可能已变化，强制重绘一次场景
    this.scheduleRender();
  }

  private reportMeasure(): void {
    const mode = this.measuring ? this.measureMode : this.measureReportMode;
    if (mode === 'distance') {
      const segs: number[] = [];
      let total = 0;
      for (let i = 1; i < this.measurePts.length; i++) {
        const d = this.gcjDistance(this.measurePts[i - 1], this.measurePts[i]);
        segs.push(d);
        total += d;
      }
      this.callbacks.onMeasureUpdate?.({
        mode: 'distance',
        segments: segs,
        value: total,
        points: this.measurePts.length,
      });
      return;
    }
    let value = 0;
    if (this.measurePts.length >= 3) {
      const ring = [...this.measurePts, this.measurePts[0]];
      value = area({ type: 'Polygon', coordinates: [ring] }) as number;
    }
    this.callbacks.onMeasureUpdate?.({
      mode: 'area',
      value,
      points: this.measurePts.length,
    });
  }

  /** 建筑半透明切换（克隆材质，可逆） */
  private setBuildingTranslucent(building: THREE.Object3D, on: boolean): void {
    building.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (on) {
        if (!mesh.userData.__origOpacityMat) {
          mesh.userData.__origOpacityMat = mesh.material;
          const orig = mesh.material;
          const mats = Array.isArray(orig) ? orig : [orig];
          mesh.userData.__translucentMats = mats.map((m) => {
            const c = m.clone();
            c.transparent = false;  // opaque: was indoor see-through, but shimmered with offscreen blit; loses see-inside
            c.opacity = 1;
            c.depthWrite = true;
            return c;
          });
        }
        mesh.material = Array.isArray(mesh.material)
          ? mesh.userData.__translucentMats
          : mesh.userData.__translucentMats[0];
      } else if (mesh.userData.__origOpacityMat) {
        mesh.material = mesh.userData.__origOpacityMat;
        mesh.userData.__origOpacityMat = undefined;
        mesh.userData.__translucentMats = undefined;
      }
    });
  }

  // -------------------------------------------------------------------------
  // 截图与投影（打印/导出用）
  // -------------------------------------------------------------------------

  /** 请求截图：在下一渲染帧读取 framebuffer，返回 PNG dataURL */
  requestSnapshot(): Promise<string> {
    return new Promise((resolve) => {
      this.captureResolve = resolve;
      // 触发一次地图重绘，确保 render() 被调用（若地图处于空闲、未持续渲染）
      try {
        this.map?.resize?.();
      } catch {
        /* ignore */
      }
    });
  }

  private readSnapshot(): void {
    if (!this.captureResolve || !this.renderer) return;
    const resolve = this.captureResolve;
    this.captureResolve = null;

    const gl = this.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const imgData = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const src = (y * w + x) * 4;
        const dst = ((h - 1 - y) * w + x) * 4; // 翻转 Y 轴
        imgData.data[dst] = pixels[src];
        imgData.data[dst + 1] = pixels[src + 1];
        imgData.data[dst + 2] = pixels[src + 2];
        imgData.data[dst + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    resolve(canvas.toDataURL('image/png'));
  }

  /** 世界坐标 → 屏幕坐标（CSS 像素） */
  projectToScreen(worldPos: THREE.Vector3): { x: number; y: number } | null {
    if (!this.camera) return null;
    const v = worldPos.clone().project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    return {
      x: (v.x * 0.5 + 0.5) * (this.container.clientWidth || 1),
      y: (-v.y * 0.5 + 0.5) * (this.container.clientHeight || 1),
    };
  }

  /**
   * 当前量算图形在屏幕上的「结果卡片锚点 + 包围盒」。
   * 上层用它把量算结果显示在测绘范围内（而不是固定右下角），视角变化时重新调用即可跟随图形。
   * - 测面：多边形质心（鞋带公式）；质心落在凹多边形外时回退到包围盒中心
   * - 测距：折线按屏幕弧长的中点
   * 返回 null 表示当前没有可显示的量算图形。
   */
  getMeasureAnchor(): {
    x: number; y: number;
    minX: number; minY: number; maxX: number; maxY: number;
  } | null {
    if (!this.camera || this.measurePts.length === 0) return null;
    const pts: Array<{ x: number; y: number }> = [];
    for (const ll of this.measurePts) {
      const p = this.projectToScreen(this.gcjToWorld(ll));
      if (p) pts.push(p);
    }
    if (pts.length === 0) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    let anchor = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    const mode = this.measuring ? this.measureMode : this.measureReportMode;

    if (mode === 'area' && pts.length >= 3) {
      // 屏幕平面下的多边形质心（投影是仿射变换，质心位置仍然正确）
      let a2 = 0, cx = 0, cy = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        const cross = p.x * q.y - q.x * p.y;
        a2 += cross;
        cx += (p.x + q.x) * cross;
        cy += (p.y + q.y) * cross;
      }
      if (Math.abs(a2) > 1e-6) {
        const c = { x: cx / (3 * a2), y: cy / (3 * a2) };
        // 凹多边形质心可能落在形外：射线法判定，形外则回退包围盒中心
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const pi = pts[i], pj = pts[j];
          if ((pi.y > c.y) !== (pj.y > c.y) &&
              c.x < ((pj.x - pi.x) * (c.y - pi.y)) / (pj.y - pi.y) + pi.x) inside = !inside;
        }
        if (inside) anchor = c;
      }
    } else if (pts.length >= 2) {
      // 折线中点：按屏幕像素弧长插值，避免长段 / 短段把锚点拉偏
      const segs: number[] = [];
      let total = 0;
      for (let i = 1; i < pts.length; i++) {
        const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        segs.push(d);
        total += d;
      }
      let half = total / 2;
      for (let i = 0; i < segs.length; i++) {
        if (half <= segs[i] || i === segs.length - 1) {
          const t = segs[i] > 1e-6 ? Math.min(1, half / segs[i]) : 0;
          anchor = {
            x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
            y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
          };
          break;
        }
        half -= segs[i];
      }
    }
    return { x: anchor.x, y: anchor.y, minX, minY, maxX, maxY };
  }

  /** 某个房间格子的屏幕位置（用于房间详情浮层跟随节点） */
  getRoomScreenPos(roomId: string): { x: number; y: number } | null {
    const mesh = this.roomCellMeshes.get(roomId);
    if (!mesh || !mesh.visible) return null;
    const wp = new THREE.Vector3();
    mesh.getWorldPosition(wp);
    return this.projectToScreen(wp);
  }

  /** 当前楼层各房间的屏幕投影位置（用于打印标注） */
  getCurrentFloorRoomPositions(): Array<{ room: Room; screen: { x: number; y: number } }> {
    const result: Array<{ room: Room; screen: { x: number; y: number } }> = [];
    this.roomCellMeshes.forEach((mesh) => {
      if (!mesh.visible) return;
      const wp = new THREE.Vector3();
      mesh.getWorldPosition(wp);
      const screen = this.projectToScreen(wp);
      if (screen) result.push({ room: mesh.userData.room as Room, screen });
    });
    return result;
  }

  // -------------------------------------------------------------------------
  // 坐标与飞行定位
  // -------------------------------------------------------------------------

  /** 世界坐标（customCoords 空间）→ WGS84 经纬度（反向墨卡托） */
  worldToWgs84(worldPos: THREE.Vector3): [number, number] {
    const dx = worldPos.x - this.anchorWorld.x;
    const dy = worldPos.y - this.anchorWorld.y;
    const latRad = (this.gcjAnchor[1] * Math.PI) / 180;
    const dLng = dx / R_METERS_PER_DEG;
    const dLat = (dy * Math.cos(latRad)) / R_METERS_PER_DEG;
    return gcj02ToWgs84(this.gcjAnchor[0] + dLng, this.gcjAnchor[1] + dLat);
  }

  /** 将 WGS84 经纬度转换为地图世界坐标 */
  wgs84ToWorld(lng: number, lat: number, elevation = 0): THREE.Vector3 {
    const [glng, glat] = wgs84ToGcj02(lng, lat);
    const [x, y] = this.customCoords.lngLatToCoord([glng, glat]);
    return new THREE.Vector3(x, y, elevation);
  }

  /** 飞行到指定 WGS84 经纬度 */
  flyTo(lng: number, lat: number, zoom?: number, onDone?: () => void): void {
    if (!this.map) {
      onDone?.();
      return;
    }
    const [glng, glat] = wgs84ToGcj02(lng, lat);
    // 飞行结束（相机真正落位）后回调一次：用于让上层在正确相机下重算浮层锚点。
    // 用 moveend 精确触发；若目标与当前视角一致导致 moveend 不触发，则用 duration 兜底。
    let called = false;
    const done = () => {
      if (called) return;
      called = true;
      try {
        this.map?.off('moveend', done);
      } catch {
        /* ignore */
      }
      // 落位后强制按当前地图视角刷新 three 相机，确保 onDone 里投影浮层锚点时
      // 用的是「飞行结束后」的真实相机，而非 moveend 早于 GLCustomLayer 渲染回调时仍停留的旧相机。
      this.syncCameraNow();
      onDone?.();
    };
    try {
      this.map.once('moveend', done);
    } catch {
      /* ignore */
    }
    this.map.setZoomAndCenter(zoom ?? this.map.getZoom(), [glng, glat], false, 600);
    window.setTimeout(done, 750);
  }

  /** 飞行到某个模型对象 */
  flyToObject(obj: THREE.Object3D, onDone?: () => void): void {
    const wp = new THREE.Vector3();
    obj.getWorldPosition(wp);
    const [lng, lat] = this.worldToWgs84(wp);
    this.flyTo(lng, lat, this.config.focusZoom, onDone);
  }

  /**
   * 强制按当前地图视角立即刷新 three 相机（绕过视角签名节流），
   * 供飞行落位后的回调里精确投影浮层锚点使用，避免用到过期相机导致锚点错位。
   */
  syncCameraNow(): void {
    if (!this.map || !this.camera || !this.customCoords) return;
    const { near, far, fov, up, lookAt, position } = this.customCoords.getCameraParams();
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.camera.aspect = width / height;
    this.camera.near = near;
    this.camera.far = far;
    this.camera.fov = fov;
    this.camera.position.set(position[0], position[1], position[2]);
    this.camera.up.set(up[0], up[1], up[2]);
    this.camera.lookAt(lookAt[0], lookAt[1], lookAt[2]);
    this.camera.updateProjectionMatrix();
  }

  /**
   * 容器尺寸变化（窗口 resize / 侧栏开合 / 布局变化）后**显式**同步相机宽高比与投影矩阵。
   *
   * 此前 resize 仅靠上方 render() 每帧按 drawingBuffer 兜底重算（见 renderCachedFrame 内
   * appliedVpW/vh 判断）：纯 resize（不伴随地图平移/缩放）时视角签名不变、不会重拉相机参数，
   * camera.aspect 要等 drawingBuffer 变化后的那一帧才修正，存在「窗口变化时模型短暂拉伸/压扁」的间隙。
   * 这里主动同步并唤醒一次重绘，保证 resize 当帧即正确。
   *
   * ⚠️ 不调用 renderer.setSize：本 renderer 渲染进 AMap 的 GL 画布（尺寸由高德管理），视口已在
   * renderCachedFrame 每帧按真实 drawingBuffer 重设，故只需修正相机 aspect 即可。
   */
  onResize(): void {
    if (!this.camera || !this.container) return;
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    const asp = width / height;
    if (Math.abs(this.camera.aspect - asp) > 1e-4) {
      this.camera.aspect = asp;
      this.camera.updateProjectionMatrix();
    }
    this.frameCacheDirty = true; // 标记下一帧重渲（低配 RT 路径会据此重渲进 RT；强机路径本就每帧直绘）
    this.labelsDirty = true;      // 容器尺寸变化会改变投影坐标，标签需重排
    this.scheduleRender();        // 唤醒一次重绘，变更立即上屏（即使地图认为无变化）
  }

  /**
   * 飞行到模型对象的「可见中心」（世界包围盒中心，约在建筑半高处），
   * 让楼栋主体而非其地面原点居中，浮层锚点也据此钉在楼栋可见范围内。
   */
  flyToObjectCenter(obj: THREE.Object3D, onDone?: () => void): void {
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) {
      this.flyToObject(obj, onDone);
      return;
    }
    const center = new THREE.Vector3();
    box.getCenter(center);
    const [lng, lat] = this.worldToWgs84(center);
    this.flyTo(lng, lat, this.config.focusZoom, onDone);
  }

  /** 列出模型中的命名对象（供搜索框使用） */
  listObjects(): Array<{ name: string; lngLat: [number, number]; object: THREE.Object3D }> {
    const result: Array<{ name: string; lngLat: [number, number]; object: THREE.Object3D }> = [];
    if (!this.modelRoot) return result;
    const seen = new Set<string>();
    this.modelRoot.traverse((obj) => {
      // 只暴露「建筑节点」：装饰网格（棚架/女儿墙/廊架…）不进入搜索/定位列表
      if (obj.name && this.buildingNames.has(obj.name) && !seen.has(obj.name)) {
        seen.add(obj.name);
        const wp = new THREE.Vector3();
        obj.getWorldPosition(wp);
        result.push({ name: obj.name, lngLat: this.worldToWgs84(wp), object: obj });
      }
    });
    return result;
  }

  /** 模型数据概览：遍历当前挂载的 GLB，实时统计几何 / 材质 / 贴图与加载指标。
   *  几何口径为「实际可见网格」——祖先被 applyNodeFilter 隐藏的不计入，
   *  与用户真正看到的模型一致；不含任何写死或示例数值。 */
  getModelStats(): ModelStats | null {
    if (!this.modelRoot) return null;
    const matSet = new Set<string>();
    const texSet = new Set<string>();
    let nodes = 0;
    let meshes = 0;
    let vertices = 0;
    let triangles = 0;

    const visibleInHierarchy = (obj: THREE.Object3D): boolean => {
      let cur: THREE.Object3D | null = obj;
      while (cur) {
        if (!cur.visible) return false;
        if (cur === this.modelRoot) break;
        cur = cur.parent;
      }
      return true;
    };

    this.modelRoot.traverse((obj) => {
      nodes++;
      const mesh = obj as THREE.Mesh;
      if (!(mesh as any).isMesh || !visibleInHierarchy(obj)) return;
      meshes++;
      const geo = mesh.geometry as THREE.BufferGeometry;
      if (geo) {
        const pos = geo.getAttribute('position');
        const vCount = pos ? pos.count : 0;
        const idx = geo.getIndex();
        const inst = (mesh as any).isInstancedMesh ? ((mesh as any).count as number) : 1;
        vertices += vCount * inst;
        triangles += Math.floor((idx ? idx.count : vCount) / 3) * inst;
      }
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (!m) continue;
        matSet.add(m.uuid);
        // 材质上的 map / normalMap / roughnessMap … 都可能是贴图；按 uuid 去重
        for (const val of Object.values(m as unknown as Record<string, unknown>)) {
          const t = val as any;
          if (t && t.isTexture) texSet.add(t.uuid as string);
        }
      }
    });

    return {
      buildings: this.listObjects().length,
      nodes,
      meshes,
      vertices,
      triangles,
      materials: matSet.size,
      textures: texSet.size,
      bytes: this.modelBytes,
      parseMs: this.loadStartTs && this.onLoadEntryTs
        ? Math.max(0, Math.round(this.onLoadEntryTs - this.loadStartTs)) : 0,
      loadMs: this.loadStartTs && this.modelReadyTs
        ? Math.max(0, Math.round(this.modelReadyTs - this.loadStartTs)) : 0,
      drawCalls: this.renderer?.info.render.calls ?? 0,
      version: /[?&]v=([^&]+)/.exec(this.config.modelUrl)?.[1] ?? '',
    };
  }

  get model(): THREE.Object3D | null {
    return this.modelRoot;
  }

  get threeScene(): THREE.Scene | null {
    return this.scene;
  }

  /** 容器尺寸（CSS 像素） */
  get containerSize(): { width: number; height: number } {
    return { width: this.container.clientWidth || 1, height: this.container.clientHeight || 1 };
  }

  // -------------------------------------------------------------------------
  // 渲染循环
  // -------------------------------------------------------------------------
  /** 场景内容发生变化（加载模型 / 切换楼层 / 高亮 / 业务状态），唤醒地图重绘以反映变化 */
  /**
   * 合并整帧重绘：把分散在各处的 map.render()（悬停高亮、校准拖拽、量算、房间切换等）
   * 收敛为「每个动画帧至多一次」。高德 GLCustomLayer 的 render() 每次都会重渲整张底图，
   * 若一帧内被多次调用等于把底图重画 N 遍，是鼠标扫楼 / 拖拽时 CPU 飙升与卡顿的主因。
   * 用 rAF 排程后，同一帧内的多次触发只落地一次 map.render()，且落在浏览器绘制前的正确时机，
   * 既不丢高亮、也不会与高德自身的动画渲染循环发生重入式叠加。
   */
  private scheduleRender(): void {
    if (!this.map || typeof this.map.render !== 'function') return;
    if (this.renderScheduled) return; // 本帧已排程，合并后续触发
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      if (this.disposed || !this.map) return;
      try {
        this.map.render();
      } catch {
        /* ignore */
      }
    });
  }

  /**
   * @param wakeMap 是否需要强制高德地图重绘整帧。默认 false —— 绝大多数调用只是
   *   「场景内容变化」（高亮 / 房间 / 楼层 / 材质），靠下方同步直绘即可当帧上屏。
   */
  private markDirty(wakeMap = false): void {
    // 低配 RT 合成路径：内容变化（高亮/选型/房间/校准等）走「RT→blit」同源路径
    // （与空闲帧同一贴图路径），从根上避免「直绘↔贴图」路径切换导致的悬停闪烁；
    // 故置 contentDirty 而非 frameCacheDirty。下一帧 renderCachedFrame 会重渲 RT 再贴图。
    this.contentDirty = true;

    // ⚠️ 高德 GLCustomLayer 是「按需渲染」：地图静止时 AMap 可能整秒都不回调 render()
    //（实测空闲 600ms 内回调 0 次）。仅靠 map.render() 唤醒，会把「高亮材质已改」
    // 推迟到 AMap 下一个渲染周期才可见——这正是悬停高亮感觉「慢 1 秒」的根因，弱机更明显。
    // 因此内容变更后立即同步把模型层重画到当前画布：只 clearDepth、不清颜色（底图保留），
    // 高亮当帧即可见。加 12ms 节流避免同一动画帧内多次 markDirty 重复全场景重绘。
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const canDraw = !!(this.renderer && this.scene && this.camera && !this.paused);
    if (canDraw && now - this.lastImmediateDrawAt > 12) {
      this.lastImmediateDrawAt = now;
      try {
        // ⚠️ 这里绝不能调用 renderer.resetState()：three 的 resetState 会真实改写
        // 共享 WebGL context 的 GL 状态（disable BLEND/DEPTH_TEST、clearColor(0,0,0,0)、
        // blendFunc 等一二十个调用）。它只允许出现在 AMap 的自定义层 render 回调内；
        // 在本处（AMap 帧之外）调用会打乱高德底图渲染器的状态缓存。
        // render() 收尾已经做过一次 resetState，three 的状态缓存与 GL 实际状态一致，
        // 这里直接沿用即可。
        this.renderCachedFrame();
        this.drawMeasureOverlay();
      } catch {
        // GL 画布尚未就绪（加载早期）时忽略，后续正常帧会补上
      }
    } else if (canDraw && !this.immediateDrawScheduled) {
      // ⚠️ 节流的请求绝不能**丢弃**：悬停换楼时 clearHighlight() 与 highlight() 会连着
      // 调两次 markDirty，第二次常被 12ms 节流挡下。以前还有 scheduleRender() 兜底，
      // 现在不再唤醒高德，若不补画「高亮」这一帧就永远不会上屏。
      // 改为合并到下一个 rAF 补一次（同帧多次变更只补一次），保证最终状态一定可见。
      this.immediateDrawScheduled = true;
      requestAnimationFrame(() => {
        this.immediateDrawScheduled = false;
        if (this.disposed || this.paused || !this.renderer || !this.scene || !this.camera) return;
        try {
          this.renderCachedFrame();
          this.drawMeasureOverlay();
        } catch {
          /* GL 尚未就绪，后续正常帧会补上 */
        }
      });
    }

    // ⚠️ 白光闪屏 + 拖动卡顿的根因（s502）：此前每次内容变更（含悬停高亮）都会无条件
    // scheduleRender() → map.render()，强制高德**整帧重绘底图**。按需渲染模式下高德常常
    // 只重画底图、却不回调 GLCustomLayer.render()，于是出现一帧「只有浅色底图、没有模型」；
    // 画布是透明的，下面 .amap-container 的 #f2f2f2 就透出来 → 整个背景白亮闪一下。
    // 拖动地图时这次额外的整帧重绘还会与高德自身的拖动帧叠加，等于每帧多画一遍底图。
    // 内容变更已由上方同步直绘上屏，无需再唤醒高德；只有确实需要重建底图/相机的场景
    // （切回前台、resize、fitRefine、量算）才显式传 wakeMap=true 或自行 scheduleRender()。
    if (wakeMap) this.scheduleRender();
  }

  private render(): void {
    if (!this.renderer || !this.scene || !this.camera || !this.customCoords) return;
    // 页面不可见时彻底停渲染（切走标签页/最小化），回到前台再补一帧，空闲 0 占用
    if (this.paused) return;

    // ⚠️ 不能整帧跳过渲染：AMap 的 GL 自定义图层每帧都会先清掉底图帧缓冲、再回调本函数，
    // 模型必须在本帧重新叠加绘制到该帧缓冲上。若「视角未变」就 return 跳过 renderer.render()，
    // 被跳过的那一帧模型就不会被画出（底图已清），缩放/平移时表现为模型时而显示时而隐藏（闪烁）。
    // 因此每帧都直绘（见 renderCachedFrame）；降载靠相机同步节流 + 锚点防抖，而非跳帧或帧缓存。
    this.renderer.resetState();

    // 视角变化检测（拖拽 / 缩放 / 旋转 / 飞行）→ 更新 lastViewSig 并在变化时通知上层刷新浮层
    this.syncViewChange();

    // 相机同步节流：getCameraParams() 是高德原生调用（弱机上每帧调用有开销）。
    // 仅当视角签名变化（拖拽 / 缩放 / 旋转 / 飞行）时才重新从地图拉取相机参数并重建投影矩阵；
    // 视角静止的帧（含空闲帧）直接复用上一帧已设置好的相机，跳过本次重算。
    // 下方 renderCachedFrame 不管是否重算相机都会逐帧把缓存贴到画布（AMap 每帧都会清底图，必须重贴），
    // 节流只省「相机同步」开销，不影响模型跟手与显示。
    if (this.lastViewSig !== this.lastCamSyncSig) {
      this.lastCamSyncSig = this.lastViewSig;
      const { near, far, fov, up, lookAt, position } = this.customCoords.getCameraParams();
      const width = this.container.clientWidth || 1;
      const height = this.container.clientHeight || 1;

      this.camera.aspect = width / height;
      this.camera.near = near;
      this.camera.far = far;
      this.camera.fov = fov;
      this.camera.position.set(position[0], position[1], position[2]);
      this.camera.up.set(up[0], up[1], up[2]);
      this.camera.lookAt(lookAt[0], lookAt[1], lookAt[2]);
      this.camera.updateProjectionMatrix();
      // 视角变了：缓存帧已过期，本帧需要重新渲染场景
      this.frameCacheDirty = true;
    }

    // 取景迭代微调：此刻相机已与地图真实状态同步，按实测出画倍率逐步收敛到「刚好」
    if (this.fitRefine) {
      try {
        this.refineFitStep();
      } catch {
        this.endFitRefine(); // 微调失败不影响渲染（并恢复模型显示）
      }
    }
    // 取景微调仍在进行 → 主动排程下一帧渲染，驱动微调逐步收敛。
    // 否则在「高德按需渲染」环境下地图不会因视角微调自动重绘，微调循环会断掉，
    // 导致 onFitComplete 永不触发 → 加载遮罩永久卡在「准备渲染」、需开/关 DevTools
    // 触发 resize 才偶然解开（即「开控制台才显示模型」的根因）。
    if (this.fitRefine) this.scheduleRender();

    // 逐帧直绘模型到 AMap 已清好的画布（见 renderCachedFrame）。降载靠相机同步节流 + 锚点防抖，而非帧缓存。
    this.renderCachedFrame();

    // 量算叠加层：主场景（含低配 RT blit）画完后清深度再画，保证线/面永远在模型之上。
    this.drawMeasureOverlay();

    // 截图捕获：在渲染后、buffer 失效前读取
    if (this.captureResolve) this.readSnapshot();

    // 常驻楼栋名称标签：相机已与地图同步，按当前投影定位每枚标签
    this.updateBuildingLabels();

    this.renderer.resetState();
  }

  /** 量算图形叠加：主场景渲染完毕后清深度单独绘制，彻底绕开 sortObjects=false
   *  造成的「renderOrder 失效 + 先画的线被后画的建筑盖住」问题。
   *  坐标仍贴地（z=0.5），不会因抬高产生视差偏移；仅在有量算图形时执行（≤3 个 draw call）。 */
  private drawMeasureOverlay(): void {
    const r = this.renderer;
    if (!r || !this.measureScene || !this.measureGroup || !this.camera) return;
    if (this.measureGroup.children.length === 0) return;
    const vw = this.appliedVpW || this.container.clientWidth || 1;
    const vh = this.appliedVpH || this.container.clientHeight || 1;
    r.setRenderTarget(null);
    r.setViewport(0, 0, vw, vh);
    r.setScissor(0, 0, vw, vh);
    r.setScissorTest(false);
    r.clearDepth();
    r.render(this.measureScene, this.camera);
  }

  /**
   * 每帧渲染入口（低配/软件渲染专用「离屏 RT 合成」分支，彻底压空闲 CPU）：
   * - contentDirty（高亮/选型/房间/校准等内容变化）→ 渲染进离屏 RT 后贴图，与空闲帧同一 blit 路径，
   *   从根上消除「直绘↔贴图」路径切换导致的悬停整模型闪烁。
   * - frameCacheDirty（拖拽/缩放/旋转/飞行等视角变化）→ 直接渲染到屏幕，1 趟保跟手，负载与原版一致；
   *   并标记 rtStale，待静止首帧再悄悄把当前画面刷进 RT。
   * - rtStale（静止首帧）→ 先直接渲染（与活动帧像素一致 → 零跳变），再静默刷新 RT 供后续贴图。
   * - 完全静止帧 → 只把离屏 RT 贴到画布（2 个三角形），CPU 开销塌缩到极低，
   *   从根本上解决弱机「空闲也每帧重绘整场景 → CPU 长期 90%」的问题。
   * 非低配：直绘场景（原稳健路径，保留高质量与跟手性）。
   */
  private renderCachedFrame(): void {
    if (!this.renderer || !this.scene || !this.camera) return;
    const gl = this.renderer.getContext();
    const bufW = gl.drawingBufferWidth || 1;
    const bufH = gl.drawingBufferHeight || 1;
    const pr = this.renderer.getPixelRatio();
    const vw = bufW / pr; // CSS 像素视口宽（three 会再乘 pr 还原成整块 buffer）
    const vh = bufH / pr;

    // ⚠️ 关键修复（悬停偏移 + 模型被底图遮挡）：
    // three 的渲染视口在 initThree 时按「当时容器尺寸 × pixelRatio」定死，但高德画布的真实
    // drawingBuffer 尺寸（尤其 dpr 与 three 的 pixelRatio 不一致、或窗口/布局变化后）可能不同步。
    // 一旦视口 < 整块画布，模型就只被画到画布的一部分 —— 既表现为「模型某部分被底图遮挡」，
    // 又导致射线拾取 NDC（按全容器计算）与渲染视口错位，于是「鼠标悬在模型上无反应、悬在周围/上方却命中」。
    // 故每帧按真实 drawingBuffer 重设视口/裁剪区，确保模型铺满整块画布、拾取与渲染严格对齐。
    if (this.appliedVpW !== vw || this.appliedVpH !== vh) {
      this.appliedVpW = vw;
      this.appliedVpH = vh;
      this.renderer.setViewport(0, 0, vw, vh);
      this.renderer.setScissor(0, 0, vw, vh);
      this.renderer.setScissorTest(false);
      const asp = bufW / bufH;
      if (Math.abs(this.camera.aspect - asp) > 1e-4) {
        this.camera.aspect = asp;
        this.camera.updateProjectionMatrix();
      }
    }
    // ⚠️ 不在这里 resetState()：render() 开头（AMap 自定义层回调内）已统一做一次状态同步，
    // 此处再到一次纯属重复（每帧 20+ 个无谓 GL 状态调用）。更重要的是 markDirty() 的
    // 同步直绘也会走本函数，而它发生在 AMap 帧之外 —— 在那里 resetState 会打乱高德
    // 底图渲染器的 GL 状态缓存，造成底图丢帧 / 背景白闪。状态同步只允许在 AMap 回调内做。

    // ── 低配/软件渲染：离屏 RT 合成（空闲帧只贴图压 CPU；拖拽直绘保跟手；内容变化走同源 blit 防闪烁）──
    if (this.lowEnd && !this.frameCacheBroken) {
      if (!this.ensureFrameCache(bufW, bufH)) {
        // 缓存不可用 → 退化直绘，保证模型始终可见
        this.renderer.setRenderTarget(null);
        this.renderer.clearDepth();
        this.renderer.render(this.scene, this.camera);
        return;
      }
      if (this.contentDirty) {
        // 内容变化（高亮/选型/房间/校准等）：渲染进离屏 RT 后贴图，与空闲帧同一 blit 路径，
        // 从根上避免「直绘↔贴图」两路切换导致的悬停整模型闪一下。
        this.renderToRt(this.frameRt!, bufW, bufH);
        this.contentDirty = false;
        this.rtStale = false; // RT 已含最新内容，后续空闲帧可直接贴图
        // 落到下方 blit 把新 RT 贴到屏幕
      } else if (this.frameCacheDirty) {
        // 视角变化（拖拽/缩放/旋转/飞行）：直接渲染到屏幕，1 趟保跟手，负载与原版一致；
        // 标记 RT 落后，待静止首帧再悄悄刷新，避免重复重渲染场景。
        this.renderer.setRenderTarget(null);
        this.renderer.clearDepth();
        this.renderer.render(this.scene, this.camera);
        this.frameCacheDirty = false;
        this.rtStale = true;
        return;
      } else if (this.rtStale) {
        // 静止首帧：先直接渲染（与活动帧像素一致 → 零跳变），再悄悄把当前画面刷进离屏 RT 供后续贴图
        this.renderer.setRenderTarget(null);
        this.renderer.clearDepth();
        this.renderer.render(this.scene, this.camera);
        this.renderToRt(this.frameRt!, bufW, bufH);
        this.rtStale = false;
        return;
      }
      // 完全静止帧（或内容变化刚刷过 RT）：只把离屏 RT 贴到画布（2 个三角形），
      // 空闲 CPU 塌缩到极低，彻底解决弱机「空闲也每帧重绘整场景 → CPU 长期 90%」的问题。
      this.renderer.setViewport(0, 0, vw, vh);
      this.renderer.setScissor(0, 0, vw, vh);
      this.renderer.setScissorTest(false);
      this.renderer.clearDepth();
      this.renderer.render(this.blitScene!, this.blitCam!);
      return;
    }

    // ── 非低配：直绘场景（原稳健路径）──
    // AMap 每帧会清掉本层颜色+深度缓冲后再回调本函数。
    // 重置到屏幕缓冲并仅清深度（不清颜色，避免擦掉底图）：让模型从干净的深度状态自算遮挡关系，
    // 始终压在底图之上，避免地形/建筑深度误遮挡导致的闪烁类伪影。
    this.renderer.setRenderTarget(null);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
  }

  /** 懒初始化离屏缓存：首次或尺寸变化时构建 RT 与全屏贴图场景；返回是否可用 */
  private ensureFrameCache(bufW: number, bufH: number): boolean {
    if (!this.frameRt || this.frameRtKey !== `${bufW}x${bufH}`) {
      this.rebuildFrameRt(bufW, bufH);
    }
    // 交互期低分辨率 RT 随全分辨率 RT 同步构建/重建
    this.buildLowRt(bufW, bufH);
    if (!this.blitScene) this.buildBlitScene();
    return !!this.frameRt && !!this.blitScene && !this.frameCacheBroken;
  }

  /** 按当前画布尺寸重建离屏渲染目标；低配/软件渲染下关闭多重采样以削减移动帧开销 */
  private rebuildFrameRt(w: number, h: number): void {
    this.frameRt?.dispose();
    const isWebGL2 = !!this.renderer?.capabilities?.isWebGL2;
    // 低配/软件渲染下关 MSAA：RT 仅在视角/内容变化时重渲染，多重采样的多次采样在弱机上反而拖慢移动帧
    const samples = this.lowEnd || this.softwareRender ? 0 : (isWebGL2 ? 4 : 0);
    const opts: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      samples,
    };
    try {
      this.frameRt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), opts);
      this.frameCacheBroken = false;
    } catch {
      // 多重采样 RT 创建失败（极少见）→ 退化为无采样，仍走缓存路径
      try {
        this.frameRt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), { ...opts, samples: 0 });
        this.frameCacheBroken = false;
      } catch {
        this.frameRt = null;
        this.frameCacheBroken = true;
      }
    }
    // RT 尺寸/纹理变化 → 旧缓存失效，下一帧需直绘一帧待静止后再悄悄刷新
    this.frameCacheDirty = true;
    this.rtStale = true;
    // RT 重建后纹理对象已换，贴图材质需指向新纹理（blit 场景已构建时）
    if (this.blitMat && this.frameRt) {
      this.blitMat.map = this.frameRt.texture;
      this.blitMat.needsUpdate = true;
    }
    this.frameRtKey = `${w}x${h}`;
  }

  /** 构建全屏贴图场景（正交相机 + 一个 quad 采样离屏纹理） */
  private buildBlitScene(): void {
    // - texture colorSpace 保持默认（线性）：场景渲染进 RT 时不做 sRGB 编码，
    //   贴图时由 MeshBasicMaterial 的 colorspace_fragment 完成编码，与直绘路径一致；
    // - toneMapped=false：色调映射已在场景渲染进 RT 时应用，贴图时不能再来一次；
    // - transparent=true：用标准 alpha 混合叠加到 AMap 清空后的画布上，底图从下层透出。
    const mat = new THREE.MeshBasicMaterial({
      map: this.frameRt!.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.blitMat = mat;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    this.blitScene = new THREE.Scene();
    this.blitScene.add(quad);
    this.blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.frameCacheDirty = true;
  }

  /** 把场景渲染进指定离屏 RT（按给定尺寸设视口/裁剪，透明清空） */
  private renderToRt(rt: THREE.WebGLRenderTarget, w: number, h: number): void {
    if (!this.renderer || !this.scene || !this.camera) return;
    const r = this.renderer;
    // ⚠️ setClearColor 是 renderer 的**持久全局状态**，而这里的 WebGL context 与高德底图共享。
    // 低配 RT 路径每次内容变化都会把它改成透明黑；若不还原，高德按自己的状态缓存清屏时
    // 可能沿用错误颜色 → 底图整片变成透明，露出 .amap-container 的浅灰白底（背景白闪）。
    // 故先保存、用完立即还原，绝不把临时清屏色留给底图渲染器。
    const prevColor = r.getClearColor(new THREE.Color()).clone();
    const prevAlpha = r.getClearAlpha();
    r.setRenderTarget(rt);
    r.setViewport(0, 0, w, h);
    r.setScissor(0, 0, w, h);
    r.setScissorTest(false);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    r.setClearColor(prevColor, prevAlpha);
  }

  /** 构建交互期降分辨率 RT（拖拽/缩放时降填充率压 CPU）；尺寸随全分辨率 RT 同步 */
  private buildLowRt(w: number, h: number): void {
    if (!this.renderer) return;
    const lw = Math.max(1, Math.round(w * MapScene.INTERACT_SCALE));
    const lh = Math.max(1, Math.round(h * MapScene.INTERACT_SCALE));
    // ⚠️ ensureFrameCache() 每帧都会调用本方法。此前这里无条件 dispose + new WebGLRenderTarget，
    // 等于拖拽/移动时**每帧销毁并重建一张 GPU 纹理 + FBO**（还伴随事件注册与 GC 抖动），
    // 是移动模型持续卡顿的一个实打实的开销源。尺寸没变就直接复用。
    if (this.frameRtLow && this.lowRtW === lw && this.lowRtH === lh) return;
    this.frameRtLow?.dispose();
    const isWebGL2 = !!this.renderer?.capabilities?.isWebGL2;
    const samples = this.lowEnd || this.softwareRender ? 0 : (isWebGL2 ? 4 : 0);
    const opts: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      generateMipmaps: false, depthBuffer: true, stencilBuffer: false, samples,
    };
    try {
      this.frameRtLow = new THREE.WebGLRenderTarget(lw, lh, opts);
    } catch {
      try { this.frameRtLow = new THREE.WebGLRenderTarget(lw, lh, { ...opts, samples: 0 }); }
      catch { this.frameRtLow = null; }
    }
    this.lowRtW = lw;
    this.lowRtH = lh;
  }

  /**
   * 检测地图视角是否变化（中心点 / 缩放 / 旋转 / 俯仰），
   * 变化时通知上层重算锚定浮层的屏幕位置。
   * 放在渲染帧里做「签名比对」，可自然覆盖拖拽、滚轮缩放、旋转、飞行等所有情况，
   * 且视角静止时不会重复触发。
   */
  private syncViewChange(): void {
    if (!this.map) return;
    let sig = '';
    try {
      const c = this.map.getCenter?.();
      sig = [
        c?.lng,
        c?.lat,
        this.map.getZoom?.(),
        this.map.getRotation?.(),
        this.map.getPitch?.(),
      ].join(',');
    } catch {
      return;
    }
    if (sig === this.lastViewSig) return;
    this.lastViewSig = sig;
    // 视角正在变化 → 记录时间戳，供 hoverDomHandler 在拖动/缩放/飞行期间跳过悬停拾取
    this.lastViewChangeAt = typeof performance !== 'undefined' ? performance.now() : 0;
    this.callbacks.onViewChange?.();
  }

  // -------------------------------------------------------------------------
  // 销毁
  // -------------------------------------------------------------------------
  destroy(): void {
    this.disposed = true;
    // 悬停拾取：移除原生监听并取消挂起的 rAF，避免跨实例泄漏
    if (this.hoverDomHandler) {
      this.container.removeEventListener('pointermove', this.hoverDomHandler, { capture: true } as EventListenerOptions);
      this.hoverDomHandler = null;
    }
    if (this.pointerDownHandler) {
      this.container.removeEventListener('pointerdown', this.pointerDownHandler, { capture: true } as EventListenerOptions);
      this.pointerDownHandler = null;
    }
    if (this.pointerUpHandler) {
      window.removeEventListener('pointerup', this.pointerUpHandler, { capture: true } as EventListenerOptions);
      window.removeEventListener('pointercancel', this.pointerUpHandler, { capture: true } as EventListenerOptions);
      this.pointerUpHandler = null;
    }
    this.pointerIsDown = false;
    if (this.hoverRafId !== null) {
      cancelAnimationFrame(this.hoverRafId);
      this.hoverRafId = null;
    }
    // 量算叠加层：取消挂起的预览帧、释放几何/材质（measureScene 不在主 scene 里，不会被统一遍历到）
    this.cancelMeasurePreview();
    this.clearMeasureGraphics();
    this.measureScene = null;
    this.measureGroup = null;
    this.clearRooms();
    // 低配帧缓存 / 贴图场景 / 高亮材质缓存：随渲染器一起释放
    this.frameRt?.dispose();
    this.frameRt = null;
    this.frameRtLow?.dispose();
    this.frameRtLow = null;
    this.lowRtW = 0;
    this.lowRtH = 0;
    this.frameRtKey = '';
    if (this.interactTimer) { clearTimeout(this.interactTimer); this.interactTimer = null; }
    this.interacting = false;
    this.blitScene?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose?.();
        (m.material as THREE.Material)?.dispose?.();
      }
    });
    this.blitScene = null;
    this.blitCam = null;
    this.highlightMatCache.forEach((m) => m.dispose());
    this.highlightMatCache.clear();
    try {
      if (this.glLayer && this.map) this.map.remove(this.glLayer);
    } catch {
      /* ignore */
    }
    this.glLayer = null;

    // 移除常驻标签 DOM，避免跨实例泄漏
    this.destroyLabels();

    // 移除页面可见性监听，避免监听器跨实例泄漏
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }

    if (this.modelRoot) {
      this.modelRoot.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose?.();
          const mat = mesh.material as any;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
          else mat?.dispose?.();
        }
      });
      this.modelRoot = null;
    }

    this.renderer?.dispose();
    this.renderer?.forceContextLoss?.();
    this.renderer = null;
    this.scene = null;
    this.camera = null;

    if (this.map) {
      try {
        this.map.destroy();
      } catch {
        /* ignore */
      }
      this.map = null;
      this.customCoords = null;
    }
  }
}
