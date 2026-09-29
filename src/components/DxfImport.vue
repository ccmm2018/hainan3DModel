<script setup lang="ts">
/**
 * DxfImport：DXF 楼层平面图导入（单页式，不再分步）。
 *   上传 → 后台自动校验/解析/配准/匹配 → 结果清单（异常文件高亮） → 一键导入
 *
 * 步骤 1（上传）规范：
 *   - el-upload 拖拽，accept=".dxf"，多选批量；
 *   - 读取用 FileReader.readAsArrayBuffer（不是 readAsText）；
 *   - 每个文件独立 postMessage 给 dxf.worker.ts 解析；
 *   - 主界面每文件一条进度（已接收→解码中→解析中→完成），单文件失败不影响其他文件。
 *
 * 步骤 1 上传 / 2 校验(C1-C6) / 3 解析 / 4 预览确认 / 5 坐标配准 已按规范实现；
 * 步骤 6 确认归属（强/弱/无匹配 + 手动指定 + 新建二次确认 + 批量沿用/楼层递增）已按规范实现；
 * 步骤 7 入库：楼层号冲突三选一（覆盖 / 另存新版本 / 跳过）+ parsed/partial/failed 三态落库
 *   + 指纹回写 buildingDataMap + emit('imported', { buildingName, floorIds })，已按规范实现。
 *
 * 本向导严格执行 README「注意事项（必须遵守）」的 9 条硬约束，关键落点：
 *   [约束1] 禁止自动绑定楼栋、绝不自动新建楼栋；归属由系统预选（强匹配/批量沿用/入口楼栋），最终以「导入」动作确认；
 *   [约束5] 步骤5 局部图纸必须经 AnchorPicker 配准（解出 transform）才可放行入库，禁止未配准局部坐标入库；
 *   [约束8] 步骤2/3 的编码/单位/坐标/字段自动推断结果均在界面明示并支持人工纠正；
 *   解析（步骤1→3）全部在 dxf.worker.ts 执行 [约束7]，主线程无 >100ms 同步解析。
 */
import { computed, markRaw, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox, type UploadFile, type UploadRawFile } from 'element-plus';
import { useBuildingStore } from '../stores/building';
import AnchorPicker from './AnchorPicker.vue';
import { isRoomFieldComplete } from '../utils/roomFields';
import {
  decodeDxf,
  fingerprintFromOutline,
  unitToScale,
  OVERLAP_DEVIATION_THRESHOLD,
  polygonAreaDiffRatio,
} from '../utils/coordinate';
import { polygonCentroid, type Pt } from '../utils/geometry';
import { parseDxfToResult } from '../utils/dxfParser';
import { validateDxf, type DxfValidation } from '../utils/dxfValidate';
import type { CoordSource, DxfParseResult, Floor, FloorTransform, ParsedRoom } from '../types/cad';
import type { MatchResult } from '../utils/matcher';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    buildingNames: string[];
    defaultBuilding?: string;
  }>(),
  { defaultBuilding: '' },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'imported', payload: { buildingName: string; floorIds: string[] }): void;
}>();

const store = useBuildingStore();

// ---- 向导状态 ----
// 步骤制导航已移除，改为「上传 → 结果清单 → 一键导入」单页式：
// 校验/解析/配准/匹配在后台自动跑通，仅在文件有疑问（错误/需配准/需选楼栋）时高亮处理。

const encoding = ref<string>('auto');
/** 是否展开块参照（INSERT/ATTRIB）。默认 false：整体跳过块参照（家具/洁具/门窗等多为块，是噪音来源） */
const expandBlocks = ref<boolean>(false);

/** 是否展开「高级选项」（编码/坐标来源/块参照 手动纠正，默认隐藏，识别有误时才需） */
const showAdvanced = ref(false);
/** 是否展开「修改归属」（楼栋/楼层 手动选择，默认隐藏，系统已自动推断并预填） */
const showAttrEdit = ref(false);

/**
 * 批量上传的「沿用 / 自动递增」偏好：
 * - prefillBuilding：第一次确认归属时选中的楼栋；之后的文件默认沿用它。
 * - prefillFloor：上一次确认时使用的楼层号；之后文件默认楼层 = prefillFloor + 1（自动递增）。
 */
const prefillBuilding = ref('');
const prefillFloor = ref(1);
/** 入口已指定楼栋（如从某栋楼点击进入）：锁定归属，不在向导内重复选择楼栋 */
const buildingLocked = computed(
  () => !!props.defaultBuilding && store.buildingNames.includes(props.defaultBuilding),
);

// 归属默认由系统按「强匹配 / 批量沿用 / 入口楼栋」预选，用户可在清单中直接修改；
// 最终以「导入」动作确认（不再要求单独点【确认绑定】），但绝不自动新建楼栋。

// ---- 步骤 7（入库）楼层号冲突处理 ----
/**
 * 同楼已存在该楼层时弹框三选一：覆盖原图纸 / 另存为新版本 / 跳过。
 * - conflictVisible：冲突弹框是否打开
 * - conflictItem：触发冲突的当前激活文件
 * - conflictExisting：已存在的楼层（用于展示信息）
 */
const conflictVisible = ref(false);
const conflictItem = ref<UploadItem | null>(null);
const conflictExisting = ref<Floor | null>(null);

/** 上传队列中的单个文件（含解析进度与结果） */
interface UploadItem {
  id: string;
  name: string;
  size: number;
  status: 'received' | 'decoding' | 'parsing' | 'done' | 'error';
  buffer?: ArrayBuffer; // 原始字节，落盘用（确认入库时取）
  result?: DxfParseResult;
  coordSource?: CoordSource;
  transform?: FloorTransform;
  error?: string;
  // 归属态（步骤 6）：每个文件独立，支持批量各自指定
  buildingName?: string;
  floorNo?: number;
  attributionConfirmed?: boolean;
}

const items = ref<UploadItem[]>([]);
const activeId = ref<string | null>(null);
let uidSeq = 0;
const nextUid = (): string => `f${Date.now().toString(36)}_${++uidSeq}`;

const doneItems = computed(() => items.value.filter((i) => i.status === 'done' && i.result));
const activeItem = computed<UploadItem | null>(() => {
  const found = items.value.find((i) => i.id === activeId.value);
  return found ?? doneItems.value[0] ?? null;
});
watch(
  doneItems,
  (list) => {
    if (!activeId.value && list.length) activeId.value = list[0].id;
  },
  { immediate: true },
);

// ---- 步骤 6（确认归属）：每个文件独立的归属选择 + 批量沿用/自动递增 ----
/**
 * 归属楼栋：用户选中的值优先；为空时取「默认候选」。
 * 默认候选 = 批量沿用楼栋（第二个文件起）优先，否则若强匹配命中则取该候选（首个文件）。
 * 该计算属性只读、不改写 item，避免 computed 内产生副作用；真正的写入发生在 importOne / importAll（ensureAttribution）。
 */
