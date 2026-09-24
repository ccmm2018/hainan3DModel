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
import { wgs84ToGcj02, gcj02ToWgs84 } from '../utils/coordTransform';
import type { SceneConfig } from '../config/mapConfig';
import { ROOM_STATUS_CONFIG, type Room } from '../data/roomData';
import area from '@turf/area';

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

export interface MapSceneCallbacks {
  onModelProgress?: (percent: number) => void;
  onModelReady?: () => void;
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
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private modelRoot: THREE.Object3D | null = null;
  private raycaster = new THREE.Raycaster();
  /** 上一帧的地图视角签名，用于检测视角变化 */
  private lastViewSig = '';

  private gcjCenter: [number, number];
  private gcjAnchor: [number, number];
  /** 锚点（含微调偏移）在 customCoords 空间的坐标 */
  private anchorWorld = new THREE.Vector3();

  /** 高亮材质（选中/悬停共用，颜色动态设置） */
  private hlMaterial = new THREE.MeshStandardMaterial({
    emissiveIntensity: 0.7,
    transparent: true,
    opacity: 0.9,
    depthWrite: true,
  });
  private highlightedObject: THREE.Object3D | null = null;

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
   * 渲染策略：AMap 的 GL 自定义图层每帧都会清掉底图帧缓冲后回调 render()，
   * 因此每帧都必须重新叠加绘制模型（不可整帧跳过，否则模型会闪烁/隐藏）。
   * 低配机器的性能压力由「低功耗渲染设置（关抗锯齿、像素比封顶为 1）」承担。
   * 场景内容变化时调用 markDirty() 唤醒地图重绘即可。
   */
  private disposed = false;

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
  /** 建筑节点名 → 其 Object3D（用于拾取后高亮整栋楼，而非某个装饰子网格） */
  private buildingObjects = new Map<string, THREE.Object3D>();
  /** 建筑节点名 → 其世界中心坐标（用于判断装饰网格是否「贴在某栋楼上」） */
  private buildingCenters = new Map<string, THREE.Vector3>();
  /** 装饰归并到建筑的拾取半径（模型水平尺寸的一半），超出则视为独立不可点击节点 */
  private modelPickRadius = Infinity;

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
  }

  private initThree(gl: WebGLRenderingContext): void {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;

    // 低配设备探测：CPU 核心数少 / 设备内存小 → 关闭抗锯齿、像素比封顶为 1，
    // 否则弱机平移/缩放地图时每帧渲染开销过大，CPU 瞬间 100%。
    const lowEnd =
      (navigator.hardwareConcurrency || 4) <= 4 ||
      (((navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8) <= 4);
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
    // 像素比封顶：retina 屏 dpr=2/3 时片元量按平方放大，低配机器是卡顿主因；封顶到 2（低配 1）
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowEnd ? 1 : 2));
    this.renderer.setSize(width, height, false);
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, width / height, 1, 1 << 30);

    // 量算图层：独立于模型，始终绘制在模型之上
    this.measureGroup = new THREE.Group();
    this.scene.add(this.measureGroup);

    this.setupLights();
    this.loadModel(this.config.modelUrl);
  }

  private setupLights(): void {
    if (!this.scene) return;
    const hemi = new THREE.HemisphereLight('#ffffff', '#334', 1.6);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight('#ffffff', 2.2);
    dir.position.set(-200, 400, 150);
    dir.castShadow = true;
    this.scene.add(dir);
  }

  // -------------------------------------------------------------------------
  // 模型加载与地理对齐放置
  // -------------------------------------------------------------------------
  private loadModel(url: string): void {
    if (!this.scene) return;
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        if (this.disposed) return;
        this.modelRoot = gltf.scene;

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
                pm.transparent = true;
                pm.opacity = 0.45;
                pm.roughness = Math.max(pm.roughness ?? 0.1, 0.12);
                pm.metalness = pm.metalness ?? 0;
                pm.depthWrite = false;
                pm.needsUpdate = true;
              }
            }
          }
        });

        this.placeModelAtAnchor();
        this.scene!.add(this.modelRoot);
        this.resolveMeshBuildingNames();

        this.markDirty();
        this.callbacks.onModelReady?.();
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
  }

  /**
   * 反推每个 Mesh 所属楼栋 / 道路 / 水系名称。
   *
   * 模型里建筑通常由「带中文名的父节点（如 教学楼）+ 若干无名子 Mesh」组成，
   * three.js 加载时会给无名子 Mesh 自动命名为 mesh_0 / mesh_1 ……，
   * 而射线拾取命中的正是这些无名子 Mesh，导致拿到的名称是 mesh_N 而非楼栋名，
   * 既会让属性面板显示 mesh_N，也会让房间数据按 mesh_N 查不到。
   *
   * 关键纠偏（当前模型）：只有白名单 buildingNodeNames（数字 0–25）才是「建筑节点」，
   * 棚架(RoofShed)、女儿墙(Parapet) 等装饰网格不是建筑。若把装饰节点也当作锚点，
   * 建筑网格会被最近的装饰抢走名字，导致点击建筑却显示「RoofShed_Rig」之类装饰名。
   * 因此这里**只以建筑节点为锚点**，确保每个 Mesh 归属到正确的建筑编号。
   */
  private resolveMeshBuildingNames(): void {
    if (!this.modelRoot) return;
    this.modelRoot.updateMatrixWorld(true);
    this.buildingObjects.clear();
    this.buildingCenters.clear();

    const anchors: { name: string; pos: THREE.Vector3; obj: THREE.Object3D }[] = [];
    this.modelRoot.traverse((o) => {
      if (o === this.modelRoot) return;
      if (o.name && this.buildingNames.has(o.name)) {
        const c = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
        anchors.push({ name: o.name, pos: c, obj: o });
        this.buildingObjects.set(o.name, o);
        this.buildingCenters.set(o.name, c);
      }
    });
    if (anchors.length === 0) return;

    // 拾取半径：以模型水平包围盒较大边的一半为上限，用于判断「装饰网格是否贴在某栋楼上」。
    const box = new THREE.Box3().setFromObject(this.modelRoot);
    const size = box.getSize(new THREE.Vector3());
    this.modelPickRadius = Math.max(size.x, size.z) * 0.5;

    // 给每个 mesh 标注「最近建筑」与距离，供 pick 把贴在某楼上的装饰归并到该楼
    this.modelRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const c = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
      let best = anchors[0];
      let bestD = Infinity;
      for (const a of anchors) {
        const dx = a.pos.x - c.x;
        const dy = a.pos.y - c.y;
        const dz = a.pos.z - c.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = a;
        }
      }
      mesh.userData.buildingName = best.name;
      mesh.userData.buildingDist = Math.sqrt(bestD);
    });
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
    this.callbacks.onHover?.(this.pick(x, y));
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
    const targets: THREE.Object3D[] = [];
    if (this.modelRoot) targets.push(this.modelRoot);
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

      // 2) 命中的是非建筑网格（如建筑上的棚架 / 女儿墙装饰）：
      //    若它空间上贴着某栋楼（在拾取半径内）则归并到该楼，否则视为不可点击。
      const nearName = mesh.userData.buildingName as string | undefined;
      if (nearName && this.buildingNames.has(nearName)) {
        const dist = (mesh.userData.buildingDist as number) ?? Infinity;
        if (dist <= this.modelPickRadius) {
          const b = this.buildingObjects.get(nearName);
          if (b) return this.makeBuildingPick(b, hit, px, py);
        }
      }
      // 该节点不是建筑、也不贴任何楼 → 不可点击、无选中效果，继续看下一个相交对象
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

  /** 高亮对象（整棵子树），color 为高亮色 */
  highlight(obj: THREE.Object3D | null, color: string): void {
    this.clearHighlight();
    if (!obj) return;
    this.hlMaterial.color.set(color);
    this.hlMaterial.emissive.set(color);
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        if (!mesh.userData.__origMaterial) mesh.userData.__origMaterial = mesh.material;
        mesh.material = this.hlMaterial;
      }
    });
    this.highlightedObject = obj;
    this.markDirty();
  }

  /** 清除高亮 */
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

        const color = ROOM_STATUS_CONFIG[room.status]?.color ?? '#888888';
        const mat = new THREE.MeshStandardMaterial({
          color,
          roughness: 0.5,
          metalness: 0.1,
          emissive: 0x000000,
          emissiveIntensity: 0,
          transparent: true,
          opacity: 0.92,
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
    mat.color.set(ROOM_STATUS_CONFIG[status]?.color ?? '#888888');
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
    this.map.setPitch(this.config.indoorPitch);

    this.reserveFloorGroups(building, this.config.defaultFloorCount);
    this.setBuildingTranslucent(building, true);
    this.indoorView = true;
    this.indoorTarget = building;
  }

  /** 退出室内视角（恢复原视角、还原建筑材质） */
  exitIndoorView(): void {
    if (this.indoorTarget) this.setBuildingTranslucent(this.indoorTarget, false);
    this.indoorView = false;
    this.indoorTarget = null;
    if (this.savedCamera && this.map) {
      const [glng, glat] = this.savedCamera.center;
      this.map.setZoomAndCenter(this.savedCamera.zoom, [glng, glat], false, 500);
      this.map.setPitch(this.savedCamera.pitch);
      this.map.setRotation(this.savedCamera.rotation);
      this.savedCamera = null;
    }
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
      this.map.setPitch(0);
      this.map.setRotation(0);
    } else {
      this.map.setPitch(mode === '2.5d' ? 35 : this.config.pitch);
    }
    this.map.setZoomAndCenter(zoom, center, true);
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
    const lineMat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
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
        color, depthTest: false, transparent: true, opacity: 0.22, side: THREE.DoubleSide,
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
            c.transparent = true;
            c.opacity = 0.22;
            c.depthWrite = false;
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
    // AMap 自定义图层每帧都会清底图帧缓冲后回调 render()，render() 内总是重新叠加绘制模型。
    // 若地图当前处于空闲（不再持续回调），需主动唤醒一次重绘，否则变更要等用户下次交互才显示。
    if (typeof this.map?.render === 'function') this.map.render();
  }

  private render(): void {
    if (!this.renderer || !this.scene || !this.camera || !this.customCoords) return;

    // ⚠️ 不能整帧跳过渲染：AMap 的 GL 自定义图层每帧都会先清掉底图帧缓冲、再回调本函数，
    // 模型必须在本帧重新叠加绘制到该帧缓冲上。若「视角未变」就 return 跳过 renderer.render()，
    // 被跳过的那一帧模型就不会被画出（底图已清），缩放/平移时表现为模型时而显示时而隐藏（闪烁）。
    // 低配机器的性能压力已由「低功耗渲染设置（关抗锯齿、像素比封顶为 1）」承担，无需靠跳帧降负载。
    this.renderer.resetState();

    // 视角变化检测（拖拽 / 缩放 / 旋转 / 飞行）→ 通知上层刷新锚定浮层位置
    this.syncViewChange();

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

    this.renderer.render(this.scene, this.camera);

    // 截图捕获：在渲染后、buffer 失效前读取
    if (this.captureResolve) this.readSnapshot();

    this.renderer.resetState();
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
    this.hlMaterial.dispose();

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
