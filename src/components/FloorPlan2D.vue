<script setup lang="ts">
/**
 * FloorPlan2D：楼层 2.5D 平面图查看器（SVG 渲染，Y 轴翻转）。
 *
 * 渲染规范（2026-09-21）：
 * - 数据坐标 X 东 / Y 北，SVG 的 Y 向下，故做 Y 翻转：
 *     scale = min(viewW/(maxX-minX), viewH/(maxY-minY)) * 0.95
 *     toScreen(p) = [ (p[0]-minX)*scale + padX, (maxY-p[1])*scale + padY ]
 * - 每个房间渲染为 2.5D 立体块：底面淡描边（定位参照）+ 四壁拉伸出的侧壁（深色）+ 抬升后的顶面（房间配色 + 阴影）。
 *   墙面高度由 wallLift（「墙高」滑杆，默认 14px，仅「稍微拉伸」）控制；按底面质心 y 做画家算法排序保证遮挡正确。
 * - 房间中央文字按屏幕面积从大到小降级：房间号码(14px 粗) / 房间名称(10px) /
 *   部门(9px 灰) / 使用面积(9px 白底圆角)。
 * - 配色（按审图状态）：normal=#AED6F1，highlight=#C0392B，warning=#8E44AD，
 *   partial(字段缺失)=#F5B041。
 * - hover 高亮 + el-tooltip 显示全部 6 字段（房间号/名称/部门/用途/使用面积/建筑面积）。
 * - 楼层切换 tabs（F1/F2/...），切换时保留缩放/平移状态。
 *
 * 两种模式：
 * - store 模式（弹窗）：楼层 Tab + 着色模式切换 + 侧栏详情 + 业务状态分配。
 * - 预览嵌入模式（embedded + preview）：不渲染 el-dialog，仅渲染 SVG stage，
 *   数据源为入库前候选（ParsedRoom[]），点击房间 emit('room-click') 交由导入向导编辑。
 */
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { CircleCloseFilled, WarningFilled } from '@element-plus/icons-vue';
import { useBuildingStore } from '../stores/building';
import { polygonArea } from '../utils/geometry';
import { isRoomFieldComplete } from '../utils/roomFields';
import type { InspectStatus, ParsedRoom, Room, UseStatus } from '../types/cad';

const props = withDefaults(
  defineProps<{
    modelValue?: boolean;
    buildingName?: string;
    /** 预览嵌入模式：传入即渲染预览（不显示 el-dialog） */
    preview?: { rooms: ParsedRoom[]; outline?: [number, number][] | null } | null;
    embedded?: boolean;
  }>(),
  { modelValue: false, buildingName: '', preview: null, embedded: false },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'request-import'): void;
  (e: 'room-click', room: ParsedRoom): void;
}>();

const store = useBuildingStore();

const VIEW_W = 920;
const VIEW_H = 640;
const FIT_MARGIN = 0.95; // 用户规范：scale * 0.95

type ColorMode = 'inspect' | 'use' | 'dept' | 'purpose';
/** store 模式使用 Room，预览模式使用 ParsedRoom；两者共享着色所需字段 */
type RoomLike = Room | ParsedRoom;

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const floors = computed(() => store.floorsOf(props.buildingName ?? ''));
const selectedFloor = ref<number>(1);
const colorMode = ref<ColorMode>('inspect');

// ---- 缩放 / 平移（楼层切换保留）----
// 注意：必须声明在下方 immediate watch 之前——该 watch 会在 setup 阶段同步调用
// resetView()，若 zoom/panX/panY 尚未初始化会触发 TDZ（Cannot access 'zoom' before initialization）。
const zoom = ref(1);
const panX = ref(0);
const panY = ref(0);
const stageRef = ref<HTMLElement | null>(null);
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 6;
/** 2.5D 墙面拉伸高度（屏幕 px；CSS transform 已含 zoom，故无需再乘 zoom）。
 *  默认 14：仅「稍微拉伸」，呈现一块块格子边被抬起、带立体厚度的 2.5D 平面图。 */
const wallLift = ref(14);

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 以 (cx,cy)（stage 内像素）为锚点缩放 */
function zoomAt(cx: number, cy: number, factor: number): void {
  const nz = clamp(zoom.value * factor, MIN_ZOOM, MAX_ZOOM);
  const real = nz / zoom.value;
  panX.value = cx - (cx - panX.value) * real;
  panY.value = cy - (cy - panY.value) * real;
  zoom.value = nz;
}

function onWheel(ev: WheelEvent): void {
  const stage = stageRef.value;
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, ev.deltaY < 0 ? 1.12 : 1 / 1.12);
}
function zoomBy(factor: number): void {
  const stage = stageRef.value;
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  zoomAt(rect.width / 2, rect.height / 2, factor);
}
function resetView(): void {
  zoom.value = 1;
  panX.value = 0;
  panY.value = 0;
}