const attributionDefaultBld = computed(() => {
  if (prefillBuilding.value) return prefillBuilding.value; // 第二个文件起：沿用第一次选中的楼栋
  const mr = matchResult.value;
  if (mr && mr.status === 'strong' && mr.candidates.length === 1) return mr.candidates[0];
  return '';
});
const floorDefaultNo = computed(() => (prefillBuilding.value ? prefillFloor.value + 1 : 1));

const effectiveBuildingName = computed<string>({
  get: () => activeItem.value?.buildingName ?? attributionDefaultBld.value,
  set: (v) => {
    if (activeItem.value) activeItem.value.buildingName = v;
  },
});
const effectiveFloorNo = computed<number>({
  get: () => activeItem.value?.floorNo ?? floorDefaultNo.value,
  set: (v) => {
    if (activeItem.value) activeItem.value.floorNo = v;
  },
});

/** 当前激活文件在步骤 6 的匹配状态：strong / weak / none / manual（局部坐标或无外轮廓，无自动匹配） */
const attributionStatus = computed<'strong' | 'weak' | 'none' | 'manual'>(() => {
  const mr = matchResult.value;
  if (!mr) return 'manual';
  return mr.status;
});

const importedFloors = computed(() => store.floorsOf(effectiveBuildingName.value));

// ---- 步骤 2 校验（C1–C6）：区分 error / warn / info，仅 error 阻断 ----
const validation = computed<DxfValidation | null>(() => {
  const it = activeItem.value;
  if (!it || !it.result) return null;
  return validateDxf(it.result, {
    buffer: it.buffer,
    coordSourceOverride: it.coordSource,
  });
});

// ---- 步骤 4/5 计算（基于当前激活文件） ----
const floorOutlineLocal = computed<[number, number][] | null>(() => {
  const p = activeItem.value?.result;
  if (!p) return null;
  if (p.floorOutline) return p.floorOutline.polygon;
  const b = p.bbox;
  return [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
  ];
});
const roomsLocal = computed<[number, number][][]>(
  () => activeItem.value?.result?.rooms.map((r) => r.polygon) ?? [],
);
const footprintUtm = computed<[number, number][] | null>(() => {
  const fp = store.buildingFingerprint(effectiveBuildingName.value);
  return (fp.outline as [number, number][] | undefined) ?? null;
});

// ---- 步骤 5（坐标配准）：utm 分支 = 自动算指纹 + 与 footprint 叠加预览 ----
/** 叠加预览的目标楼栋：优先用自动匹配候选，否则用当前所选楼栋 */
const overlayTargetBuilding = computed(() => matchResult.value?.candidates[0] ?? effectiveBuildingName.value);
const overlayFootprint = computed<[number, number][] | null>(() => {
  const fp = store.buildingFingerprint(overlayTargetBuilding.value).outline;
  return (fp as [number, number][] | undefined) ?? null;
});
/** 解析外轮廓 vs footprint 的面积偏差（0~1） */
const utmDeviation = computed<number | null>(() => {
  const o = floorOutlineLocal.value;
  const fp = overlayFootprint.value;
  if (!o || o.length < 3 || !fp || fp.length < 3) return null;
  return polygonAreaDiffRatio(o as Pt[], fp);
});
const utmDeviationWarn = computed(
  () => utmDeviation.value !== null && utmDeviation.value > OVERLAP_DEVIATION_THRESHOLD,
);
/** 解析外轮廓质心与 footprint 质心的偏移（米） */
const utmCenterOffset = computed<number | null>(() => {
  const o = floorOutlineLocal.value;
  const fp = overlayFootprint.value;
  if (!o || o.length < 3 || !fp || fp.length < 3) return null;
  const co = polygonCentroid(o as Pt[]);
  const cf = polygonCentroid(fp as Pt[]);
  return Math.hypot(co[0] - cf[0], co[1] - cf[1]);
});

const matchResult = computed<MatchResult | null>(() =>
  activeItem.value ? matchResultOf(activeItem.value) : null,
);

function applyMatch() {
  const r = matchResult.value;
  if (r && r.candidates.length === 1) {
    effectiveBuildingName.value = r.candidates[0];
    ElMessage.success(`已采用自动匹配楼栋：${r.candidates[0]}`);
  }
}

// ---- 弹窗打开时重置向导 ----
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      items.value = [];
      activeId.value = null;
      encoding.value = 'auto';
      expandBlocks.value = false;
      // 批量沿用偏好也一并清空（每个会话从零开始）
      prefillBuilding.value = '';
      prefillFloor.value = 1;
      // 若从「某栋楼」入口打开（已带 defaultBuilding），且它已存在于楼栋表，
      // 则预选为归属楼栋，避免第 6 步还要手动找。
      if (props.defaultBuilding && store.buildingNames.includes(props.defaultBuilding)) {
        prefillBuilding.value = props.defaultBuilding;
      }
    }
  },
);

// ---- DXF 解析（Worker 优先，主线程回退），支持相位回调 ----
let worker: Worker | null = null;
let reqId = 0;

interface PendingReq {
  resolve: (r: DxfParseResult) => void;
  reject: (e: Error) => void;
  onPhase?: (p: 'decoding' | 'parsing') => void;
  /** 兜底主线程解析所需：回退时要重新解码+解析 */
  buffer: ArrayBuffer;
  enc: string;
}
const pending = new Map<number, PendingReq>();

interface WorkerResponse {
  id: number;
  phase?: 'decoding' | 'parsing';
  result?: DxfParseResult;
  error?: string;
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('../workers/dxf.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const { id, phase, result, error } = ev.data;
      const req = pending.get(id);
      if (!req) return;
      if (phase) {
        req.onPhase?.(phase);
        return;
      }
      pending.delete(id);
      if (result) req.resolve(result);
      else req.reject(new Error(error ?? '解析失败'));
    };
    // 关键修复：Worker 加载/运行失败（最常见情况是构建后的 dist 用 file:// 直接打开、
    // 模块 Worker 不被支持、或 worker 脚本 404）时，浏览器不会自动 reject 挂起的请求，
    // 进度条会永久卡在「已接收 / 解码中」。这里捕获 onerror，立即把挂起请求转主线程兜底解析。
    worker.onerror = () => {
      for (const [id, req] of pending) {
        pending.delete(id);
        void parseOnMain(req.buffer, req.enc, (p) => req.onPhase?.(p)).then(req.resolve, req.reject);
      }
    };
  } catch {
    worker = null;
  }
  return worker;
}

async function decodeBuffer(buf: ArrayBuffer, enc: string): Promise<string> {
  if (enc && enc !== 'auto') {
    try {
      return new TextDecoder(enc).decode(buf);
    } catch {
      // 编码不支持，回退自动探测
    }
  }
  return decodeDxf(buf);
}

/** 主线程兜底解析（无 Worker / Worker 失败时）。用静态导入，避免动态 import 在异常环境下二次失败。 */
async function parseOnMain(
  buffer: ArrayBuffer,
  enc: string,
  onPhase: (p: 'decoding' | 'parsing') => void,
): Promise<DxfParseResult> {
  onPhase('decoding');
  const text = await decodeBuffer(buffer, enc);
  onPhase('parsing');
  return parseDxfToResult(text, '', 0, { expandBlocks: expandBlocks.value });
}

