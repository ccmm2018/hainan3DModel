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

  private disposed = false;

  // 量算（测距 / 测面）状态
  private AMap: any = null;
  private measureMode: 'none' | 'distance' | 'area' = 'none';
  private measureReportMode: 'distance' | 'area' = 'distance';
  private measurePoints: [number, number][] = [];
  private measureMarkers: any[] = [];
  private measureTemp: any[] = [];
  private measureMoveHandler: ((e: any) => void) | null = null;
  private measureClickHandler: ((e: any) => void) | null = null;
  private measureDblHandler: ((e: any) => void) | null = null;

  constructor(container: HTMLDivElement, config: SceneConfig, callbacks: MapSceneCallbacks = {}) {
    this.container = container;
    this.config = config;
    this.callbacks = callbacks;

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

    try {
      this.renderer = new THREE.WebGLRenderer({
        context: gl,
        antialias: true,
        alpha: true,
      });
    } catch (err) {
      // WebGL 上下文不兼容（如 three r163+ 不再支持 WebGL 1）时，把错误抛给上层
      this.callbacks.onMapError?.(err);
      return;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, width / height, 1, 1 << 30);

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

        this.modelRoot.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        this.placeModelAtAnchor();
        this.scene!.add(this.modelRoot);

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

  private placeModelAtAnchor(): void {
    if (!this.modelRoot) return;

    // 可选：以模型包围盒中心为原点重新居中
    if (this.config.recenterModel) {
      const box = new THREE.Box3().setFromObject(this.modelRoot);
      const center = box.getCenter(new THREE.Vector3());
      this.modelRoot.position.sub(center);
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

    const first = intersects[0];
    const mesh = first.object as THREE.Mesh;
    const screenX = px;
    const screenY = py;

    // 命中了房间格子
    if (mesh.userData.isRoom) {
      const room = mesh.userData.room as Room;
      return {
        object: mesh,
        target: mesh,
        name: room.roomNo,
        point: first.point.clone(),
        lngLat: this.worldToWgs84(first.point),
        screenX,
        screenY,
        isRoom: true,
        room,
      };
    }

    // 命中了建筑/道路/水系
    const target = this.selectableTargetOf(mesh);
    return {
      object: mesh,
      target,
      name: target.name || mesh.name || '(未命名)',
      point: first.point.clone(),
      lngLat: this.worldToWgs84(first.point),
      screenX,
      screenY,
      isRoom: false,
    };
  }

  /** 从命中的 mesh 向上找到「可选择的命名分组」 */
  private selectableTargetOf(obj: THREE.Object3D): THREE.Object3D {
    let cur: THREE.Object3D | null = obj;
    while (cur && cur !== this.modelRoot) {
      if (cur.name && cur.name.trim()) return cur;
      cur = cur.parent;
    }
    return obj;
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
  // -------------------------------------------------------------------------
  setMapView(mode: '2d' | '2.5d' | '3d'): void {
    if (!this.map) return;
    if (this.indoorView) this.exitIndoorView(); // 若在室内，先退出并恢复原视角
    const center = this.map.getCenter();
    const zoom = this.map.getZoom();
    if (mode === '2d') {
      this.map.setViewMode('2D');
      this.map.setRotation(0);
    } else {
      this.map.setViewMode('3D');
      this.map.setPitch(mode === '2.5d' ? 35 : this.config.pitch);
    }
    this.map.setZoomAndCenter(zoom, center, true);
  }

  // -------------------------------------------------------------------------
  // 量算：测距（连续打点）/ 测面（闭合多边形）
  // -------------------------------------------------------------------------
  startMeasure(mode: 'distance' | 'area'): void {
    if (!this.map) return;
    this.stopMeasure();
    this.measureMode = mode;
    this.measureReportMode = mode;
    this.measureMoveHandler = (e: any) => this.onMeasureMove(e);
    this.measureClickHandler = (e: any) => this.onMeasureClick(e);
    this.measureDblHandler = (e: any) => this.onMeasureDblClick(e);
    this.map.on('mousemove', this.measureMoveHandler);
    this.map.on('click', this.measureClickHandler);
    this.map.on('dblclick', this.measureDblHandler);
    // 测量期间禁用双击放大，避免与「双击结束」冲突
    try { this.map.setStatus({ doubleClickZoom: false }); } catch { /* ignore */ }
  }

  stopMeasure(): void {
    this.measureMode = 'none';
    if (this.measureMoveHandler) { this.map?.off('mousemove', this.measureMoveHandler); this.measureMoveHandler = null; }
    if (this.measureClickHandler) { this.map?.off('click', this.measureClickHandler); this.measureClickHandler = null; }
    if (this.measureDblHandler) { this.map?.off('dblclick', this.measureDblHandler); this.measureDblHandler = null; }
    this.clearTemp();
    this.measureMarkers.forEach((m) => this.map?.remove(m));
    this.measureMarkers = [];
    this.measurePoints = [];
    try { this.map?.setStatus({ doubleClickZoom: true }); } catch { /* ignore */ }
    this.callbacks.onMeasureUpdate?.(null);
  }

  private onMeasureClick(e: any): void {
    if (this.measureMode === 'none') return;
    const ll = e?.lnglat;
    if (!ll) return;
    const pt: [number, number] = [ll.getLng(), ll.getLat()];
    const n = this.measurePoints.length;
    if (n > 0 && this.map.getDistance(this.measurePoints[n - 1], pt) < 0.5) return; // 忽略双击产生的重复点
    this.measurePoints.push(pt);
    const marker = new this.AMap.CircleMarker({
      center: pt,
      radius: 5,
      strokeColor: this.measureMode === 'distance' ? '#38bdf8' : '#f59e0b',
      strokeWeight: 2,
      fillColor: '#ffffff',
      fillOpacity: 1,
      zIndex: 210,
      bubble: true,
    });
    this.map.add(marker);
    this.measureMarkers.push(marker);
    this.renderMeasure();
  }

  private onMeasureMove(e: any): void {
    if (this.measureMode === 'none' || this.measurePoints.length === 0) return;
    const ll = e?.lnglat;
    if (!ll) return;
    this.renderMeasure([ll.getLng(), ll.getLat()]);
  }

  private onMeasureDblClick(_e: any): void {
    if (this.measureMode === 'none') return;
    this.finishMeasure();
  }

  private finishMeasure(): void {
    this.measureMode = 'none';
    if (this.measureMoveHandler) { this.map.off('mousemove', this.measureMoveHandler); this.measureMoveHandler = null; }
    if (this.measureClickHandler) { this.map.off('click', this.measureClickHandler); this.measureClickHandler = null; }
    if (this.measureDblHandler) { this.map.off('dblclick', this.measureDblHandler); this.measureDblHandler = null; }
    try { this.map.setStatus({ doubleClickZoom: true }); } catch { /* ignore */ }
    this.renderMeasure();
    this.reportMeasure();
  }

  private clearTemp(): void {
    this.measureTemp.forEach((o) => this.map?.remove(o));
    this.measureTemp = [];
  }

  private renderMeasure(cursor?: [number, number]): void {
    this.clearTemp();
    const pts = cursor ? [...this.measurePoints, cursor] : this.measurePoints;
    if (this.measureMode === 'distance') {
      if (pts.length >= 1) {
        const line = new this.AMap.Polyline({
          path: pts,
          strokeColor: '#38bdf8',
          strokeWeight: 3,
          strokeOpacity: 0.95,
          showDir: true,
          zIndex: 200,
          bubble: true,
        });
        this.map.add(line);
        this.measureTemp.push(line);
      }
    } else if (this.measureMode === 'area') {
      if (pts.length >= 2) {
        const line = new this.AMap.Polyline({
          path: pts,
          strokeColor: '#f59e0b',
          strokeWeight: 3,
          zIndex: 200,
          bubble: true,
        });
        this.map.add(line);
        this.measureTemp.push(line);
      }
      if (pts.length >= 3) {
        const poly = new this.AMap.Polygon({
          path: pts,
          strokeColor: '#f59e0b',
          strokeWeight: 2,
          fillColor: '#f59e0b',
          fillOpacity: 0.25,
          zIndex: 199,
          bubble: true,
        });
        this.map.add(poly);
        this.measureTemp.push(poly);
      }
    }
    this.reportMeasure();
  }

  private reportMeasure(): void {
    const mode = this.measureMode !== 'none' ? this.measureMode : this.measureReportMode;
    if (mode === 'distance') {
      const segs: number[] = [];
      let total = 0;
      for (let i = 1; i < this.measurePoints.length; i++) {
        const d = this.map.getDistance(this.measurePoints[i - 1], this.measurePoints[i]);
        segs.push(d);
        total += d;
      }
      this.callbacks.onMeasureUpdate?.({
        mode: 'distance',
        segments: segs,
        value: total,
        points: this.measurePoints.length,
      });
      return;
    }
    let value = 0;
    if (this.measurePoints.length >= 3) {
      const ring = [...this.measurePoints, this.measurePoints[0]];
      value = area({ type: 'Polygon', coordinates: [ring] }) as number;
    }
    this.callbacks.onMeasureUpdate?.({
      mode: 'area',
      value,
      points: this.measurePoints.length,
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
      if (obj.name && obj.name.trim() && !seen.has(obj.name)) {
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
  private render(): void {
    if (!this.renderer || !this.scene || !this.camera || !this.customCoords) return;

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