const svgStyle = computed(() => ({
  transform: `translate(${panX.value}px, ${panY.value}px) scale(${zoom.value})`,
  transformOrigin: '0 0',
}));

watch(
  [() => props.modelValue, () => props.buildingName, floors],
  () => {
    if (props.modelValue && floors.value.length && !floors.value.includes(selectedFloor.value)) {
      selectedFloor.value = floors.value[0];
    }
    // 切换楼栋时重置视图；楼层切换不重置（满足「切换时保留缩放状态」）
    resetView();
  },
  { immediate: true },
);

const currentFloor = computed(() =>
  floors.value.length ? store.getFloor(props.buildingName ?? '', selectedFloor.value) : undefined,
);

const displayedRooms = computed<RoomLike[]>(() => {
  // 预览嵌入模式：返回全部候选（含 selected=false，将半透明渲染，不剔除）
  if (props.preview) return props.preview.rooms;
  const f = currentFloor.value;
  if (!f) return [];
  return store.roomsOfFloor(f.id);
});

// ---- 空状态 / 错误状态 / 部分成功状态（store 模式，针对当前选中楼层）----
const isFailed = computed(() => props.embedded ? false : currentFloor.value?.status === 'failed');
const isPartial = computed(() => props.embedded ? false : currentFloor.value?.status === 'partial');

/** partial 楼层的待补填项文案（缺字段房间数 + 待复核房间数） */
const missingText = computed(() => {
  const f = currentFloor.value;
  if (!f) return '';
  const list = store.roomsOfFloor(f.id);
  const incomplete = list.filter((r) => !isRoomFieldComplete(r as unknown as ParsedRoom)).length;
  const review =
    list.filter((r) => r.inspectStatus === 'highlight' || r.inspectStatus === 'warning').length;
  const parts: string[] = [];
  if (incomplete) parts.push(`字段待补填 ${incomplete} 间`);
  if (review) parts.push(`待复核 ${review} 间`);
  if (!parts.length) parts.push('仍有房间未完成质检');
  return `本层导入部分成功，${parts.join('、')}。`;
});

// ---- 着色 ----
const INSPECT_COLORS: Record<InspectStatus, string> = {
  normal: '#AED6F1',
  highlight: '#C0392B',
  warning: '#8E44AD',
  partial: '#F5B041',
};
const USE_COLORS: Record<Exclude<UseStatus, ''>, string> = {
  occupied: '#3b82f6',
  noaccess: '#f59e0b',
  vacant: '#22c55e',
};

const USE_LABELS: Record<UseStatus, string> = {
  occupied: '使用中',
  noaccess: '无权限',
  vacant: '空置',
  '': '未分配',
};
const INSPECT_LABELS: Record<InspectStatus, string> = {
  normal: '正常',
  highlight: '需复核',
  warning: '警告',
  partial: '待补填',
};

/** 预览模式强制按审图状态分色（in-progress 数据无业务状态） */
const effectiveColorMode = computed<ColorMode>(() => (props.embedded ? 'inspect' : colorMode.value));

function hslToHex(h: number, s: number, l: number): string {
  const a = (s * Math.min(l, 1 - l)) / 100;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** 颜色加深 amt∈[0,1]，用于由房间顶面色推导墙面（侧面）色，制造 2.5D 立体感 */
function darken(hex: string, amt: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  const r = Math.round(((n >> 16) & 255) * (1 - amt));
  const g = Math.round(((n >> 8) & 255) * (1 - amt));
  const b = Math.round((n & 255) * (1 - amt));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff;
  return Math.abs(h) % 360;
}

/** 兼容 Room.outline 与 ParsedRoom.polygon */
function polyOf(r: RoomLike): [number, number][] {
  return 'polygon' in r ? r.polygon : r.outline;
}

function colorFor(room: RoomLike): string {
  switch (effectiveColorMode.value) {
    case 'inspect':
      return INSPECT_COLORS[room.inspectStatus];
    case 'use':
      return room.useStatus ? USE_COLORS[room.useStatus] : '#cbd5e1';
    case 'dept':
      return room.dept ? hslToHex(hashHue(room.dept), 65, 55) : '#cbd5e1';
    case 'purpose':
      return room.usePurpose ? hslToHex(hashHue(room.usePurpose), 65, 55) : '#cbd5e1';
  }
}

// ---- 坐标变换（用户规范：Y 翻转 + 0.95 留白）----
const bounds = computed(() => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of displayedRooms.value) {
    for (const [x, y] of polyOf(r)) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
});

const fit = computed(() => {
  const b = bounds.value;
  const w = Math.max(b.maxX - b.minX, 1e-6);
  const h = Math.max(b.maxY - b.minY, 1e-6);
  // 2.5D 拉伸需预留顶部墙高空间，避免抬升后的顶面被裁切
  const lift = wallLift.value;
  const availH = VIEW_H - lift - 12;
  const scale = Math.min(VIEW_W / w, availH / h) * FIT_MARGIN;
  const padX = (VIEW_W - w * scale) / 2;
  // 向下偏移 lift，使拉伸后的顶面落在视图内
  const padY = lift + (availH - h * scale) / 2;
  return { scale, padX, padY };
});