function parseInWorker(
  id: number,
  buffer: ArrayBuffer,
  enc: string,
  onPhase: (p: 'decoding' | 'parsing') => void,
): Promise<DxfParseResult> {
  const w = ensureWorker();
  if (!w) return parseOnMain(buffer, enc, onPhase);
  return new Promise<DxfParseResult>((resolve, reject) => {
    pending.set(id, { resolve, reject, onPhase, buffer, enc });
    // 不 transfer：结构化克隆会复制 buffer，保留 item.buffer 供确认入库使用
    w.postMessage({ id, buffer, encoding: enc });
    window.setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        parseOnMain(buffer, enc, onPhase).then(resolve, reject);
      }
    }, 8000);
  });
}

/** 用 FileReader.readAsArrayBuffer 读取（非 readAsText） */
function readAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as ArrayBuffer);
    fr.onerror = () => reject(new Error('文件读取失败'));
    fr.readAsArrayBuffer(file);
  });
}

function statusOf(item: UploadItem): number {
  switch (item.status) {
    case 'received':
      return 15;
    case 'decoding':
      return 45;
    case 'parsing':
      return 75;
    case 'done':
    case 'error':
      return 100;
  }
}

const STATUS_TEXT: Record<UploadItem['status'], string> = {
  received: '已接收',
  decoding: '解码中',
  parsing: '解析中',
  done: '完成',
  error: '失败',
};

function statusTagType(s: UploadItem['status']): 'info' | 'warning' | 'success' | 'danger' {
  switch (s) {
    case 'received':
      return 'info';
    case 'decoding':
    case 'parsing':
      return 'warning';
    case 'done':
      return 'success';
    case 'error':
      return 'danger';
  }
}

async function parseFile(item: UploadItem, file: File): Promise<void> {
  try {
    const buf = await readAsArrayBuffer(file);
    item.buffer = buf;
    item.status = 'decoding';
    const result = await parseInWorker(++reqId, buf, encoding.value, (p) => {
      item.status = p; // decoding / parsing
    });
    item.result = markRaw(result);
    item.coordSource = result.coordSource;
    autoFillRooms(item);
    if (!item.result.rooms.length) {
      ElMessageBox.alert(
        `「${file.name}」未解析出任何房间轮廓。请确认 DXF 含闭合的「内部结构内墙线」图层后重新上传。`,
        '未识别到房间',
        { type: 'warning' },
      );
    }
    item.status = 'done';
  } catch (err) {
    item.status = 'error';
    item.error = (err as Error).message ?? '解析失败';
    // 单文件失败不影响其他文件
  }
}

function enqueueFile(raw: File): void {
  const lower = raw.name.toLowerCase();
  if (!lower.endsWith('.dxf')) {
    ElMessage.error(`「${raw.name}」不是 .dxf 文件，已跳过`);
    return;
  }
  // 关键：用 reactive 创建 item，使 parseFile 闭包里的所有状态变更（status / result /
  // buffer / error / coordSource）都经过响应式代理的 set 陷阱，从而正确触发进度条与
  // canNext 重渲染。若此处用普通对象，push 进 ref 数组后数组里存的是它的代理，而闭包里
  // 仍是原始对象，Worker 回包后对其属性的修改不会触发重渲染，进度条会卡在初始的 15%（received）。
  const item = reactive<UploadItem>({
    id: nextUid(),
    name: raw.name,
    size: raw.size,
    status: 'received',
  });
  items.value.push(item);
  void parseFile(item, raw);
}

function onUploadChange(uploadFile: UploadFile): void {
  const raw = uploadFile.raw as UploadRawFile | undefined;
  if (raw) enqueueFile(raw);
}

function removeItem(id: string): void {
  items.value = items.value.filter((i) => i.id !== id);
  if (activeId.value === id) activeId.value = doneItems.value[0]?.id ?? null;
}

function clearAll(): void {
  items.value = [];
  activeId.value = null;
}

/** 用当前编码 / 块参照参数重新解析已上传的字节（不依赖原始 File 对象） */
async function reparse(item: UploadItem): Promise<void> {
  if (!item.buffer) return;
  const prev = item.status;
  item.status = 'decoding';
  try {
    const result = await parseOnMain(item.buffer, encoding.value, (p) => {
      item.status = p;
    });
    item.result = markRaw(result);
    item.coordSource = result.coordSource;
    item.status = 'done';
  } catch (err) {
    item.status = prev === 'done' ? 'error' : prev;
    item.error = (err as Error).message ?? '重新解析失败';
  }
}

// 编码 / 块参照切换时，对当前激活文件重新解析（让这些选项真正生效）
watch([encoding, expandBlocks], () => {
  const it = activeItem.value;
  if (it && it.status === 'done' && it.buffer) void reparse(it);
});

// ---- 校验 / 坐标来源切换 ----
function onCoordSourceChange(v: CoordSource): void {
  const it = activeItem.value;
  if (!it) return;
  it.coordSource = v;
  if (v === 'utm') it.transform = undefined;
}

const selectedCount = computed(
  () => activeItem.value?.result?.rooms.filter((r) => r.selected).length ?? 0,
);

// ---- 步骤 4 预览确认 ----
const roomFieldStats = computed(() => {
  const rooms = activeItem.value?.result?.rooms ?? [];
  const N = rooms.length;
  const X = rooms.filter(isRoomFieldComplete).length;
  return {
    N,
    X,
    Y: N - X,
    excluded: rooms.filter((r) => r.selected === false).length,
  };
});

/** 用户确认「提取结果无误」后才允许进入下一步 */
const editingRoom = ref<ParsedRoom | null>(null);
const drawerOpen = ref(false);

function openEditor(room: ParsedRoom): void {
  editingRoom.value = room;
  drawerOpen.value = true;
}
function closeEditor(): void {
  drawerOpen.value = false;
  editingRoom.value = null;
}
function toggleExclude(room: ParsedRoom, excluded: boolean): void {
  room.selected = !excluded;
}

// 切换激活文件时无需重置归属 / 预览：
// 归属默认按系统预选值（强匹配 / 批量沿用 / 入口楼栋），用户手动改后才落进 item；
// 预览房间的勾选状态存在 room.selected 上，跟随文件本身，不随切换清空。

// ---- 步骤 3 解析结果摘要（extractRooms 输出 DxfParseResult） ----
const parseResult = computed(() => activeItem.value?.result ?? null);
/** 生效的坐标来源：用户在校验步骤的覆盖优先，否则取解析推断值 */
const effectiveCoordSource = computed(
  () => activeItem.value?.coordSource ?? activeItem.value?.result?.coordSource,
);
const unitLabel = computed(() => {
  const u = parseResult.value?.unit;
  return u === 'mm' ? '毫米' : u === 'cm' ? '厘米' : u === 'm' ? '米' : '未知';
});
const coordLabel = computed(() => {
  const c = effectiveCoordSource.value;
  return c === 'utm' ? 'UTM 49N（米）' : c === 'local' ? '局部坐标' : '未知';
});
const bboxLabel = computed(() => {
  const b = parseResult.value?.bbox;
  if (!b) return '—';
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  return `${w.toFixed(1)} × ${h.toFixed(1)}（源单位）`;
});

