<script setup lang="ts">
/**
 * DxfImport：DXF 楼层平面图导入向导（7 步）。
 *   0 上传 → 1 校验 → 2 解析 → 3 预览确认 → 4 坐标配准 → 5 确认归属 → 6 完成
 *
 * 步骤 1（上传）规范：
 *   - el-upload 拖拽，accept=".dxf"，多选批量；
 *   - 读取用 FileReader.readAsArrayBuffer（不是 readAsText）；
 *   - 每个文件独立 postMessage 给 dxf.worker.ts 解析；
 *   - 主界面每文件一条进度（已接收→解码中→解析中→完成），单文件失败不影响其他文件。
 *
 * 步骤 2-7 当前复用既有单文件预览/配准/确认逻辑（落到「当前激活文件」），
 * 后续按用户逐条下发的规范再细化。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage, type UploadFile, type UploadRawFile } from 'element-plus';
import { useBuildingStore } from '../stores/building';
import AnchorPicker from './AnchorPicker.vue';
import FloorPlan2D from './FloorPlan2D.vue';
import { isRoomFieldComplete } from '../utils/roomFields';
import { decodeDxf, fingerprintFromOutline } from '../utils/coordinate';
import { validateDxf, type DxfValidation } from '../utils/dxfValidate';
import type { CoordSource, DxfParseResult, FloorTransform, ParsedRoom } from '../types/cad';
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
  (e: 'imported', floorId: string): void;
}>();

const store = useBuildingStore();

// ---- 向导状态 ----
const STEP_TITLES = ['上传', '校验', '解析', '预览确认', '坐标配准', '确认归属', '完成'] as const;
const step = ref(0);

const encoding = ref<string>('auto');
/** 是否展开块参照（INSERT/ATTRIB）。默认 false：整体跳过块参照（家具/洁具/门窗等多为块，是噪音来源） */
const expandBlocks = ref<boolean>(false);

const buildingName = ref<string>(props.defaultBuilding || props.buildingNames[0] || '');
const floorNo = ref<number>(1);

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

const importedFloors = computed(() => store.floorsOf(buildingName.value));

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
  const fp = store.buildingFingerprint(buildingName.value);
  return (fp.outline as [number, number][] | undefined) ?? null;
});

const matchResult = computed<MatchResult | null>(() => {
  const it = activeItem.value;
  const p = it?.result;
  if (!p || !p.floorOutline || it?.coordSource !== 'utm') return null;
  const fpRaw = fingerprintFromOutline(p.floorOutline.polygon);
  if (!fpRaw.centerUtm) return null;
  return store.matchByFingerprint({
    centerUtm: fpRaw.centerUtm,
    area: fpRaw.footprintArea ?? 0,
    azimuth: fpRaw.azimuth ?? 0,
  });
});

function applyMatch() {
  const r = matchResult.value;
  if (r && r.candidates.length === 1) {
    buildingName.value = r.candidates[0];
    ElMessage.success(`已采用自动匹配楼栋：${r.candidates[0]}`);
  }
}

// ---- 弹窗打开时重置向导 ----
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      step.value = 0;
      items.value = [];
      activeId.value = null;
      encoding.value = 'auto';
      expandBlocks.value = false;
      buildingName.value = props.defaultBuilding || props.buildingNames[0] || '';
      floorNo.value = 1;
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