function toScreen(p: [number, number]): [number, number] {
  const f = fit.value;
  const b = bounds.value;
  return [(p[0] - b.minX) * f.scale + f.padX, (b.maxY - p[1]) * f.scale + f.padY];
}

// ---- 房间文字标签 ----
interface LabelLine {
  text: string;
  size: number;
  weight: number;
  color: string;
  badge: boolean;
  y: number;
  rect: { x: number; y: number; w: number; h: number } | null;
}

/** 2.5D 拉伸后的单个房间绘制数据 */
interface WallFace {
  /** 侧壁 quad 的 points 串（a→b→tb→ta，底边拉起成的侧面） */
  points: string;
  fill: string;
}
interface ExtrudedShape {
  room: RoomLike;
  /** 抬升后的顶面多边形（points 串） */
  topPoints: string;
  /** 底面（淡描边，仅作定位参照） */
  bottomPoints: string;
  /** 各侧壁 quad（房间墙面被拉伸出的立体侧面） */
  walls: WallFace[];
  fill: string;
  stroke: string;
  /** 墙面（侧面）色：由顶面配色加深得到，制造立体感 */
  wallFill: string;
  dimmed: boolean;
  labelX: number;
  lines: LabelLine[];
}

/** 按屏幕面积分档，决定显示哪些文字（空间越小降级越多） */
function buildLabelLines(room: RoomLike, areaScreen: number): Omit<LabelLine, 'y' | 'rect'>[] {
  const code = room.code || room.number || room.name;
  let tier = 0;
  if (areaScreen >= 9000) tier = 3;
  else if (areaScreen >= 2500) tier = 2;
  else if (areaScreen >= 700) tier = 1;
  const lines: Omit<LabelLine, 'y' | 'rect'>[] = [];
  // 房间号码（14px 粗）——始终显示
  lines.push({ text: code, size: 14, weight: 700, color: '#1f2937', badge: false });
  // 房间名称（10px）——中/大空间
  if (tier >= 1 && room.name.trim() !== '') {
    lines.push({ text: room.name, size: 10, weight: 400, color: '#374151', badge: false });
  }
  // 部门（9px 灰）——大空间
  if (tier >= 2 && room.dept.trim() !== '') {
    lines.push({ text: room.dept, size: 9, weight: 400, color: '#6b7280', badge: false });
  }
  // 使用面积（9px 白底圆角）——最大空间
  if (tier >= 3 && room.useArea > 0) {
    lines.push({ text: `${room.useArea.toFixed(1)}㎡`, size: 9, weight: 600, color: '#111827', badge: true });
  }
  return lines;
}