/** 编码的友好展示：默认自动识别，无需用户关心 */
const encodingLabel = computed(() => {
  const e = encoding.value;
  if (e === 'auto') return '自动识别（UTF-8 / GBK）';
  if (e === 'utf-8') return 'UTF-8';
  if (e === 'gb2312') return 'GB2312';
  return e.toUpperCase();
});

// 以上 coordLabel / bboxLabel / encodingLabel / unitLabel 仅用于已隐藏的技术明细，
// 普通用户无需查看，故不在界面展示（保留计算以备高级模式追溯）。


/** 是否必须让用户手动选楼栋：系统未能自动推断（无强/弱匹配、无入口楼栋、无批量沿用） */
const needAttrChoice = computed(() => {
  const it = activeItem.value;
  return !it || !buildingFor(it);
});

/** 房间字段自动补填：几何面积回填到使用/建筑面积，编号与编码互填，减少用户手动补填负担 */
function autoFillRooms(item: UploadItem): void {
  const r = item.result;
  if (!r) return;
  const s = unitToScale(r.unit);
  const sqm = (a: number) => Math.round(a * s * s * 10) / 10;
  for (const room of r.rooms) {
    if (room.useArea == null || Number.isNaN(room.useArea as number)) room.useArea = sqm(room.area);
    if (room.buildArea == null || Number.isNaN(room.buildArea as number)) room.buildArea = room.useArea;
    if (!room.number && room.code) room.number = room.code;
    if (!room.code && room.number) room.code = room.number;
  }
}

// ---- 单页式：每个文件的就绪状态（驱动「导入」按钮可用性与高亮） ----
type Readiness = 'parsing' | 'error' | 'need-calib' | 'need-attr' | 'ready';

/** 计算某文件的匹配结果（独立于 activeItem 的版本，供批量就绪判断） */
function matchResultOf(it: UploadItem): MatchResult | null {
  const p = it.result;
  if (!p || !p.floorOutline || it.coordSource !== 'utm') return null;
  const fpRaw = fingerprintFromOutline(p.floorOutline.polygon);
  if (!fpRaw.centerUtm) return null;
  return store.matchByFingerprint({
    centerUtm: fpRaw.centerUtm,
    area: fpRaw.footprintArea ?? 0,
    azimuth: fpRaw.azimuth ?? 0,
  });
}

/** 计算某文件的归属楼栋（与 effectiveBuildingName 同口径，但作用于任意 item） */
function buildingFor(it: UploadItem): string {
  if (it.buildingName) return it.buildingName;
  if (prefillBuilding.value) return prefillBuilding.value;
  const mr = matchResultOf(it);
  if (mr && mr.status === 'strong' && mr.candidates.length === 1) return mr.candidates[0];
  return '';
}
function floorFor(it: UploadItem): number {
  if (it.floorNo != null) return it.floorNo;
  return prefillBuilding.value ? prefillFloor.value + 1 : 1;
}

/** 文件就绪判定：错误阻断 / 局部需配准 / 无楼栋需选 / 其余可直接导入 */
function itemReadiness(it: UploadItem): Readiness {
  if (!it.result || it.status !== 'done') return it.status === 'error' ? 'error' : 'parsing';
  const v = validateDxf(it.result, { buffer: it.buffer, coordSourceOverride: it.coordSource });
  if (v.hasError) return 'error';
  if (!it.result.rooms.length) return 'error';
  if (it.coordSource === 'local' && !it.transform) return 'need-calib';
  if (!buildingFor(it)) return 'need-attr';
  return 'ready';
}

const readyItems = computed(() => items.value.filter((i) => itemReadiness(i) === 'ready'));

/** 入库前补全归属（系统预选值落进 item），供 importOne / importAll 使用 */
function ensureAttribution(it: UploadItem): void {
  if (!it.buildingName) it.buildingName = buildingFor(it);
  if (it.floorNo == null) it.floorNo = floorFor(it);
}

/** 单文件导入：冲突时弹框三选一 */
function importOne(it: UploadItem): void {
  ensureAttribution(it);
  const bld = it.buildingName!;
  const flr = it.floorNo!;
  const existing = store.getFloor(bld, flr);
  if (existing) {
    conflictItem.value = it;
    conflictExisting.value = existing;
    conflictVisible.value = true;
    return;
  }
  doImport(it, bld, flr, 1);
}

/** 一键导入全部可导入文件；冲突的留在列表单独处理 */
function importAll(): void {
  const ready = items.value.filter((i) => itemReadiness(i) === 'ready');
  if (!ready.length) {
    ElMessage.warning('当前没有可直接导入的文件，请先处理标有「需配准 / 需选楼栋 / 错误」的文件');
    return;
  }
  let imported = 0;
  let skipped = 0;
  for (const it of ready) {
    ensureAttribution(it);
    const bld = it.buildingName!;
    const flr = it.floorNo!;
    const existing = store.getFloor(bld, flr);
    if (existing) {
      skipped++;
      continue;
    }
    doImport(it, bld, flr, 1);
    imported++;
  }
  if (skipped) {
    ElMessage.info(`${skipped} 个文件与现有楼层冲突，已跳过，请单独点击「导入」处理`);
  }
}

// ---- 步骤 6 确认归属：强/弱/无匹配 + 手动指定 + 新建（二次确认） ----
/** 在候选单选列表中选中某楼栋 */
function onPickCandidate(name: string): void {
  effectiveBuildingName.value = name;
}

/** 【新建楼栋】—— 二次确认，避免把「对不上」误当新楼 */
async function createNewBuilding(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('请输入新楼栋名称', '新建楼栋', {
      confirmButtonText: '下一步',
      cancelButtonText: '取消',
      inputPattern: /\S+/,
      inputErrorMessage: '楼栋名称不能为空',
    });
    const name = (value ?? '').trim();
    if (!name) return;
    // 二次确认：明确提示「若是只是对不上现有楼栋，应改用手动指定」
    await ElMessageBox.confirm(
      `确认新建楼栋「${name}」吗？\n\n若图纸只是与现有楼栋对不上坐标，请点「取消」并改用「手动指定已有楼栋」，避免误建重复楼栋。`,
      '新建楼栋 - 二次确认',
      { confirmButtonText: '确认新建', cancelButtonText: '再想想', type: 'warning' },
    );
    effectiveBuildingName.value = name;
    ElMessage.success(`已新建并选中楼栋：${name}`);
  } catch {
    /* 用户取消，不创建 */
  }
}

/**
 * 真正执行入库：构建 payload、调 store.importFloor、写回指纹、emit('imported')、
 * 从队列移除已处理文件并推进向导。version=1 为覆盖/新建；>=2 为「另存为新版本」。
 */