/** 主线程兜底解析（无 Worker 时） */
async function parseOnMain(
  buffer: ArrayBuffer,
  enc: string,
  onPhase: (p: 'decoding' | 'parsing') => void,
): Promise<DxfParseResult> {
  onPhase('decoding');
  const text = await decodeBuffer(buffer, enc);
  onPhase('parsing');
  const mod = await import('../utils/dxfParser');
  return mod.parseDxfToResult(text, '', 0, { expandBlocks: expandBlocks.value });
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
    pending.set(id, { resolve, reject, onPhase });
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
    item.result = result;
    item.coordSource = result.coordSource;
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
  const item: UploadItem = {
    id: nextUid(),
    name: raw.name,
    size: raw.size,
    status: 'received',
  };
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
    item.result = result;
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
const previewConfirmed = ref(false);
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

// 离开步骤 4 或切换激活文件时，清除确认状态（需重新确认）
watch([step, activeId], ([s]) => {
  if (s !== 3) previewConfirmed.value = false;
});
watch(activeId, () => {
  previewConfirmed.value = false;
});

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

// ---- 向导导航 ----
const canNext = computed(() => {
  if (step.value === 0) return doneItems.value.length > 0;
  // 步骤 2 校验：存在硬错误（仅 C1）则阻断前进
  if (step.value === 1) return Boolean(activeItem.value?.result) && !validation.value?.hasError;
  // 步骤 4 预览确认：必须用户显式确认提取结果无误
  if (step.value === 3) return Boolean(activeItem.value?.result) && previewConfirmed.value;
  return Boolean(activeItem.value?.result);
});

function next(): void {
  if (step.value < STEP_TITLES.length - 1) step.value += 1;
}
function prev(): void {
  if (step.value > 0) step.value -= 1;
}

async function onConfirm(): Promise<void> {
  const it = activeItem.value;
  if (!it?.result || !it.buffer) {
    ElMessage.warning('请先上传并解析 DXF 图纸');
    return;
  }
  if (!buildingName.value) {
    ElMessage.warning('请选择楼栋');
    return;
  }
  const payload = {
    buildingName: buildingName.value,
    floorNo: floorNo.value,
    fileName: it.name,
    parsed: it.result,
    coordSource: it.coordSource ?? it.result.coordSource,
    transform: it.coordSource === 'local' ? it.transform : undefined,
    dxfBytes: it.buffer,
  };
  try {
    const fid = store.importFloor(payload);
    const fp = store.buildingFingerprint(buildingName.value);
    if (fp.centerUtm) {
      ElMessage.success(
        `已导入 ${buildingName.value} ${floorNo.value}F（${selectedCount.value} 间），并写回楼栋指纹`,
      );
    } else {
      ElMessage.success(`已导入 ${buildingName.value} ${floorNo.value}F（${selectedCount.value} 间）`);
    }
    emit('imported', fid);
    // 该文件已入库，移出队列；若还有未处理文件可继续
    items.value = items.value.filter((i) => i.id !== it.id);
    activeId.value = doneItems.value[0]?.id ?? null;
    step.value = 0;
    if (items.value.length === 0) visible.value = false;
  } catch (err) {
    ElMessage.error(`导入失败：${(err as Error).message ?? '未知错误'}`);
  }
}

function onRemoveFloor(f: number): void {
  store.removeFloor(buildingName.value, f);
  ElMessage.info(`已删除 ${buildingName.value} ${f}F`);
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
    <el-steps :active="step" finish-status="success" align-center class="dxf-steps">
      <el-step v-for="t in STEP_TITLES" :key="t" :title="t" />
    </el-steps>

    <div class="dxf-body">
      <!-- 步骤 0 上传 -->
      <section v-if="step === 0" class="dxf-panel">
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
          <div v-for="item in items" :key="item.id" class="dxf-fileitem">
            <div class="dxf-fileitem__head">
              <span class="dxf-fileitem__name">{{ item.name }}</span>
              <el-tag :type="statusTagType(item.status)" size="small">{{ STATUS_TEXT[item.status] }}</el-tag>
              <el-button link type="danger" size="small" @click="removeItem(item.id)">移除</el-button>
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
          <span class="dxf-label">当前处理：</span>
          <el-select v-model="activeId" placeholder="选择要配准的文件" class="dxf-control">
            <el-option v-for="i in doneItems" :key="i.id" :label="i.name" :value="i.id" />
          </el-select>
        </div>
      </section>

      <!-- 步骤 1 校验（C1–C6：区分 error 硬错误 / warn 软警告 / info 提示；仅 error 阻断） -->
      <section v-else-if="step === 1 && activeItem?.result" class="dxf-panel">
        <div class="dxf-row dxf-row--wrap">
          <label class="dxf-label">坐标来源</label>
          <el-radio-group :model-value="activeItem.coordSource" @change="onCoordSourceChange">
            <el-radio value="local">局部坐标</el-radio>
            <el-radio value="utm">UTM 49N</el-radio>
          </el-radio-group>
          <span class="dxf-tip">识别单位：{{ activeItem.result.unit === 'mm' ? '毫米' : activeItem.result.unit === 'm' ? '米' : '未知' }}</span>
        </div>

        <div class="dxf-row dxf-row--wrap">
          <label class="dxf-label">编码</label>
          <el-select v-model="encoding" class="dxf-enc" placeholder="文本编码">
            <el-option label="自动（UTF-8 / GBK）" value="auto" />
            <el-option label="UTF-8" value="utf-8" />
            <el-option label="GBK" value="gbk" />
            <el-option label="GB2312" value="gb2312" />
          </el-select>
          <span class="dxf-tip">切换后当前文件将按新编码重新解析</span>
        </div>

        <div class="dxf-row dxf-row--wrap">
          <label class="dxf-label">块参照</label>
          <el-checkbox v-model="expandBlocks">展开块参照（INSERT/ATTRIB）</el-checkbox>
          <span class="dxf-tip">勾选后重新解析并保留块属性文字（默认跳过，家具/门窗等多为块噪音）</span>
        </div>

        <div v-if="validation" class="dxf-checks">
          <div class="dxf-checks__head">
            <span>校验结果（C1–C6）</span>
            <span class="dxf-checks__summary">
              <em v-if="validation.hasError" class="is-err">存在硬错误，须修正后才能继续</em>
              <em v-else-if="validation.hasWarn" class="is-warn">{{ validation.checks.filter((c) => c.level === 'warn').length }} 项警告（可继续）</em>
              <em v-else class="is-ok">全部通过</em>
            </span>
          </div>
          <div
            v-for="c in validation.checks"
            :key="c.code"
            class="dxf-check"
            :class="`dxf-check--${c.level}`"
          >
            <span class="dxf-check__badge">{{ c.code }}</span>
            <span class="dxf-check__icon">
              {{ c.level === 'error' ? '✕' : c.level === 'warn' ? '⚠' : c.level === 'info' ? 'ℹ' : '✓' }}
            </span>
            <span class="dxf-check__msg">{{ c.message }}</span>
          </div>
        </div>
      </section>

      <!-- 步骤 3 解析（Worker 内 extractRooms 输出 DxfParseResult：warnings / bbox / coordSource / unit） -->
      <section v-else-if="step === 2 && activeItem?.result" class="dxf-panel">
        <!-- 解析结果摘要：rooms / unit / coordSource / bbox / layers -->
        <div class="dxf-parse-summary">
          <div class="dxf-parse-summary__title">解析结果（extractRooms 输出）</div>
          <div class="dxf-parse-summary__grid">
            <div class="dxf-parse-cell">
              <span class="dxf-parse-cell__k">识别房间</span>
              <span class="dxf-parse-cell__v">{{ activeItem.result.rooms.length }} 个</span>
            </div>
            <div class="dxf-parse-cell">
              <span class="dxf-parse-cell__k">单位</span>
              <span class="dxf-parse-cell__v">{{ unitLabel }}</span>
            </div>
            <div class="dxf-parse-cell">
              <span class="dxf-parse-cell__k">坐标来源</span>
              <span class="dxf-parse-cell__v">{{ coordLabel }}</span>
            </div>
            <div class="dxf-parse-cell">
              <span class="dxf-parse-cell__k">包围盒尺寸</span>
              <span class="dxf-parse-cell__v">{{ bboxLabel }}</span>
            </div>
            <div class="dxf-parse-cell">
              <span class="dxf-parse-cell__k">识别图层</span>
              <span class="dxf-parse-cell__v">{{ activeItem.result.layers.length }} 个</span>
            </div>
          </div>
        </div>

        <!-- 解析告警（DxfParseResult.warnings） -->
        <div v-if="activeItem.result.warnings.length" class="dxf-parse-warn">
          <div class="dxf-parse-warn__title">解析告警（{{ activeItem.result.warnings.length }} 条）</div>
          <div
            v-for="(w, i) in activeItem.result.warnings"
            :key="i"
            class="dxf-parse-warn__item"
            :class="`is-${w.level}`"
          >
            <span class="dxf-parse-warn__badge">{{ w.code }}</span>
            <span class="dxf-parse-warn__msg">{{ w.message }}</span>
          </div>
        </div>

        <!-- 房间清单（勾选需入库；extractRooms 产物） -->
        <div class="dxf-parse-rooms">
          <div class="dxf-parse-rooms__head">
            <span>房间清单（勾选需入库，已选 {{ selectedCount }} / {{ activeItem.result.rooms.length }}）</span>
          </div>
          <div class="dxf-roomlist">
            <div
              v-for="(room, idx) in activeItem.result.rooms"
              :key="room.id"
              class="dxf-room"
              :class="{ 'dxf-room--off': !room.selected }"
            >
              <el-checkbox v-model="room.selected" />
              <span class="dxf-room__no">{{ room.code || `房间${idx + 1}` }}</span>
              <span class="dxf-room__name">{{ room.name }}</span>
              <span
                class="dxf-room__tag"
                :class="room.inspectStatus === 'partial' ? 'is-warn' : ''"
              >{{ room.inspectStatus === 'partial' ? '待补填' : room.inspectStatus === 'highlight' ? '需复核' : '正常' }}</span>
              <span class="dxf-room__area">{{ room.area.toFixed(1) }}</span>
            </div>
          </div>
          <el-alert
            v-if="!activeItem.result.rooms.length"
            class="dxf-preview"
            type="warning"
            :closable="false"
            title="未解析到房间轮廓，请检查 DXF 是否含闭合的「内部结构内墙线」图层"
          />
        </div>
      </section>

      <!-- 步骤 4 预览确认（用 FloorPlan2D 渲染提取结果；左侧清单剔除/补填，右侧 2.5D 预览） -->
      <section v-else-if="step === 3 && activeItem?.result" class="dxf-panel dxf-panel--preview4">
        <!-- 顶部统计 -->
        <div class="dxf-stat">
          <span>识别房间 <b>{{ roomFieldStats.N }}</b> 间</span>
          <span class="is-ok">字段完整 <b>{{ roomFieldStats.X }}</b> 间</span>
          <span class="is-warn">待补填 <b>{{ roomFieldStats.Y }}</b> 间</span>
          <span v-if="roomFieldStats.excluded" class="is-muted">已剔除误识别 <b>{{ roomFieldStats.excluded }}</b> 间</span>
        </div>

        <div class="dxf-preview4__body">
          <!-- 左侧房间清单 -->
          <div class="dxf-preview4__list">
            <div class="dxf-preview4__list-head">房间清单（取消勾选即剔除误识别房间）</div>
            <div class="dxf-roomlist dxf-roomlist--tall">
              <div
                v-for="(room, idx) in activeItem.result.rooms"
                :key="room.id"
                class="dxf-room"
                :class="{ 'dxf-room--off': room.selected === false }"
              >
                <el-checkbox v-model="room.selected" />
                <span class="dxf-room__no">{{ room.code || `房间${idx + 1}` }}</span>
                <span class="dxf-room__name">{{ room.name || '（未命名）' }}</span>
                <span
                  class="dxf-room__tag"
                  :class="room.inspectStatus === 'partial' ? 'is-warn' : room.inspectStatus === 'highlight' ? 'is-info' : room.inspectStatus === 'warning' ? 'is-err' : ''"
                >{{ room.inspectStatus === 'partial' ? '待补填' : room.inspectStatus === 'highlight' ? '需复核' : room.inspectStatus === 'warning' ? '警告' : '正常' }}</span>
                <el-button link type="primary" size="small" @click="openEditor(room)">补填</el-button>
              </div>
            </div>
          </div>

          <!-- 右侧 FloorPlan2D 预览 -->
          <div class="dxf-preview4__map">
            <FloorPlan2D
              :embedded="true"
              :preview="{ rooms: activeItem.result.rooms, outline: activeItem.result.floorOutline?.polygon ?? null }"
              @room-click="openEditor"
            />
          </div>
        </div>

        <!-- 确认门控：必须勾选后才允许进入下一步 -->
        <el-checkbox v-model="previewConfirmed" class="dxf-confirm">
          我已确认提取结果无误（已剔除的房间将不入库，字段已补填 / 核对）
        </el-checkbox>

        <!-- 6 字段补填 / 修正抽屉 -->
        <el-drawer
          v-model="drawerOpen"
          :title="editingRoom ? `补填 / 修正：${editingRoom.code || editingRoom.name}` : '房间字段'"
          size="360px"
          @close="closeEditor"
        >
          <template v-if="editingRoom">
            <el-form label-width="84px">
              <el-form-item label="房间编码">
                <el-input v-model="editingRoom.code" placeholder="如 101" />
              </el-form-item>
              <el-form-item label="房间号码">
                <el-input v-model="editingRoom.number" placeholder="如 101" />
              </el-form-item>
              <el-form-item label="房间名称">
                <el-input v-model="editingRoom.name" placeholder="如 办公室" />
              </el-form-item>
              <el-form-item label="部门名称">
                <el-input v-model="editingRoom.dept" placeholder="如 保卫处" />
              </el-form-item>
              <el-form-item label="使用面积">
                <el-input-number
                  v-model="editingRoom.useArea"
                  :min="0"
                  :step="1"
                  controls-position="right"
                  style="width: 100%"
                />
              </el-form-item>
              <el-form-item label="建筑面积">
                <el-input-number
                  v-model="editingRoom.buildArea"
                  :min="0"
                  :step="1"
                  controls-position="right"
                  style="width: 100%"
                />
              </el-form-item>
            </el-form>
            <div class="dxf-drawer__actions">
              <el-button
                v-if="editingRoom.selected !== false"
                type="danger"
                plain
                @click="toggleExclude(editingRoom, true); closeEditor()"
              >标记为误识别并剔除</el-button>
              <el-button v-else type="primary" plain @click="toggleExclude(editingRoom, false); closeEditor()">
                恢复保留
              </el-button>
            </div>
            <p class="dxf-drawer__hint">修改即时生效；确认无误后勾选底部「已确认」再进入下一步。</p>
          </template>
        </el-drawer>
      </section>

      <!-- 步骤 4 坐标配准 -->
      <section v-else-if="step === 4 && activeItem?.result" class="dxf-panel">
        <el-alert
          v-if="activeItem.coordSource === 'local'"
          class="dxf-preview"
          type="info"
          :closable="false"
          title="局部坐标图纸：不进行指纹自动匹配，请通过下方「2 对同名锚点」完成手动配准后再入库"
        />
        <AnchorPicker
          v-if="activeItem.coordSource === 'local'"
          v-model="activeItem.transform"
          :unit="activeItem.result.unit"
          :floor-outline-local="floorOutlineLocal"
          :rooms-local="roomsLocal"
          :footprint-utm="footprintUtm"
        />
        <template v-else>
          <el-alert
            v-if="matchResult"
            class="dxf-preview"
            :type="matchResult.status === 'strong' ? 'success' : matchResult.status === 'weak' ? 'warning' : 'error'"
            :closable="false"
          >
            <template #title>
              <span>楼栋自动匹配（{{ matchResult.status === 'strong' ? '强匹配' : matchResult.status === 'weak' ? '弱匹配' : '未匹配' }}）：</span>
              <span v-if="matchResult.candidates.length">{{ matchResult.candidates.join('、') }}</span>
              <span v-else>无</span>
              <el-button
                v-if="matchResult.candidates.length === 1"
                link
                type="primary"
                size="small"
                style="margin-left: 8px"
                @click="applyMatch"
              >采用</el-button>
            </template>
            <template v-if="matchResult.reasons.length" #default>
              <div v-for="(rs, i) in matchResult.reasons" :key="i" class="dxf-match__reason">{{ rs }}</div>
            </template>
          </el-alert>
          <el-alert v-else class="dxf-preview" type="info" :closable="false" title="UTM 图纸：未识别「楼层外轮廓线」，无法自动匹配楼栋，请在下一步手动选择归属楼栋" />
        </template>
      </section>

      <!-- 步骤 5 确认归属 -->
      <section v-else-if="step === 5" class="dxf-panel">
        <div class="dxf-row">
          <label class="dxf-label">楼栋</label>
          <el-select v-model="buildingName" placeholder="选择楼栋" class="dxf-control">
            <el-option v-for="b in buildingNames" :key="b" :label="b" :value="b" />
          </el-select>
        </div>
        <div class="dxf-row">
          <label class="dxf-label">楼层</label>
          <el-input-number v-model="floorNo" :min="1" :max="99" controls-position="right" class="dxf-control" />
          <span class="dxf-unit">F</span>
        </div>

        <div v-if="importedFloors.length" class="dxf-list">
          <div class="dxf-list__title">已导入（{{ buildingName }}）</div>
          <div v-for="f in importedFloors" :key="f" class="dxf-list__item">
            <span>
              {{ f }}F · {{ store.roomsOfFloor(store.getFloor(buildingName, f)?.id ?? '').length }} 间
              · {{ store.getFloor(buildingName, f)?.status }}
            </span>
            <el-button link type="danger" size="small" @click="onRemoveFloor(f)">删除</el-button>
          </div>
        </div>
      </section>

      <!-- 步骤 6 完成 -->
      <section v-else-if="step === 6 && activeItem?.result" class="dxf-panel">
        <el-result icon="success" title="待入库确认" sub-title="点击下方「确认入库」完成本次导入">
          <template #extra>
            <div class="dxf-final">
              <div>文件：{{ activeItem.name }}</div>
              <div>归属：{{ buildingName }} {{ floorNo }}F</div>
              <div>房间：{{ selectedCount }} / {{ activeItem.result.rooms.length }} 间</div>
              <div>坐标来源：{{ activeItem.coordSource === 'utm' ? 'UTM 49N' : '局部坐标' }}</div>
            </div>
          </template>
        </el-result>
      </section>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button v-if="step > 0" @click="prev">上一步</el-button>
      <el-button
        v-if="step < STEP_TITLES.length - 1"
        type="primary"
        :disabled="!canNext"
        @click="next"
      >下一步</el-button>
      <el-button v-else type="primary" @click="onConfirm">确认入库</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.dxf-steps { margin-bottom: 18px; }
.dxf-body { min-height: 280px; }
.dxf-panel { display: flex; flex-direction: column; gap: 14px; }
.dxf-row { display: flex; align-items: center; gap: 12px; }
.dxf-row--col { flex-direction: column; align-items: stretch; gap: 8px; }
.dxf-row--wrap { flex-wrap: wrap; gap: 10px; }
.dxf-label { width: 56px; flex: 0 0 auto; color: #4b5563; font-size: 14px; }
.dxf-control { flex: 1 1 auto; }
.dxf-enc { width: 200px; }
.dxf-unit { color: #6b7280; }
.dxf-tip { font-size: 12px; color: #9ca3af; }
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
</style>