const roomShapes = computed<ExtrudedShape[]>(() => {
  const lift = wallLift.value;
  const LINE_GAP = 14;
  const fmt = (p: [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  const raw = displayedRooms.value.map((room) => {
    // base：底面（原始平面，未拉伸）；top：向上抬升 lift 像素后的顶面
    const base = polyOf(room).map(toScreen);
    const top = base.map(([x, y]) => [x, y - lift] as [number, number]);
    const topPoints = top.map(fmt).join(' ');
    const bottomPoints = base.map(fmt).join(' ');
    const color = colorFor(room);
    // 墙面（侧面）色 = 顶面配色加深 0.22，立体感来自此
    const wallFill = darken(color, 0.22);
    const walls: WallFace[] = [];
    for (let i = 0; i < base.length; i++) {
      const a = base[i];
      const b = base[(i + 1) % base.length];
      const ta = top[i];
      const tb = top[(i + 1) % top.length];
      // 每条底边拉起的侧壁 quad（a→b→tb→ta）
      walls.push({ points: `${fmt(a)} ${fmt(b)} ${fmt(tb)} ${fmt(ta)}`, fill: wallFill });
    }
    // 标签锚点放在抬升后的顶面质心
    const cBottom = toScreen(room.centroid);
    const cTop: [number, number] = [cBottom[0], cBottom[1] - lift];
    const areaScreen = polygonArea(top);
    const baseLines = buildLabelLines(room, areaScreen);
    const startY = cTop[1] - ((baseLines.length - 1) * LINE_GAP) / 2;
    const lines: LabelLine[] = baseLines.map((ln, i) => {
      const y = startY + i * LINE_GAP;
      let rect: LabelLine['rect'] = null;
      if (ln.badge) {
        const w = Math.max(ln.text.length * ln.size * 0.62 + 8, 22);
        const h = ln.size + 6;
        rect = { x: cTop[0] - w / 2, y: y - h / 2, w, h };
      }
      return { ...ln, y, rect };
    });
    return {
      room,
      topPoints,
      bottomPoints,
      walls,
      fill: color,
      stroke: color,
      wallFill,
      dimmed: room.selected !== false,
      labelX: cTop[0],
      lines,
    };
  });
  // 画家算法：按底面质心屏幕 y 升序（上方=后方先画），保证拉伸块前后遮挡正确
  raw.sort((p, q) => toScreen(p.room.centroid)[1] - toScreen(q.room.centroid)[1]);
  return raw;
});

/** 楼层外轮廓（预览模式绘制为虚线参照） */
const outlinePath = computed<string>(() => {
  const poly =
    props.embedded && props.preview
      ? (props.preview.outline ?? null)
      : currentFloor.value?.outline ?? null;
  if (!poly || poly.length < 2) return '';
  return (
    poly
      .map((p, i) => {
        const q = toScreen(p);
        return `${i === 0 ? 'M' : 'L'}${q[0].toFixed(1)},${q[1].toFixed(1)}`;
      })
      .join(' ') + ' Z'
  );
});

const legend = computed(() => {
  if (effectiveColorMode.value === 'inspect') {
    return (Object.keys(INSPECT_COLORS) as InspectStatus[]).map((k) => ({
      label: INSPECT_LABELS[k],
      color: INSPECT_COLORS[k],
    }));
  }
  if (effectiveColorMode.value === 'use') {
    return (Object.keys(USE_COLORS) as Exclude<UseStatus, ''>[])
      .map((k) => ({ label: USE_LABELS[k], color: USE_COLORS[k] }))
      .concat([{ label: USE_LABELS[''], color: '#cbd5e1' }]);
  }
  // dept / purpose：取实际出现的类别
  const map = new Map<string, string>();
  for (const r of displayedRooms.value) {
    const key = effectiveColorMode.value === 'dept' ? r.dept : r.usePurpose;
    if (key) map.set(key, colorFor(r));
  }
  if (!map.size) map.set('（无）', '#cbd5e1');
  return [...map.entries()].map(([label, color]) => ({ label, color }));
});

// ---- 交互：hover / 选中 / tooltip ----
const hoveredId = ref<string | null>(null);
const selectedId = ref<string | null>(null);
const hoveredRoom = ref<RoomLike | null>(null);
const tipVisible = ref(false);
const tipPos = ref({ x: 0, y: 0 });
/** 虚拟触发锚点：el-tooltip 以此矩形定位（viewport 坐标） */
const tipMeasurable = {
  getBoundingClientRect: () => {
    const { x, y } = tipPos.value;
    return {
      x,
      y,
      left: x,
      top: y,
      right: x,
      bottom: y,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect;
  },
};

function onEnter(room: RoomLike, ev: MouseEvent): void {
  hoveredId.value = room.id;
  hoveredRoom.value = room;
  const r = (ev.currentTarget as SVGGraphicsElement).getBoundingClientRect();
  tipPos.value = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  tipVisible.value = true;
}
function onLeave(): void {
  hoveredId.value = null;
  hoveredRoom.value = null;
  tipVisible.value = false;
}

const selectedRoom = computed(() => displayedRooms.value.find((r) => r.id === selectedId.value) ?? null);

function onSelect(room: RoomLike): void {
  if (props.embedded) {
    emit('room-click', room as ParsedRoom);
    return;
  }
  selectedId.value = selectedId.value === room.id ? null : room.id;
}

function setUseStatus(status: UseStatus): void {
  const f = currentFloor.value;
  if (!f || !selectedRoom.value) return;
  store.setRoomUseStatus(f.id, selectedRoom.value.id, status);
}
function hideRoom(): void {
  const f = currentFloor.value;
  if (!f || !selectedRoom.value) return;
  store.setRoomSelected(f.id, selectedRoom.value.id, false);
  selectedId.value = null;
}
function showAll(): void {
  const f = currentFloor.value;
  if (!f) return;
  for (const r of store.roomsOfFloor(f.id)) store.setRoomSelected(f.id, r.id, true);
}

/** 预览模式下：剔除 / 恢复房间（直接改 preview.rooms 上的 selected） */
function previewToggleSelected(room: ParsedRoom, selected: boolean): void {
  if (!props.preview) return;
  const target = props.preview.rooms.find((r) => r.id === room.id);
  if (target) target.selected = selected;
}

function requestImport(): void {
  emit('request-import');
}

// ---- 继续补填（partial 楼层）：编辑并保存房间字段 ----
const fillMode = ref(false);
const editRoom = reactive({
  code: '',
  number: '',
  name: '',
  dept: '',
  usePurpose: '',
  useArea: '',
  buildArea: '',
});

/** 进入补填模式：切到审图着色、自动选中第一个待补填房间 */
function startFill(): void {
  fillMode.value = true;
  colorMode.value = 'inspect';
  const f = currentFloor.value;
  if (!f) return;
  const list = store.roomsOfFloor(f.id);
  const first =
    list.find(
      (r) =>
        !isRoomFieldComplete(r as unknown as ParsedRoom) ||
        r.inspectStatus === 'highlight' ||
        r.inspectStatus === 'partial' ||
        r.inspectStatus === 'warning',
    ) ?? list[0];
  if (first) selectedId.value = first.id;
}

/** 选中房间变化时，把字段载入编辑表单 */
watch(
  selectedRoom,
  (r) => {
    if (!r) return;
    editRoom.code = r.code;
    editRoom.number = r.number;
    editRoom.name = r.name;
    editRoom.dept = r.dept;
    editRoom.usePurpose = r.usePurpose;
    editRoom.useArea = String(r.useArea);
    editRoom.buildArea = String(r.buildArea);
  },
  { immediate: true },
);

function saveEdit(): void {
  const f = currentFloor.value;
  const r = selectedRoom.value;
  if (!f || !r) return;
  store.updateRoom(f.id, r.id, {
    code: editRoom.code.trim(),
    number: editRoom.number.trim() || editRoom.code.trim(),
    name: editRoom.name.trim(),
    dept: editRoom.dept.trim(),
    usePurpose: editRoom.usePurpose.trim(),
    useArea: Number(editRoom.useArea) || 0,
    buildArea: Number(editRoom.buildArea) || 0,
  });
  ElMessage.success('已保存房间信息');
}

// ---- 缩放 / 平移 相关函数与状态已在上方（immediate watch 之前）声明，避免 TDZ ----
</script>

<template>
  <el-dialog
    v-if="!embedded"
    v-model="visible"
    :title="`${buildingName} · 楼宇分层图（2.5D）`"
    width="80%"
    top="5vh"
    class="fpv-dialog"
  >
    <el-empty v-if="!floors.length" description="暂无室内图纸，请先导入">
      <el-button type="primary" @click="requestImport">导入图纸</el-button>
    </el-empty>

    <div v-else class="fpv">
      <div class="fpv__top">
        <div class="fpv__floors">
          <button
            v-for="f in floors"
            :key="f"
            class="fpv__floor-btn"
            :class="{ active: f === selectedFloor }"
            @click="selectedFloor = f; selectedId = null"
          >
            {{ f }}F
          </button>
        </div>
        <div class="fpv__modes">
          <span class="fpv__modes-label">着色</span>
          <el-radio-group v-model="colorMode" size="small">
            <el-radio-button value="use">业务状态</el-radio-button>
            <el-radio-button value="inspect">审图状态</el-radio-button>
            <el-radio-button value="dept">按部门</el-radio-button>
            <el-radio-button value="purpose">按用途</el-radio-button>
          </el-radio-group>
        </div>
        <div class="fpv__zoom">
          <span class="fpv__modes-label">墙高</span>
          <el-slider v-model="wallLift" :min="0" :max="60" :step="2" :show-tooltip="false" class="fpv__lift" />
          <el-button-group>
            <el-button size="small" title="放大" @click="zoomBy(1.2)">＋</el-button>
            <el-button size="small" title="缩小" @click="zoomBy(1 / 1.2)">－</el-button>
            <el-button size="small" title="复位视图" @click="resetView">复位</el-button>
          </el-button-group>
        </div>
        <el-button link type="primary" class="fpv__import" @click="requestImport">+ 导入图纸</el-button>
      </div>

      <div v-if="isFailed" class="fpv-state fpv-state--failed">
        <el-icon class="fpv-state__icon"><CircleCloseFilled /></el-icon>
        <div class="fpv-state__body">
          <div class="fpv-state__title">该楼层导入失败</div>
          <div class="fpv-state__desc">{{ currentFloor?.errorReason || '未知错误' }}</div>
        </div>
        <el-button type="primary" @click="requestImport">重新上传</el-button>
      </div>
      <template v-else>
        <div v-if="isPartial" class="fpv-state fpv-state--partial">
          <el-icon class="fpv-state__icon"><WarningFilled /></el-icon>
          <div class="fpv-state__body">
            <div class="fpv-state__title">导入部分完成</div>
            <div class="fpv-state__desc">{{ missingText }}</div>
          </div>
          <el-button type="warning" plain @click="startFill">继续补填</el-button>
        </div>

        <div class="fpv-main">
          <div class="fpv-stage" ref="stageRef" @wheel.prevent="onWheel">
          <svg
            :viewBox="`0 0 ${VIEW_W} ${VIEW_H}`"
            class="fpv-svg"
            :style="svgStyle"
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              <filter id="roomShadow" x="-30%" y="-30%" width="160%" height="160%">
                <feDropShadow dx="0" dy="2" stdDeviation="2.2" flood-color="#0f172a" flood-opacity="0.22" />
              </filter>
            </defs>
            <rect x="0" y="0" :width="VIEW_W" :height="VIEW_H" fill="#fbfcfe" />
            <path
              v-if="outlinePath"
              :d="outlinePath"
              fill="none"
              stroke="#94a3b8"
              stroke-width="2"
              stroke-dasharray="8 6"
              opacity="0.8"
            />
            <g
              v-for="shape in roomShapes"
              :key="shape.room.id"
              class="fpv-room"
              :opacity="shape.dimmed ? 0.16 : 1"
              @mouseenter="onEnter(shape.room, $event)"
              @mouseleave="onLeave"
              @click="onSelect(shape.room)"
            >
              <!-- 底面淡描边：仅作定位参照 -->
              <polygon :points="shape.bottomPoints" fill="none" :stroke="shape.stroke" stroke-width="0.6" opacity="0.25" />
              <!-- 侧壁：房间墙面被拉伸出的立体侧面 -->
              <polygon
                v-for="(w, wi) in shape.walls"
                :key="'w' + wi"
                :points="w.points"
                :fill="w.fill"
                stroke="none"
              />
              <!-- 顶面：房间配色 + 阴影 -->
              <polygon
                :points="shape.topPoints"
                :fill="shape.fill"
                :stroke="shape.stroke"
                :stroke-width="hoveredId === shape.room.id ? 3 : 1.2"
                :filter="shape.dimmed ? undefined : 'url(#roomShadow)'"
              />
              <template v-for="(ln, i) in shape.lines" :key="'l' + i">
                <rect
                  v-if="ln.rect"
                  :x="ln.rect.x"
                  :y="ln.rect.y"
                  :width="ln.rect.w"
                  :height="ln.rect.h"
                  rx="7"
                  fill="#ffffff"
                  :stroke="shape.stroke"
                  stroke-width="0.5"
                />
                <text
                  :x="shape.labelX"
                  :y="ln.y"
                  text-anchor="middle"
                  :font-size="ln.size"
                  :font-weight="ln.weight"
                  :fill="ln.color"
                  dominant-baseline="middle"
                  pointer-events="none"
                >{{ ln.text }}</text>
              </template>
            </g>
          </svg>

          <el-tooltip
            v-model:visible="tipVisible"
            virtual-triggering
            :virtual-ref="tipMeasurable"
            placement="top"
            :show-after="0"
            :hide-after="0"
          >
            <template #content>
              <div v-if="hoveredRoom" class="fpv-tip">
                <div class="fpv-tip__no">{{ hoveredRoom.code || hoveredRoom.number || hoveredRoom.name }}</div>
                <div class="fpv-tip__row">名称：{{ hoveredRoom.name || '—' }}</div>
                <div class="fpv-tip__row">部门：{{ hoveredRoom.dept || '—' }}</div>
                <div class="fpv-tip__row">用途：{{ hoveredRoom.usePurpose || '—' }}</div>
                <div class="fpv-tip__row">使用面积：{{ hoveredRoom.useArea.toFixed(1) }} ㎡</div>
                <div class="fpv-tip__row">建筑面积：{{ hoveredRoom.buildArea.toFixed(1) }} ㎡</div>
              </div>
            </template>
          </el-tooltip>
          <p v-if="!roomShapes.length" class="fpv-embed-empty">暂无房间数据</p>
        </div>

        <div class="fpv-side">
          <div class="fpv-legend">
            <span v-for="l in legend" :key="l.label" class="fpv-legend__item">
              <i :style="{ background: l.color }"></i>{{ l.label }}
            </span>
          </div>
          <div class="fpv-info">
            <template v-if="selectedRoom">
              <div class="fpv-info__title">{{ selectedRoom.code || selectedRoom.name }} · {{ selectedRoom.name }}</div>

              <div v-if="fillMode" class="fpv-edit">
                <div class="fpv-edit__row"><label>房间号</label><el-input v-model="editRoom.code" size="small" /></div>
                <div class="fpv-edit__row"><label>名称</label><el-input v-model="editRoom.name" size="small" /></div>
                <div class="fpv-edit__row"><label>部门</label><el-input v-model="editRoom.dept" size="small" /></div>
                <div class="fpv-edit__row"><label>用途</label><el-input v-model="editRoom.usePurpose" size="small" /></div>
                <div class="fpv-edit__row"><label>使用面积</label><el-input v-model="editRoom.useArea" size="small" type="number" /></div>
                <div class="fpv-edit__row"><label>建筑面积</label><el-input v-model="editRoom.buildArea" size="small" type="number" /></div>
                <div class="fpv-info__actions">
                  <el-button type="primary" size="small" @click="saveEdit">保存</el-button>
                  <el-button size="small" @click="fillMode = false">取消</el-button>
                </div>
              </div>

              <dl v-else>
                <div><dt>房间号</dt><dd>{{ selectedRoom.code || '—' }}</dd></div>
                <div><dt>名称</dt><dd>{{ selectedRoom.name || '—' }}</dd></div>
                <div><dt>部门</dt><dd>{{ selectedRoom.dept || '—' }}</dd></div>
                <div><dt>用途</dt><dd>{{ selectedRoom.usePurpose || '—' }}</dd></div>
                <div><dt>使用面积</dt><dd>{{ selectedRoom.useArea.toFixed(1) }} ㎡</dd></div>
                <div><dt>建筑面积</dt><dd>{{ selectedRoom.buildArea.toFixed(1) }} ㎡</dd></div>
              </dl>
              <div class="fpv-info__actions">
                <el-button size="small" @click="setUseStatus('occupied')">使用中</el-button>
                <el-button size="small" @click="setUseStatus('noaccess')">无权限</el-button>
                <el-button size="small" @click="setUseStatus('vacant')">空置</el-button>
                <el-button size="small" text @click="setUseStatus('')">清空</el-button>
                <el-button v-if="isPartial" size="small" type="warning" plain @click="startFill">补填信息</el-button>
              </div>
              <div class="fpv-info__actions">
                <el-button size="small" type="danger" plain @click="hideRoom">隐藏此房间</el-button>
              </div>
            </template>
            <p v-else class="fpv-info__hint">点击房间查看详情 / 分配业务状态</p>
            <el-button size="small" link @click="showAll">显示全部房间</el-button>
          </div>
          <p class="fpv-note">* 面积为图纸坐标变换后的估算值（㎡）。</p>
        </div>
        </div>
      </template>
    </div>
  </el-dialog>

  <!-- 预览嵌入模式：仅渲染 SVG stage（供导入向导「预览确认」步骤使用） -->
  <div v-else class="fpv fpv--embed">
    <div class="fpv__top fpv__top--embed">
      <div class="fpv-legend fpv-legend--embed">
        <span v-for="l in legend" :key="l.label" class="fpv-legend__item">
          <i :style="{ background: l.color }"></i>{{ l.label }}
        </span>
      </div>
      <div class="fpv__zoom">
        <el-button-group>
          <el-button size="small" @click="zoomBy(1.2)">＋</el-button>
          <el-button size="small" @click="zoomBy(1 / 1.2)">－</el-button>
          <el-button size="small" @click="resetView">复位</el-button>
        </el-button-group>
      </div>
    </div>
    <div class="fpv-stage" ref="stageRef" @wheel.prevent="onWheel">
      <svg
        :viewBox="`0 0 ${VIEW_W} ${VIEW_H}`"
        class="fpv-svg fpv-svg--embed"
        :style="svgStyle"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <filter id="roomShadow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="2" stdDeviation="2.2" flood-color="#0f172a" flood-opacity="0.22" />
          </filter>
        </defs>
        <rect x="0" y="0" :width="VIEW_W" :height="VIEW_H" fill="#fbfcfe" />
        <path
          v-if="outlinePath"
          :d="outlinePath"
          fill="none"
          stroke="#94a3b8"
          stroke-width="2"
          stroke-dasharray="8 6"
          opacity="0.8"
        />
        <g
          v-for="shape in roomShapes"
          :key="shape.room.id"
          class="fpv-room"
          :opacity="shape.dimmed ? 0.16 : 1"
          @mouseenter="onEnter(shape.room, $event)"
          @mouseleave="onLeave"
          @click="onSelect(shape.room)"
        >
          <!-- 底面淡描边：仅作定位参照 -->
          <polygon :points="shape.bottomPoints" fill="none" :stroke="shape.stroke" stroke-width="0.6" opacity="0.25" />
          <!-- 侧壁：房间墙面被拉伸出的立体侧面 -->
          <polygon
            v-for="(w, wi) in shape.walls"
            :key="'w' + wi"
            :points="w.points"
            :fill="w.fill"
            stroke="none"
          />
          <!-- 顶面：房间配色 + 阴影 -->
          <polygon
            :points="shape.topPoints"
            :fill="shape.fill"
            :stroke="shape.stroke"
            :stroke-width="hoveredId === shape.room.id ? 3 : 1.2"
            :filter="shape.dimmed ? undefined : 'url(#roomShadow)'"
          />
          <template v-for="(ln, i) in shape.lines" :key="'l' + i">
            <rect
              v-if="ln.rect"
              :x="ln.rect.x"
              :y="ln.rect.y"
              :width="ln.rect.w"
              :height="ln.rect.h"
              rx="7"
              fill="#ffffff"
              :stroke="shape.stroke"
              stroke-width="0.5"
            />
            <text
              :x="shape.labelX"
              :y="ln.y"
              text-anchor="middle"
              :font-size="ln.size"
              :font-weight="ln.weight"
              :fill="ln.color"
              dominant-baseline="middle"
              pointer-events="none"
            >{{ ln.text }}</text>
          </template>
        </g>
      </svg>

      <el-tooltip
        v-model:visible="tipVisible"
        virtual-triggering
        :virtual-ref="tipMeasurable"
        placement="top"
        :show-after="0"
        :hide-after="0"
      >
        <template #content>
          <div v-if="hoveredRoom" class="fpv-tip">
            <div class="fpv-tip__no">{{ hoveredRoom.code || hoveredRoom.number || hoveredRoom.name }}</div>
            <div class="fpv-tip__row">名称：{{ hoveredRoom.name || '—' }}</div>
            <div class="fpv-tip__row">部门：{{ hoveredRoom.dept || '—' }}</div>
            <div class="fpv-tip__row">用途：{{ hoveredRoom.usePurpose || '—' }}</div>
            <div class="fpv-tip__row">使用面积：{{ hoveredRoom.useArea.toFixed(1) }} ㎡</div>
            <div class="fpv-tip__row">建筑面积：{{ hoveredRoom.buildArea.toFixed(1) }} ㎡</div>
          </div>
        </template>
      </el-tooltip>
      <p v-if="!roomShapes.length" class="fpv-embed-empty">所选房间均已剔除，左侧重新勾选即可恢复</p>
    </div>
  </div>
</template>

<style scoped>
.fpv-dialog :deep(.el-dialog__body) { padding-top: 8px; }
.fpv { display: flex; flex-direction: column; gap: 12px; }

/* 空 / 失败 / 部分成功 状态卡片 */
.fpv-state { display: flex; align-items: center; gap: 14px; padding: 18px 20px; border-radius: 10px; border: 1px solid transparent; }
.fpv-state__icon { font-size: 30px; flex-shrink: 0; }
.fpv-state__body { flex: 1; min-width: 0; }
.fpv-state__title { font-size: 15px; font-weight: 700; }
.fpv-state__desc { font-size: 13px; color: #6b7280; margin-top: 2px; line-height: 1.5; }
.fpv-state--failed { background: #fef2f2; border-color: #fecaca; }
.fpv-state--failed .fpv-state__icon { color: #dc2626; }
.fpv-state--failed .fpv-state__title { color: #b91c1c; }
.fpv-state--partial { background: #fffbeb; border-color: #fde68a; }
.fpv-state--partial .fpv-state__icon { color: #d97706; }
.fpv-state--partial .fpv-state__title { color: #b45309; }

/* 补填表单 */
.fpv-edit { display: flex; flex-direction: column; gap: 8px; margin: 4px 0 8px; }
.fpv-edit__row { display: flex; align-items: center; gap: 8px; }
.fpv-edit__row label { width: 56px; font-size: 13px; color: #6b7280; flex-shrink: 0; }
.fpv-edit__row :deep(.el-input) { flex: 1; }
.fpv__top { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.fpv__top--embed { justify-content: space-between; }
.fpv__floors { display: flex; flex-wrap: wrap; gap: 8px; }
.fpv__floor-btn {
  border: 1px solid #d0d5dd;
  background: #fff;
  color: #4b5563;
  border-radius: 7px;
  padding: 6px 14px;
  cursor: pointer;
  font-size: 13px;
}
.fpv__floor-btn.active { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; }
.fpv__modes { display: flex; align-items: center; gap: 8px; }
.fpv__modes-label { font-size: 13px; color: #6b7280; }
.fpv__zoom { display: flex; align-items: center; }
.fpv__import { margin-left: auto; }
.fpv-main { display: flex; gap: 12px; align-items: stretch; }
.fpv-stage { position: relative; flex: 1; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; background: #fbfcfe; }
.fpv-svg { display: block; width: 100%; height: 60vh; }
.fpv-room { cursor: pointer; }
.fpv-tip { line-height: 1.6; }
.fpv-tip__no { font-weight: 700; margin-bottom: 2px; }
.fpv-tip__row { font-size: 12px; white-space: nowrap; }
.fpv-side { display: flex; flex-direction: column; gap: 10px; width: 240px; flex-shrink: 0; }
.fpv-legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 13px; color: #4b5563; }
.fpv-legend__item { display: inline-flex; align-items: center; gap: 5px; }
.fpv-legend i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.fpv-info { border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px 14px; background: #fff; }
.fpv-info__title { font-size: 15px; font-weight: 700; color: #111827; margin-bottom: 6px; }
.fpv-info dl { margin: 0; }
.fpv-info dl div { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; border-bottom: 1px dashed #eef0f3; }
.fpv-info dl div:last-child { border-bottom: 0; }
.fpv-info dt { color: #6b7280; }
.fpv-info dd { margin: 0; color: #111827; }
.fpv-info__actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.fpv-info__hint { color: #9ca3af; font-size: 13px; margin: 0; }
.fpv-note { font-size: 11px; color: #9ca3af; margin: 0; }

/* 预览嵌入模式 */
.fpv--embed { gap: 8px; }
.fpv-legend--embed { padding: 4px 2px; }
.fpv-svg--embed { height: 46vh; }
.fpv-embed-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #9ca3af;
  font-size: 13px;
  pointer-events: none;
}
</style>