function doImport(it: UploadItem, bld: string, flr: number, version: number): void {
  if (!it.result || !it.buffer) return;
  const fid = version > 1 ? `${bld}-F${flr}-v${version}` : `${bld}-F${flr}`;
  const payload = {
    buildingName: bld,
    floorNo: flr,
    fileName: it.name,
    parsed: it.result,
    coordSource: it.coordSource ?? it.result.coordSource,
    transform: it.coordSource === 'local' ? it.transform : undefined,
    dxfBytes: it.buffer,
    version,
  };
  try {
    const gotFid = store.importFloor(payload);
    // 批量沿用偏好：记录本次归属，供第二个文件起默认沿用、楼层自动递增
    prefillBuilding.value = bld;
    prefillFloor.value = flr;
    const fp = store.buildingFingerprint(bld);
    const verTag = version > 1 ? `（新版本 v${version}）` : '';
    if (fp.centerUtm) {
      ElMessage.success(`已导入 ${bld} ${flr}F${verTag}（${selectedCount.value} 间），并写回楼栋指纹`);
    } else {
      ElMessage.success(`已导入 ${bld} ${flr}F${verTag}（${selectedCount.value} 间）`);
    }
    // 成功后上报：buildingName + 本次入库的楼层 id 列表（parsed / partial / failed 均已落库）
    emit('imported', { buildingName: bld, floorIds: [gotFid] });
    finishItem(it);
  } catch (err) {
    ElMessage.error(`导入失败：${(err as Error).message ?? '未知错误'}`);
  }
}

/** 入库成功后把该文件移出队列，并推进到下一个待处理文件 / 关闭向导 */
function finishItem(it: UploadItem): void {
  items.value = items.value.filter((i) => i.id !== it.id);
  activeId.value = doneItems.value[0]?.id ?? null;
  if (items.value.length === 0) visible.value = false;
}

// 单文件 / 批量入库逻辑见上方 importOne / importAll；冲突处理见 resolveConflict。

/** 冲突弹框三选一：覆盖原图纸 / 另存为新版本 / 跳过 */
async function resolveConflict(choice: 'overwrite' | 'newversion' | 'skip'): Promise<void> {
  const it = conflictItem.value;
  const existing = conflictExisting.value;
  conflictVisible.value = false;
  if (!it || !existing) return;
  const bld = existing.buildingName;
  const flr = existing.floorNo;
  if (choice === 'skip') {
    ElMessage.info(`已跳过 ${bld} ${flr}F（与现有图纸冲突）`);
    finishItem(it);
  } else if (choice === 'overwrite') {
    // 覆盖原图纸：以 version 1 覆盖现有 v1（floors 主键相同，直接覆盖）
    doImport(it, bld, flr, 1);
  } else {
    // 另存为新版本：计算下一个未占用版本号，floor id 追加 -v{n}
    const v = store.nextVersion(bld, flr);
    doImport(it, bld, flr, v);
  }
  conflictItem.value = null;
  conflictExisting.value = null;
}

function onRemoveFloor(f: number): void {
  store.removeFloor(effectiveBuildingName.value, f);
  ElMessage.info(`已删除 ${effectiveBuildingName.value} ${f}F`);
}

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

onBeforeUnmount(() => {
  worker?.terminate();
  worker = null;
});
</script>

