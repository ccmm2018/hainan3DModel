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
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { wgs84ToGcj02, gcj02ToWgs84 } from '../utils/coordTransform';
import type { SceneConfig } from '../config/mapConfig';
import { ROOM_STATUS_CONFIG, type Room } from '../data/roomData';
import area from '@turf/area';

/** 首屏性能量算基准：模块脚本执行时刻（≈页面交互起点），用于把各阶段耗时统一到「距页面加载」 */
const SCENE_T0 = performance.now();

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
  private modelPrefetchGltf: any = null;   // 已解析完成的 GLTF（来源：预取缓冲或即时 load）
  private modelPrefetchStarted = false;    // 预取是否已发起（防止重复下载同一模型）
  private modelOnLoadRan = false;          // runModelOnLoad 是否已执行（防止重复后处理/挂载）
  private ready = false;                   // initThree 完成（renderer/scene/customCoords 均就绪）标记
  private prefetchStartTs = 0;             // 模型预取发起时刻，用于日志
  private prefetchedBuffer: ArrayBuffer | null = null; // 提前并行下载的 GLB 二进制（await loadAMap 期间），就绪后直接 parse
  private prefetchedUrl = '';              // 与 prefetchedBuffer 对应的模型地址
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
  /** 地图创建时间戳，用于量算「AMap 初始化 → GL 上下文就绪」耗时，定位首屏 35s 卡顿归属 */
  private mapCreateTs = 0;
  /** 高亮材质缓存（key: `颜色|原材质uuid`），跨悬停复用克隆材质，避免扫过楼群时反复克隆 */
  private highlightMatCache = new Map<string, THREE.Material>();

  // 量算（测距 / 测面）状态
  private AMap: any = null;
  private measureMode: 'none' | 'distance' | 'area' = 'none';
  private measureReportMode: 'distance' | 'area' = 'distance';
  /** 量算顶点（GCJ-02 经纬度） */
  private measurePts: [number, number][] = [];
  /** 量算图形所在的 Three.js 图层（绘制在 3D 模型之上，不会被 WebGL 自定义层盖住） */
  private measureGroup: THREE.Group | null = null;
  /** 是否处于「测量进行中」（已打点、尚未完成） */
  private measuring = false;
  // 容器级 DOM 监听：避免事件被 GLCustomLayer 画布吞掉，且可点在 3D 模型上
  private measureDownHandler: ((e: PointerEvent) => void) | null = null;
  private measureMoveDomHandler: ((e: PointerEvent) => void) | null = null;
  private measureDblDomHandler: ((e: MouseEvent) => void) | null = null;
  private measureClickDomHandler: ((e: MouseEvent) => void) | null = null;
  private measureDownPos: { x: number; y: number; t: number } | null = null;

  /** 视为「建筑（可点击 / 可选中）」的 GLB 节点名白名单（来自 config.buildingNodeNames） */
  private buildingNames = new Set<string>();

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
    this.map = new AMap.Map(this.container, {
      center: this.gcjCenter,
      zoom: this.config.zoom,
      pitch: this.config.pitch,
      viewMode: '3D',
      mapStyle: this.config.mapStyle || 'amap://styles/dark',
      zooms: [3, 20],
      showLabel: this.config.showLabel,
      rotationEnable: true,
    });

    // 底图降噪：去除 POI（point）兴趣点，仅保留背景 / 道路 / 建筑
    try {
      this.map.setFeatures(this.config.mapFeatures);
    } catch {
      /* 个别版本不支持 setFeatures，可忽略 */
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

    // 交互事件（地图点击/移动不会在拖拽时误触发）
    this.map.on('mousemove', (e: any) => this.handleMouseMove(e));
    this.map.on('click', (e: any) => this.handleClick(e));
    this.map.on('dblclick', (e: any) => this.handleDoubleClick(e));
    // 俯仰角锁定：拖动旋转地图时不允许把地图「翻过来」
    this.map.on('camerachange', this.clampPitch);
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
    let lowEnd =
      (navigator.hardwareConcurrency || 4) <= 4 ||
      (((navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8) <= 4);
    try {
      const forced = new URLSearchParams(location.search).get('lowend');
      if (forced === '1') lowEnd = true;
      else if (forced === '0') lowEnd = false;
    } catch { /* ignore */ }
    this.lowEnd = lowEnd;
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
    this.renderer.toneMappingExposure = isWebGL2 ? 1.0 : 1.12;

    // 环境贴图（IBL）：PBR 材质需要环境光照才能呈现正确质感（尤其是金属度/粗糙度与边缘反射）。
    // 缺少 scene.environment 时，很多外立面材质会因为没有环境反射而显得「发灰、发暗、像没贴图」，
    // 这正是「GLB 材质丢失」最常见的原因。这里用 RoomEnvironment 程序化生成一张轻量环境贴图。
    // 低配机器跳过 PMREM 生成（其 fromScene 需在初始化时渲染多遍立方体贴图，是一次性 GPU 峰值），
    // 直接由下方的环境光 + 半球光 + 主/补光提供基础照明，避免加载瞬间 CPU/GPU 被打满。
    if (!this.lowEnd) {
      try {
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        this.scene.environment = envTex;
        pmrem.dispose();
      } catch {
        /* 极少数 WebGL 环境下 PMREM 不可用，退化为基础灯光照明（不影响几何显示） */
      }
    }

    // 量算图层：独立于模型，始终绘制在模型之上
    this.measureGroup = new THREE.Group();
    this.scene.add(this.measureGroup);

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
    // 环境光：保证背光面/底面也有基础照明，避免模型在深色地图底图上糊成一片暗灰
    // （高德 GLCustomLayer 给的是 WebGL1 上下文，PMREM 环境贴图（IBL）往往无法生成，
    //  不能依赖 scene.environment，故以「环境光 + 主光 + 补光」构成稳定的三档照明）。
    const amb = new THREE.AmbientLight('#ffffff', 0.7);
    this.scene.add(amb);

    const hemi = new THREE.HemisphereLight('#ffffff', '#5a6472', 1.1);
    this.scene.add(hemi);

    // 主光（带阴影）
    const dir = new THREE.DirectionalLight('#ffffff', 2.0);
    dir.position.set(-200, 400, 150);
    dir.castShadow = true;
    this.scene.add(dir);

    // 补光：从主光对侧打一盏弱光，照亮背光面，使材质细节（贴图、纹理）清晰可辨
    const fill = new THREE.DirectionalLight('#dfe7f0', 0.9);
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
            }
          }
        });

        this.placeModelAtAnchor();

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
        if (this.lowEnd) {
          // 低配：先缩贴图、再检测黑图。尽早把大位图换成 ≤512 的 canvas，
          // 降低整段后处理的内存峰值（4GB 机器上 450MB+ 峰值会触发交换，表现为整体卡顿）。
          await this.runChunked(textures, '优化贴图', (tex) => {
            if (this.reduceTextureForLowEnd(tex)) textureReduced++;
          });
          if (this.disposed) return;
          await this.runChunked(mapPairs, '检测损坏贴图', (pair) => {
            if (this.fixMatMapIfBlack(pair)) materialFixed++;
          });
          if (this.disposed) return;
        } else {
          // WebGL1（高德 GLCustomLayer 提供）对单张贴图尺寸有 MAX_TEXTURE_SIZE 上限，
          // 超过上限的 JPEG 会上传失败、对应材质回退成白色/灰色平面，表现为「材质丢失」。
          // 这里把所有超尺寸贴图等比缩到上限以内（仅重绘到 canvas，不改原始 GLB 文件）。
          await this.runChunked(textures, '缩放超大贴图', (tex) => {
            if (this.clampTextureToMaxSize(tex)) clampedCount++;
          });
          if (this.disposed) return;
          // WebGL1 下「NPOT 尺寸贴图 + mipmap」会被驱动直接丢弃，导致部分建筑材质渲染失败（黑色/空白），
          // 观感即「材质丢失」。主动降级为「无 mipmap + 线性过滤 + 边缘钳制」使其可正常显示（WebGL2 跳过）。
          await this.runChunked(textures, '适配 WebGL1 贴图', (tex) => {
            if (this.makeTextureWebGL1Safe(tex)) npotFixed++;
          });
          if (this.disposed) return;
          // GLB 文件本身存在「渲染后纯黑」的损坏立面贴图（导出/烘焙失败所致），会让对应楼栋渲染成黑墙，
          // 观感即「材质丢失」。离线逐张解码已实证共 6 张（mean≈0/std≈0），加载后做启发式检测并替换为
          // 程序化立面纹理。此一类修复经用户确认有效（「墙面发黑问题已修复」），不再做其它运行时材质改写，
          // 以免误伤楼栋原本正常的材质/屋顶/地面。
          await this.runChunked(mapPairs, '检测损坏贴图', (pair) => {
            if (this.fixMatMapIfBlack(pair)) materialFixed++;
          });
          if (this.disposed) return;
        }
        // 所有贴图处理完成后再挂入场景：避免在「让出帧」期间 AMap 提前渲染、把全分辨率贴图先上传一遍 GPU
        // （那样低配机器仍会先承受一次 450MB 上传峰值）。挂入后 AMap 第一次渲染拿到的就是已降级的贴图。
        this.scene!.add(this.modelRoot);
        const caps = this.renderer?.capabilities;
        const shadowState = this.renderer?.shadowMap?.enabled ? '单次(静态缓存)' : '关(低配)';
        // eslint-disable-next-line no-console
        console.info(
          `[MapScene] GLB 加载完成：isWebGL2=${caps?.isWebGL2 ?? '?'}，MAX_TEXTURE_SIZE=${caps?.maxTextureSize ?? '?'}，` +
            `低配=${this.lowEnd}，阴影=${shadowState}，`
            + `超限缩放=${clampedCount} 张，NPOT 材质降级=${npotFixed} 张，黑图替换=${materialFixed} 张，低配贴图降级=${textureReduced} 张`,
        );

        this.callbacks.onModelStage?.('准备渲染');
        this.markDirty();
        // 取景前先构建各建筑世界 AABB，供后续悬停拾取做粗筛（避免全模型 raycast）。
        this.refreshBuildingBoxes();
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
        this.callbacks.onModelReady?.();
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
    const bearing = new THREE.Vector3(camPos.x - oldLook.x, camPos.y - oldLook.y, 0);
    if (bearing.lengthSq() < 1e-6) bearing.set(0, -1, 0); // 纯俯视的极端情况下退化为朝北
    bearing.normalize();
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
    //    保持正面斜视观感，两端仍不匹配时取更接近的一端（另一方向留少量空白）。
    const PITCH_MIN = 35;
    const PITCH_MAX = 75;
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
      // 「居中」目标 = 可见区中心（水平仍取屏幕中心，垂直避开顶 / 底悬浮 UI）
      return { offX: (bxMin + bxMax) / 2 - W / 2, offY: (byMin + byMax) / 2 - visCy };
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
      if (Math.abs(dx) > 1e-6) look2.addScaledVector(rightG, offX / dx);
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
    const fitCenter: [number, number] = wgs84ToGcj02(wlng, wlat);

    // 距离 → 缩放级别：d ∝ 2^(-zoom)，以实测 (zoom0, dist0) 为基准换算；夹在地图缩放范围 [3, 20] 内
    const zoomFit = Math.min(Math.max(zoom0 + Math.log2(dist0 / fit.d), 3), 20);
    // 先应用自适应俯仰角（config.maxPitch 已放宽到与 PITCH_MAX 一致，不会被俯仰钳制拉回）
    this.setPitchSafe(pitch);
    this.map.setZoomAndCenter(+zoomFit.toFixed(3), fitCenter, true);
    // eslint-disable-next-line no-console
    console.info(
      `[MapScene] 自动取景：估算 zoom=${zoomFit.toFixed(2)}、pitch=${pitch.toFixed(1)}（建筑角点 ${corners.length} 个，` +
        `最近取景距离 ${fit.d.toFixed(0)}m / 当前 ${dist0.toFixed(0)}m，投影宽高 ${fit.w.toFixed(0)}×${fit.h.toFixed(0)}px ` +
        `vs 屏幕 ${W}×${H}px，最外侧节点 ${extremeNodes()}）`,
    );

    // 低配设备：跳过逐帧迭代微调。微调每帧调用 setZoomAndCenter 会反复触发高德底图瓦片重载，
    // 是加载期 CPU 瞬间 100% 且 loading 拖到 5~10s 的主要来源；直接以估算 zoom 取景并立即显示模型，
    // 换取更快的首次加载。取景精度略有下降，但对低配机器利大于弊。
    if (this.lowEnd) {
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
      this.markDirty();
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
    if (performance.now() - v.startedAt > 3000) {
      this.endFitRefine(); // 超时放弃（如用户已开始操作地图），恢复模型显示
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
    const offX = (lx + hx) / 2 - (leftPx + rightPx) / 2;
    const offY = (ly + hy) / 2 - visCy;
    // 两方向填满率：包围盒宽 / 高分别占可见区宽 / 高的比例（>1 有富余、<1 出画）
    const availW = Math.max(rightPx - leftPx, 1);
    const availH = Math.max(bottomPx - topPx, 1);
    const fX = availW / Math.max(hx - lx, 1e-6);
    const fY = availH / Math.max(hy - ly, 1e-6);
    const err = Math.log2(Math.min(fX, fY));
    const done = (reason: string): void => {
      this.endFitRefine(); // 结束微调并恢复模型显示
      // eslint-disable-next-line no-console
      console.info(
        `[MapScene] 取景收敛（${reason}）：zoom=${zoomNow.toFixed(2)}、pitch=${v.pitch.toFixed(1)}，` +
          `角点屏幕范围 x[${lx.toFixed(0)}~${hx.toFixed(0)}]/${W}，y[${ly.toFixed(0)}~${hy.toFixed(0)}]/${H}`,
      );
    };
    if (
      Math.abs(offX) <= 3 && Math.abs(offY) <= 3 &&
      Math.abs(Math.log2(fX)) < 0.01 && Math.abs(Math.log2(fY)) < 0.01
    ) {
      done('居中且填满'); // 已收敛：两方向都贴满可见区
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
      // 修正方向：视中心右移 → 内容左移，故取 +off/d；0.9 阻尼防过冲
      const look2 = lookW.clone();
      if (Math.abs(dx) > 1e-6) look2.addScaledVector(rightG, (0.9 * offX) / dx);
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
    const maxSize = this.renderer?.capabilities?.maxTextureSize ?? 4096;
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
   * 低配设备：激进削减单张贴图的首帧开销（返回是否生效；低配下恒为 true，与旧实现的计数语义一致）。
   * 低配机器优先保证加载速度与流畅度，代价是远处略带锯齿。
   *  - 对**所有**贴图关闭 mipmap + 退为线性过滤 + 各向异性=1：省掉 mip 链生成（纯 CPU 浪费）与三线性采样；
   *  - 对最长边 > 512 的贴图重绘到 ≤512 的 canvas：首帧 GPU 上传量最多降 4~16 倍
   *    （原 1024² 贴图 4MB/张 × 108 张 ≈ 450MB，缩到 512² 后仅约 110MB，且无需 mip 链）。
   */
  private reduceTextureForLowEnd(tex: THREE.Texture): boolean {
    if (!this.lowEnd) return false;
    if (typeof document === 'undefined') return false; // 非浏览器环境（如测试）跳过
    const MAX = 512; // 低配贴图尺寸上限（最长边）
    // 关闭 mipmap + 线性过滤 + 各向异性=1（低配优先首帧速度，避免 mip 链生成与三线性采样开销）
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.anisotropy = 1;
    tex.needsUpdate = true;
    const img = tex.image as { width?: number; height?: number } | undefined;
    const w = img?.width ?? 0;
    const h = img?.height ?? 0;
    if (!w || !h) return true;
    const longest = Math.max(w, h);
    // 大贴图缩尺寸：重绘到较小 canvas，首帧 GPU 上传量随之下降
    if (longest > MAX) {
      const scale = MAX / longest;
      const nw = Math.max(1, Math.round(w * scale));
      const nh = Math.max(1, Math.round(h * scale));
      try {
        const canvas = document.createElement('canvas');
        canvas.width = nw;
        canvas.height = nh;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img as CanvasImageSource, 0, 0, nw, nh);
          tex.image = canvas;
          tex.needsUpdate = true;
        }
      } catch {
        /* 个别 ImageBitmap/跨域 drawImage 抛错则保留原图 */
      }
    }
    return true;
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

  private placeModelAtAnchor(): void {
    if (!this.modelRoot) return;

    // 可选：以模型包围盒中心为原点重新居中。
    // 关键：必须平移「几何本身」(geometry.translate)，不能只改 modelRoot.position——
    // 因为后面 position 会被 anchorWorld 整体覆盖，若只改 position 做居中会被抹掉，
    // 导致几何中心并不在原点：一旦模型在建模软件里不是以原点为中心（CAD/BIM 常以真实坐标为原点），
    // 旋转与定位都会围绕偏离建筑中心的「原点」进行，模型被甩到锚点远处、半进半出视野。
    if (this.config.recenterModel) {
      const box = new THREE.Box3().setFromObject(this.modelRoot);
      if (!box.isEmpty()) {
        // 只做「水平居中 + 底面落地」：绝不能把整个包围盒中心搬原点，否则建筑底面被压到地面以下 → 模型「钻到地图底部」。
        // 局部坐标下 Y 为高度方向（modelRotation[90°,0,0] 会把它转到世界 Z 向上），
        // 故仅平移 X/Z 使水平中心对齐原点，并把底面(minY)抬到 y=0，旋转后即立于地面 z=0。
        const cx = (box.min.x + box.max.x) / 2;
        const cz = (box.min.z + box.max.z) / 2;
        const minY = box.min.y;
        this.modelRoot.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh && mesh.geometry) {
            mesh.geometry.translate(-cx, -minY, -cz);
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

  /** 设置/微调校准参数（增量叠加到基准，传入部分字段即可） */
  setCalibration(partial: Partial<ModelCalibration>): void {
    this.calibration = { ...this.calibration, ...partial };
    this.applyCalibration();
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
  private handleMouseMove(e: any): void {
    if (this.measureMode !== 'none') {
      this.callbacks.onHover?.(null); // 测量时隐藏悬停高亮
      return;
    }
    const { x, y } = this.pixelOf(e);
    // 位移 < 1px 视为同位置，跳过重复拾取（避免原地抖动反复 raycast）
    if (this.lastHoverPos && Math.abs(this.lastHoverPos.x - x) < 1 && Math.abs(this.lastHoverPos.y - y) < 1) {
      return;
    }
    this.hoverLatest = { x, y };
    // rAF 节流：把连续 mousemove 合并到下一帧最多拾取一次。
    // 既保证高亮随鼠标即时触发（不依赖 render 每帧回调），又压住 CPU（每帧至多一次 raycast）。
    if (this.hoverRafScheduled) return;
    this.hoverRafScheduled = true;
    requestAnimationFrame(() => {
      this.hoverRafScheduled = false;
      if (this.disposed) return;
      const p = this.hoverLatest;
      if (!p) return;
      const result = this.pick(p.x, p.y);
      this.lastHoverPos = { x: p.x, y: p.y };
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
  // 视图切换（2D / 2.5D / 三维 / 退出室内），切换后保留当前定位
  // 说明：AMap JSAPI 2.0 没有运行时的 setViewMode（仅构造参数 viewMode 支持），
  // 因此「2D/3D」通过 setPitch + setRotation 实现：2D = 俯仰 0（正上方平视），
  // 2.5D/三维 = 不同俯仰角。setViewMode 仅作兼容兜底（部分版本存在）。
  // -------------------------------------------------------------------------
  setMapView(mode: '2d' | '2.5d' | '3d'): void {
    if (!this.map) return;
    if (this.indoorView) this.exitIndoorView(); // 若在室内，先退出并恢复原视角
    const center = this.map.getCenter();
    const zoom = this.map.getZoom();
    // 兼容兜底：旧版 1.4 才有 setViewMode，2.0 不存在，故先 typeof 判断
    if (typeof this.map.setViewMode === 'function') {
      try { this.map.setViewMode(mode === '2d' ? '2D' : '3D'); } catch { /* ignore */ }
    }
    if (mode === '2d') {
      this.setPitchSafe(0);
      this.map.setRotation(0);
    } else {
      this.setPitchSafe(mode === '2.5d' ? 35 : this.config.pitch);
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
  //     结束用容器 dblclick + 显式「完成」按钮双保险。
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
      const ll = this.pixelToGcj(e);
      if (ll) this.renderMeasure(ll);
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

  private unbindMeasureDom(): void {
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
    for (let i = this.measureGroup.children.length - 1; i >= 0; i--) {
      const obj = this.measureGroup.children[i] as any;
      obj.geometry?.dispose?.();
      const mat = obj.material;
      if (Array.isArray(mat)) mat.forEach((m: any) => m.dispose?.());
      else mat?.dispose?.();
      this.measureGroup.remove(obj);
    }
  }

  /** 在 Three.js 场景中重建量算图形（始终绘制在 3D 模型之上） */
  private renderMeasure(cursor?: [number, number]): void {
    if (!this.measureGroup || !this.customCoords) return;
    this.clearMeasureGraphics();
    const pts = cursor ? [...this.measurePts, cursor] : this.measurePts;
    if (pts.length === 0) { this.reportMeasure(); return; }

    const worldPts = pts.map((p) => this.gcjToWorld(p));
    const color = this.measureMode === 'distance' ? 0x38bdf8 : 0xf59e0b;

    // 折线 / 多边形边：测面时闭合首尾，使轮廓成为封闭环
    const linePts = this.measureMode === 'area' && worldPts.length >= 3
      ? [...worldPts, worldPts[0]]
      : worldPts;
    const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
    const lineMat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: false, opacity: 1 });
    lineMat.toneMapped = false;
    const line = new THREE.Line(lineGeo, lineMat);
    line.renderOrder = 999;
    this.measureGroup.add(line);

    // 测面：闭合填充
    if (this.measureMode === 'area' && worldPts.length >= 3) {
      const shape = new THREE.Shape();
      shape.moveTo(worldPts[0].x, worldPts[0].y);
      for (let i = 1; i < worldPts.length; i++) shape.lineTo(worldPts[i].x, worldPts[i].y);
      shape.closePath();
      const fillGeo = new THREE.ShapeGeometry(shape);
      const fillMat = new THREE.MeshBasicMaterial({
        color, depthTest: false, transparent: false, opacity: 1, side: THREE.DoubleSide,  // opaque: avoid shimmer
      });
      fillMat.toneMapped = false;
      const fill = new THREE.Mesh(fillGeo, fillMat);
      fill.renderOrder = 998;
      this.measureGroup.add(fill);
    }

    // 顶点圆点
    const dotGeo = new THREE.SphereGeometry(1.4, 12, 12);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
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

  /** 强制地图（含 GLCustomLayer）重绘一帧，确保量算图形即时可见 */
  private requestRender(): void {
    this.frameCacheDirty = true; // 低配帧缓存：内容可能已变化，强制重绘一次场景
    if (!this.map) return;
    try {
      if (typeof this.map.render === 'function') this.map.render();
      else if (typeof this.map.resize === 'function') this.map.resize();
    } catch {
      /* ignore */
    }
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
  flyTo(lng: number, lat: number, zoom?: number): void {
    if (!this.map) return;
    const [glng, glat] = wgs84ToGcj02(lng, lat);
    this.map.setZoomAndCenter(zoom ?? this.map.getZoom(), [glng, glat], false, 600);
  }

  /** 飞行到某个模型对象 */
  flyToObject(obj: THREE.Object3D): void {
    const wp = new THREE.Vector3();
    obj.getWorldPosition(wp);
    const [lng, lat] = this.worldToWgs84(wp);
    this.flyTo(lng, lat, this.config.focusZoom);
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
  private markDirty(): void {
    // 直接渲染模式下，内容变化无需特殊标记：下一帧 render() 自然会直绘出最新状态。
    // 仅需在地图空闲（AMap 停止持续回调 render()）时主动唤醒一次，让变更立即上屏。
    if (typeof this.map?.render === 'function') this.map.render();
  }

  private render(): void {
    if (!this.renderer || !this.scene || !this.camera || !this.customCoords) return;

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

    // 逐帧直绘模型到 AMap 已清好的画布（见 renderCachedFrame）。降载靠相机同步节流 + 锚点防抖，而非帧缓存。
    this.renderCachedFrame();

    // 截图捕获：在渲染后、buffer 失效前读取
    if (this.captureResolve) this.readSnapshot();

    this.renderer.resetState();
  }

  /**
   * 直接渲染：每帧把场景画到 AMap 已清好的画布上。
   * 与回退到正常版时一致的稳健路径——不引入离屏 RT / 全屏贴图，
   * 从根本上杜绝 RT 缓存与直绘两路视觉不一致导致的整模型闪烁（悬停高亮切换、拖拽起止等尤甚）。
   * 模型仅 3644 三角面，逐帧直绘开销可忽略；相机同步节流与锚点防抖已承担主要降载（见 render()）。
   */
  private renderCachedFrame(): void {
    if (!this.renderer || !this.scene || !this.camera) return;
    // AMap 每帧会清掉本层颜色+深度缓冲后再回调本函数。
    // 重置到屏幕缓冲并仅清深度（不清颜色，避免擦掉底图）：让模型从干净的深度状态自算遮挡关系，
    // 始终压在底图之上，避免地形/建筑深度误遮挡导致的闪烁类伪影。
    this.renderer.setRenderTarget(null);

    // ⚠️ 关键修复（悬停偏移 + 模型被底图遮挡）：
    // three 的渲染视口在 initThree 时按「当时容器尺寸 × pixelRatio」定死，但高德画布的真实
    // drawingBuffer 尺寸（尤其 dpr 与 three 的 pixelRatio 不一致、或窗口/布局变化后）可能不同步。
    // 一旦视口 < 整块画布，模型就只被画到画布的一部分 —— 既表现为「模型某部分被底图遮挡」，
    // 又导致射线拾取 NDC（按全容器计算）与渲染视口错位，于是「鼠标悬在模型上无反应、悬在周围/上方却命中」。
    // 故每帧按真实 drawingBuffer 重设视口/裁剪区，确保模型铺满整块画布、拾取与渲染严格对齐。
    const gl = this.renderer.getContext();
    const bufW = gl.drawingBufferWidth || 1;
    const bufH = gl.drawingBufferHeight || 1;
    const pr = this.renderer.getPixelRatio();
    const vw = bufW / pr; // CSS 像素视口宽（three 会再乘 pr 还原成整块 buffer）
    const vh = bufH / pr;
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

    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
  }

  /** 按当前画布尺寸重建离屏渲染目标；WebGL2 启用多重采样以保留抗锯齿 */
  private rebuildFrameRt(w: number, h: number): void {
    this.frameRt?.dispose();
    const isWebGL2 = !!this.renderer?.capabilities?.isWebGL2;
    const opts: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      // WebGL2 多重采样保留抗锯齿；WebGL1 忽略该字段
      samples: isWebGL2 ? 4 : 0,
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
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    this.blitScene = new THREE.Scene();
    this.blitScene.add(quad);
    this.blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.frameCacheDirty = true;
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
    this.callbacks.onViewChange?.();
  }

  // -------------------------------------------------------------------------
  // 销毁
  // -------------------------------------------------------------------------
  destroy(): void {
    this.disposed = true;
    this.clearRooms();
    // 低配帧缓存 / 贴图场景 / 高亮材质缓存：随渲染器一起释放
    this.frameRt?.dispose();
    this.frameRt = null;
    this.frameRtKey = '';
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