<template>
  <el-dialog
    v-model="visible"
    title="导入楼层平面图（DXF）"
    width="680px"
    @close="clearAll"
  >
    <div class="dxf-body">
      <!-- 上传区（始终可见） -->
      <section class="dxf-panel dxf-panel--upload">
        <el-upload
          class="dxf-uploader"
          drag
          multiple
          accept=".dxf"
          :auto-upload="false"
          :show-file-list="false"
          :on-change="onUploadChange"
        >
          <div class="dxf-drop">
            <div class="dxf-drop__icon">⤓</div>
            <div>将 DXF 文件拖到此处，或<em>点击上传</em>（支持批量多选）</div>
            <div class="dxf-drop__hint">仅接受 .dxf；每个文件独立解析，单文件失败不影响其他文件</div>
          </div>
        </el-upload>

        <div v-if="items.length" class="dxf-filelist">
          <div v-for="item in items" :key="item.id" class="dxf-fileitem" :class="{ 'is-active': item.id === activeId }" @click="activeId = item.id">
            <div class="dxf-fileitem__head">
              <span class="dxf-fileitem__name">{{ item.name }}</span>
              <el-tag :type="statusTagType(item.status)" size="small">{{ STATUS_TEXT[item.status] }}</el-tag>
              <el-tag v-if="itemReadiness(item) === 'ready'" type="success" size="small" effect="plain">可导入</el-tag>
              <el-tag v-else-if="itemReadiness(item) === 'need-calib'" type="warning" size="small" effect="plain">需配准</el-tag>
              <el-tag v-else-if="itemReadiness(item) === 'need-attr'" type="warning" size="small" effect="plain">需选楼栋</el-tag>
              <el-tag v-else-if="itemReadiness(item) === 'error'" type="danger" size="small" effect="plain">错误</el-tag>
              <el-button link type="primary" size="small" :disabled="itemReadiness(item) !== 'ready'" @click.stop="importOne(item)">导入</el-button>
              <el-button link type="danger" size="small" @click.stop="removeItem(item.id)">移除</el-button>
            </div>
            <el-progress
              :percentage="statusOf(item)"
              :status="item.status === 'done' ? 'success' : item.status === 'error' ? 'exception' : ''"
            />
            <div v-if="item.error" class="dxf-fileitem__err">{{ item.error }}</div>
            <div v-else-if="item.status === 'done'" class="dxf-fileitem__ok">
              识别到 {{ item.result?.rooms.length }} 个房间 · 单位
              {{ item.result?.unit === 'mm' ? '毫米' : item.result?.unit === 'm' ? '米' : '未知' }}
            </div>
          </div>
        </div>

        <div v-if="doneItems.length > 1" class="dxf-activepick">
          <span class="dxf-label">当前查看：</span>
          <el-select v-model="activeId" placeholder="选择要查看的文件" class="dxf-control">
            <el-option v-for="i in doneItems" :key="i.id" :label="i.name" :value="i.id" />
          </el-select>
        </div>
      </section>

      <!-- 自动识别结果（编码/单位/坐标来源/块参照 内部自动判断，用户无需关心；识别有误才点开「高级」手动纠正） -->
      <section v-if="activeItem?.result" class="dxf-panel">
        <div class="dxf-autodetect">
          <div class="dxf-autodetect__title">已自动识别（无需手动设置）</div>
          <div class="dxf-autodetect__line">
            系统已自动识别文件，共找到 <b>{{ activeItem.result.rooms.length }}</b> 个房间，无需手动设置参数。
          </div>

          <div class="dxf-autofill">
            <template v-if="roomFieldStats.Y > 0">
              已自动补全 <b>{{ roomFieldStats.X }}</b> 间房的面积/字段，<b>{{ roomFieldStats.Y }}</b> 间缺少文本标注（可直接导入，之后在房间列表中补填，不影响落库）。
            </template>
            <template v-else>房间字段已识别完整，可直接导入。</template>
          </div>

          <el-button text type="primary" size="small" class="dxf-advanced-toggle" @click="showAdvanced = !showAdvanced">
            {{ showAdvanced ? '收起高级选项' : '识别有误？手动调整' }}
          </el-button>

          <div v-if="showAdvanced" class="dxf-advanced">
            <div class="dxf-row dxf-row--wrap">
              <label class="dxf-label">坐标来源</label>
              <el-radio-group :model-value="activeItem.coordSource" @change="onCoordSourceChange">
                <el-radio value="local">局部坐标</el-radio>
                <el-radio value="utm">UTM 49N</el-radio>
              </el-radio-group>
            </div>
            <div class="dxf-row dxf-row--wrap">
              <label class="dxf-label">编码</label>
              <el-select v-model="encoding" class="dxf-enc" placeholder="文本编码">
                <el-option label="自动（UTF-8 / GBK）" value="auto" />
                <el-option label="UTF-8" value="utf-8" />
                <el-option label="GBK" value="gbk" />
                <el-option label="GB2312" value="gb2312" />
              </el-select>
            </div>
            <div class="dxf-row dxf-row--wrap">
              <label class="dxf-label">块参照</label>
              <el-checkbox v-model="expandBlocks">展开块参照（INSERT/ATTRIB）</el-checkbox>
            </div>
          </div>
        </div>

        <div v-if="validation && (validation.hasError || validation.hasWarn)" class="dxf-checks">
          <div class="dxf-checks__head">
            <span>识别提示</span>
            <span class="dxf-checks__summary">
              <em v-if="validation.hasError" class="is-err">存在需处理的问题</em>
              <em v-else class="is-warn">{{ validation.checks.filter((c) => c.level === 'warn').length }} 项提示（可继续）</em>
            </span>
          </div>
          <div
            v-for="c in validation.checks.filter((x) => x.level !== 'info')"
            :key="c.code"
            class="dxf-check"
            :class="`dxf-check--${c.level}`"
          >
            <span class="dxf-check__icon">
              {{ c.level === 'error' ? '✕' : c.level === 'warn' ? '⚠' : 'ℹ' }}
            </span>
            <span class="dxf-check__msg">{{ c.message }}</span>
          </div>
        </div>
      </section>

      <!-- 解析提示（仅在有告警时显示；技术细节已自动处理并隐藏） -->
      <section v-if="activeItem?.result && activeItem.result.warnings.length" class="dxf-panel">
        <div class="dxf-parse-warn">
          <div class="dxf-parse-warn__title">解析提示（{{ activeItem.result.warnings.length }} 条）</div>
          <div
            v-for="(w, i) in activeItem.result.warnings"
            :key="i"
            class="dxf-parse-warn__item"
            :class="`is-${w.level}`"
          >
            <span class="dxf-parse-warn__msg">{{ w.message }}</span>
          </div>
        </div>
      </section>


      <!-- 坐标配准：仅「局部坐标」图纸需要用户操作（系统硬性要求必须先定位才能入库）；
           UTM 图纸的楼栋匹配在后台自动完成，结果只体现在下方「确认归属」，此处不展示任何坐标/配准细节 -->
      <section v-if="activeItem?.result && effectiveCoordSource === 'local'" class="dxf-panel">
        <el-alert
          class="dxf-preview"
          type="info"
          :closable="false"
          title="该图纸为局部坐标（无地理基准），请在下方左右两图各点 2 个同名位置完成定位，无需填写任何坐标数字"
        />
        <AnchorPicker
          v-model="activeItem.transform"
          :unit="activeItem.result.unit"
          :floor-outline-local="floorOutlineLocal"
          :rooms-local="roomsLocal"
          :footprint-utm="footprintUtm"
        />
      </section>

      <!-- 确认归属（系统按强匹配 / 批量沿用 / 入口楼栋预选，可直接修改；以「导入」动作确认，绝不自动新建楼栋） -->
      <section v-if="activeItem?.result" class="dxf-panel">
        <!-- 归属已由系统自动预填，匹配结论见上方「坐标配准」区；此处仅保留必要操作时才展开的选择 -->
        <!-- 弱匹配候选单选（仅未锁定时出现） -->
        <div v-if="!buildingLocked && attributionStatus === 'weak' && matchResult?.candidates.length" class="dxf-cand">
          <div class="dxf-cand__title">候选楼栋（单选）</div>
          <el-radio-group :model-value="effectiveBuildingName" @change="onPickCandidate">
            <el-radio v-for="c in matchResult.candidates" :key="c" :value="c">{{ c }}</el-radio>
          </el-radio-group>
        </div>

        <!-- 归属：从某栋楼进入时已锁定；否则按系统自动推断并预填，用户可按需展开修改 -->
        <div class="dxf-attr">
          <div class="dxf-attr__auto">
            <span class="dxf-attr__chip">
              将导入至：<b>{{ effectiveBuildingName || '待选择楼栋' }}</b> <b>{{ effectiveFloorNo }}F</b>
            </span>
            <el-tag v-if="buildingLocked" type="info" size="small" effect="plain">已指定楼栋</el-tag>
            <el-tag v-else-if="attributionStatus === 'strong'" type="success" size="small" effect="plain">已自动匹配</el-tag>
            <el-tag v-else-if="attributionStatus === 'weak'" type="warning" size="small" effect="plain">自动匹配待确认</el-tag>
            <el-button v-if="!buildingLocked" text type="primary" size="small" @click="showAttrEdit = !showAttrEdit">
              {{ showAttrEdit ? '收起' : effectiveBuildingName ? '修改' : '选择楼栋' }}
            </el-button>
          </div>

          <div v-if="(showAttrEdit || needAttrChoice) && !buildingLocked" class="dxf-attr__edit">
            <div class="dxf-row dxf-row--wrap">
              <label class="dxf-label">楼栋（可搜索）</label>
              <el-select
                v-model="effectiveBuildingName"
                filterable
                placeholder="选择 / 搜索楼栋名称"
                class="dxf-control"
              >
                <el-option v-for="b in store.buildingNames" :key="b" :label="b" :value="b" />
              </el-select>
              <el-button type="primary" plain @click="createNewBuilding">新建楼栋</el-button>
            </div>
            <div class="dxf-row">
              <label class="dxf-label">楼层</label>
              <div class="dxf-floor-input">
                <el-input-number v-model="effectiveFloorNo" :min="1" :max="99" controls-position="right" class="dxf-control" />
                <span class="dxf-unit">F</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 批量沿用提示（仅未锁定时出现） -->
        <div v-if="prefillBuilding && !buildingLocked" class="dxf-batch-hint">
          批量模式：本文件默认沿用「{{ prefillBuilding }}」、楼层自动递增为 {{ floorDefaultNo }}F，可逐文件修改
        </div>

        <!-- 当前归属预览（导入即按此落库） -->
        <div class="dxf-bind">
          <span class="dxf-bind__ok">当前归属：{{ effectiveBuildingName || '未选择' }} {{ effectiveFloorNo }}F</span>
          <span class="dxf-bind__tip">{{ buildingLocked ? '（由进入的楼栋决定，点击「导入」即按此落库）' : '（点击「导入」即按此归属落库，可在上方随时修改）' }}</span>
        </div>

        <div v-if="importedFloors.length" class="dxf-list">
          <div class="dxf-list__title">已导入（{{ effectiveBuildingName }}）</div>
          <div v-for="f in importedFloors" :key="f" class="dxf-list__item">
            <span>
              {{ f }}F · {{ store.roomsOfFloor(store.getFloor(effectiveBuildingName, f)?.id ?? '').length }} 间
              · {{ store.getFloor(effectiveBuildingName, f)?.status }}
            </span>
            <el-button link type="danger" size="small" @click="onRemoveFloor(f)">删除</el-button>
          </div>
        </div>
      </section>

      <div v-if="!activeItem?.result" class="dxf-empty">上传 DXF 文件后，这里会显示解析结果、坐标配准与归属信息</div>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="readyItems.length === 0" @click="importAll">
        一键导入全部（{{ readyItems.length }}）
      </el-button>
    </template>
  </el-dialog>

  <!-- 步骤 7 楼层号冲突弹框：覆盖原图纸 / 另存为新版本 / 跳过，三选一 -->
  <el-dialog
    v-model="conflictVisible"
    title="楼层号冲突"
    width="460px"
    append-to-body
    :close-on-click-modal="false"
  >
    <div v-if="conflictExisting" class="dxf-conflict">
      <p>
        楼栋 <b>{{ conflictExisting.buildingName }}</b> 已存在
        <b>{{ conflictExisting.floorNo }}F</b>（状态：{{ conflictExisting.status }}，{{ conflictExisting.roomCount }} 间）。
        请选择本次导入的处理方式：
      </p>
      <el-alert
        v-if="conflictExisting.status !== 'parsed'"
        class="dxf-preview"
        type="warning"
        :closable="false"
        :title="`现有楼层为 ${conflictExisting.status} 状态：${conflictExisting.errorReason ?? '无附加说明'}`"
      />
      <p class="dxf-conflict__hint">
        覆盖原图纸 → 用新图纸替换现有楼层；另存为新版本 → 保留现有楼层，新增 -v{n} 版本；跳过 → 不导入本文件。
      </p>
    </div>
    <template #footer>
      <el-button @click="resolveConflict('skip')">跳过</el-button>
      <el-button @click="resolveConflict('newversion')">另存为新版本</el-button>
      <el-button type="danger" @click="resolveConflict('overwrite')">覆盖原图纸</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.dxf-steps { margin-bottom: 18px; }
.dxf-body { min-height: 280px; display: flex; flex-direction: column; gap: 14px; }
.dxf-panel { display: flex; flex-direction: column; gap: 14px; }
.dxf-row { display: flex; align-items: center; gap: 12px; }
.dxf-row--col { flex-direction: column; align-items: stretch; gap: 8px; }
.dxf-row--wrap { flex-wrap: wrap; gap: 10px; }
.dxf-attr { display: flex; flex-direction: column; gap: 12px; }
.dxf-label { width: auto; flex: 0 0 auto; white-space: nowrap; color: #4b5563; font-size: 14px; }
.dxf-control { flex: 1 1 auto; }
.dxf-enc { width: 200px; }
.dxf-unit { color: #6b7280; white-space: nowrap; }
/* 楼层：数字输入框与「F」同一行紧贴 */
.dxf-floor-input { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; }
.dxf-tip { font-size: 12px; color: #9ca3af; }
.dxf-autodetect { border: 1px solid #ebeef5; border-radius: 8px; padding: 12px; background: #fafcff; }
.dxf-autodetect__title { font-size: 13px; color: #6b7280; margin-bottom: 8px; }
.dxf-autodetect__line { font-size: 13px; color: #4b5563; line-height: 1.6; }
.dxf-autodetect__line b { color: #1f2d3d; font-size: 15px; }
.dxf-autodetect__grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.dxf-autodetect__cell { display: flex; flex-direction: column; gap: 2px; }
.dxf-autodetect__k { font-size: 12px; color: #9ca3af; }
.dxf-autodetect__v { font-size: 14px; font-weight: 600; color: #1f2d3d; }
.dxf-autofill { font-size: 12px; color: #6b7280; margin-top: 10px; line-height: 1.5; }
.dxf-advanced-toggle { margin-top: 8px; padding-left: 0; }
.dxf-advanced { margin-top: 10px; padding-top: 10px; border-top: 1px dashed #e5e7eb; display: flex; flex-direction: column; gap: 10px; }
.dxf-attr__auto { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dxf-attr__chip { font-size: 14px; color: #303133; }
.dxf-attr__chip b { color: #1f2d3d; }
.dxf-attr__edit { margin-top: 10px; display: flex; flex-direction: column; gap: 12px; }
.dxf-uploader { width: 100%; }
.dxf-drop {
  padding: 22px 12px;
  text-align: center;
  color: #6b7280;
  border: 1px dashed #c0c4cc;
  border-radius: 8px;
  background: #fafafa;
}
.dxf-drop__icon { font-size: 26px; color: #409eff; }
.dxf-drop em { color: #409eff; font-style: normal; }
.dxf-drop__hint { font-size: 12px; color: #9ca3af; margin-top: 4px; }
.dxf-filelist { display: flex; flex-direction: column; gap: 12px; }
.dxf-fileitem {
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 10px 12px;
  background: #fff;
}
.dxf-fileitem__head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.dxf-fileitem__name { flex: 1; font-size: 13px; color: #303133; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dxf-fileitem__err { font-size: 12px; color: #d97706; margin-top: 6px; }
.dxf-fileitem__ok { font-size: 12px; color: #16a34a; margin-top: 6px; }
.dxf-activepick { display: flex; align-items: center; gap: 12px; }
.dxf-preview { margin-top: 0; }
.dxf-roomlist {
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 6px;
}
.dxf-room {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  font-size: 13px;
  color: #303133;
  border-bottom: 1px dashed #f0f2f5;
}
.dxf-room--off { opacity: 0.45; }
.dxf-room__no { font-weight: 600; min-width: 56px; }
.dxf-room__name { flex: 1; color: #4b5563; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dxf-room__tag {
  font-size: 11px;
  color: #16a34a;
  border: 1px solid #bbf7d0;
  background: #f0fdf4;
  border-radius: 4px;
  padding: 1px 6px;
}
.dxf-room__tag.is-warn { color: #d97706; border-color: #fde68a; background: #fffbeb; }
.dxf-room__area { color: #9ca3af; min-width: 64px; text-align: right; }
.dxf-list { margin-top: 4px; border-top: 1px solid #ebeef5; padding-top: 10px; }
.dxf-list__title { font-size: 13px; color: #909399; margin-bottom: 6px; }
.dxf-list__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  color: #303133;
  padding: 5px 0;
}
.dxf-final { font-size: 13px; color: #4b5563; line-height: 1.9; text-align: left; }
.dxf-parse-summary {
  border: 1px solid #ebeef5;
  border-radius: 8px;
  overflow: hidden;
}
.dxf-parse-summary__title {
  padding: 9px 12px;
  background: #f7f8fa;
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  border-bottom: 1px solid #ebeef5;
}
.dxf-parse-summary__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 1px;
  background: #ebeef5;
}
.dxf-parse-cell {
  background: #fff;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dxf-parse-cell__k { font-size: 12px; color: #909399; }
.dxf-parse-cell__v { font-size: 14px; font-weight: 600; color: #303133; }
.dxf-parse-warn {
  border: 1px solid #fde68a;
  border-radius: 8px;
  overflow: hidden;
  background: #fffbeb;
}
.dxf-parse-warn__title {
  padding: 9px 12px;
  font-size: 13px;
  font-weight: 600;
  color: #92400e;
  border-bottom: 1px solid #fde68a;
}
.dxf-parse-warn__item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 7px 12px;
  font-size: 13px;
  color: #4b5563;
  border-bottom: 1px dashed #fde9b0;
}
.dxf-parse-warn__item:last-child { border-bottom: none; }
.dxf-parse-warn__item.is-error { background: #fef2f2; }
.dxf-parse-warn__badge {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: #d97706;
  border-radius: 4px;
  padding: 1px 7px;
  margin-top: 1px;
}
.dxf-parse-warn__item.is-error .dxf-parse-warn__badge { background: #d92020; }
.dxf-parse-warn__msg { flex: 1; line-height: 1.5; }
.dxf-parse-rooms__head { font-size: 13px; color: #909399; margin-bottom: 6px; }
.dxf-checks {
  border: 1px solid #ebeef5;
  border-radius: 8px;
  overflow: hidden;
}
.dxf-checks__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  background: #f7f8fa;
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  border-bottom: 1px solid #ebeef5;
}
.dxf-checks__summary em { font-style: normal; font-size: 12px; font-weight: 600; }
.dxf-checks__summary .is-err { color: #d92020; }
.dxf-checks__summary .is-warn { color: #d97706; }
.dxf-checks__summary .is-ok { color: #16a34a; }
.dxf-check {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  font-size: 13px;
  color: #303133;
  border-bottom: 1px dashed #f0f2f5;
}
.dxf-check:last-child { border-bottom: none; }
.dxf-check__badge {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: #909399;
  border-radius: 4px;
  padding: 1px 7px;
}
.dxf-check__icon { flex: 0 0 auto; font-size: 14px; line-height: 1; }
.dxf-check__msg { flex: 1; color: #4b5563; }
.dxf-check--ok .dxf-check__icon { color: #16a34a; }
.dxf-check--ok .dxf-check__badge { background: #16a34a; }
.dxf-check--warn .dxf-check__icon { color: #d97706; }
.dxf-check--warn .dxf-check__badge { background: #d97706; }
.dxf-check--error .dxf-check__icon { color: #d92020; }
.dxf-check--error .dxf-check__badge { background: #d92020; }
.dxf-check--error { background: #fef2f2; }
.dxf-check--info .dxf-check__icon { color: #2563eb; }
.dxf-check--info .dxf-check__badge { background: #2563eb; }

/* 步骤 4 预览确认 */
.dxf-stat {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  padding: 10px 14px;
  background: #f7f8fa;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  font-size: 14px;
  color: #4b5563;
}
.dxf-stat b { font-size: 16px; color: #111827; margin: 0 2px; }
.dxf-stat .is-ok { color: #16a34a; }
.dxf-stat .is-ok b { color: #16a34a; }
.dxf-stat .is-warn { color: #d97706; }
.dxf-stat .is-warn b { color: #d97706; }
.dxf-stat .is-muted { color: #9ca3af; }
.dxf-panel--preview4 { gap: 12px; }
.dxf-preview4__body { display: flex; gap: 14px; align-items: stretch; }
.dxf-preview4__list { flex: 0 0 320px; display: flex; flex-direction: column; min-width: 0; }
.dxf-preview4__list-head { font-size: 13px; color: #909399; margin-bottom: 6px; }
.dxf-roomlist--tall { max-height: 360px; }
.dxf-preview4__map {
  flex: 1 1 auto;
  min-width: 0;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  overflow: hidden;
  background: #fbfcfe;
}
.dxf-confirm {
  align-self: flex-start;
  font-size: 13px;
  color: #303133;
}
.dxf-room__tag.is-info { color: #2563eb; border-color: #bfdbfe; background: #eff6ff; }
.dxf-room__tag.is-err { color: #d92020; border-color: #fecaca; background: #fef2f2; }
.dxf-drawer__actions { display: flex; gap: 10px; margin-top: 16px; }
.dxf-drawer__hint { font-size: 12px; color: #9ca3af; margin-top: 12px; line-height: 1.6; }

/* 步骤 5 坐标配准：UTM 自动指纹 + 叠加预览 */
.dxf-fp { border: 1px solid #ebeef5; border-radius: 8px; overflow: hidden; }
.dxf-fp__title { padding: 9px 12px; background: #f7f8fa; font-size: 13px; font-weight: 600; color: #303133; border-bottom: 1px solid #ebeef5; }
.dxf-fp__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1px; background: #ebeef5; }
.dxf-fp__cell { background: #fff; padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; }
.dxf-fp__k { font-size: 12px; color: #909399; }
.dxf-fp__v { font-size: 14px; font-weight: 600; color: #303133; }
.dxf-overlay { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
.dxf-overlay__title { padding: 8px 12px; font-size: 13px; font-weight: 600; color: #303133; background: #f7f8fa; border-bottom: 1px solid #ebeef5; }
.dxf-match__reason { font-size: 12px; color: #6b7280; line-height: 1.6; }

/* 步骤 6 确认归属 */
.dxf-cand {
  border: 1px solid #fde68a;
  background: #fffbeb;
  border-radius: 8px;
  padding: 10px 12px;
}
.dxf-cand__title { font-size: 13px; color: #92400e; margin-bottom: 6px; font-weight: 600; }
.dxf-btns { display: flex; gap: 12px; flex-wrap: wrap; }
.dxf-batch-hint {
  font-size: 12px;
  color: #6b7280;
  background: #f3f4f6;
  border-radius: 6px;
  padding: 6px 10px;
}
.dxf-bind { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.dxf-bind__ok { font-size: 13px; color: #16a34a; font-weight: 600; }
.dxf-bind__tip { font-size: 12px; color: #d97706; }

/* 步骤 7 楼层号冲突弹框 */
.dxf-conflict p { font-size: 14px; color: #303133; line-height: 1.7; margin: 0 0 12px; }
.dxf-conflict b { color: #111827; }
.dxf-conflict__hint { font-size: 12px; color: #909399; margin: 12px 0 0; }

/* 单页式布局：详情区块卡片化，上传区无边框 */
.dxf-body > section.dxf-panel:not(.dxf-panel--upload) {
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 10px;
  padding: 14px;
}
.dxf-panel--upload { background: transparent; border: none; padding: 0; }
.dxf-fileitem { cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s; }
.dxf-fileitem.is-active { border-color: #409eff; box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.12); }
.dxf-empty { padding: 44px 12px; text-align: center; color: #9ca3af; font-size: 13px; }
</style>
