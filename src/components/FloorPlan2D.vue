<script setup lang="ts">
/**
 * FloorPlan2D：楼层 2.5D 平面图查看器（SVG 渲染，正交俯视压缩 + 源对齐转正，底面恒为水平直角矩形、墙体竖直抬升成长方体）。
 *
 * 渲染规范：
 * - 渲染架构（建筑分层）：① 楼层外轮廓地面 + ② 走廊（外轮廓减房间，由③层房间覆盖得到）
 *   + ③ 房间平铺填充（z=0 地面，无侧面）+ ④ 墙侧面（外墙线/内墙线拉伸成 wallHeight 米高，先画）
 *   + ⑤ 墙顶面（后画）+ ⑥ 文字标签。墙体高度由「墙高(米)」滑杆驱动。
 * - 2.5D 投影（纯正交俯视压缩，无旋转 / 无剪切 / 无 3D 引擎依赖）：仅对深度 y 做等比压缩 k=cos(纵向俯仰角)，
 *   楼层按 DXF 真实朝向渲染，轴对齐矩形恒为矩形、阳角 90°；立体感来自暗色墙侧面 + 亮色顶面 + 按屏幕 Y 升序遮挡。
 *   纵向俯仰角由「纵向旋转」滑杆控制、默认 55°（k≈0.574，落在 0.55~0.65 推荐区间）。
 *     screenX = x                          （水平方向原样，房间宽度不变）
 *     screenY = y * k - z * Z_EXAG         （k=cos(俯仰)：深度等比压缩；z 为墙高抬升，向上为正）
 *   对角矩阵（screenX 只含 x、screenY 只含 y 与 z）：轴对齐矩形恒为矩形、阳角严格 90°，绝不退化成平行四边形/梯形（那需要旋转或透视除法，二者皆无）。
 *   screenX 不含任何 y 项；墙体保持竖直，墙体高度按 cos(Pitch) 投影，立体感来自底面后倾 + 墙高；
 *   缩放/居中由 fit 对整层（含墙顶 z=wallHeight）的投影包围盒计算；按墙体地面中点屏幕 Y 排序保证遮挡正确。
 * - 房间中央文字：房间号码(14px 粗) / 房间名称(10px) / 部门(9px 灰) / 使用面积(9px 白底圆角)。
 * - 配色（按审图状态）：normal=#AED6F1，highlight=#C0392B，warning=#8E44AD，
 *   partial(字段缺失)=#F5B041。
 * - 仅点击房间弹出小卡片（含修改 / 维护入口），不再使用 hover tooltip（避免遮挡与误触；点击容差 8px，点任意位置即可触发）。
 * - 墙段按「共线重叠合并」去重：相邻房间共用的同一堵墙、外轮廓与房间周界重合的边只绘制一次，避免双墙重叠。
 * - 楼层切换 tabs（F1/F2/...），切换时保留缩放/平移状态。
 *
 * 两种模式：
 * - store 模式（弹窗）：楼层 Tab + 着色模式切换 + 侧栏详情 + 业务状态分配。
 * - 预览嵌入模式（embedded + preview）：不渲染 el-dialog，仅渲染 SVG stage，
 *   数据源为入库前候选（ParsedRoom[]），点击房间 emit('room-click') 交由导入向导编辑。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { CircleCloseFilled, WarningFilled } from '@element-plus/icons-vue';
import { useBuildingStore } from '../stores/building';
import { isRoomFieldComplete } from '../utils/roomFields';
import type { Floor, InspectStatus, ParsedRoom, Room, UseStatus } from '../types/cad';

const props = withDefaults(
  defineProps<{
    modelValue?: boolean;
    buildingName?: string;
    /** 预览嵌入模式：传入即渲染预览（不显示 el-dialog） */
    preview?: { rooms: ParsedRoom[]; outline?: [number, number][] | null } | null;
    embedded?: boolean;
    /** 全屏工作区形态：为 true 时 el-dialog 以 fullscreen 呈现（替代弹窗，做成「单独界面」） */
    fullscreen?: boolean;
  }>(),
  { modelValue: false, buildingName: '', preview: null, embedded: false, fullscreen: false },
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
/** 墙体高度（米）：从墙线竖直拉伸出的墙体高度，由侧栏「墙高(米)」滑杆控制（默认 1.0m，立体感与可读性平衡；滑杆可调）。
 *  墙体沿 z 轴竖直抬升（screenY 减小=向上），构成每个房间格子的长方体侧壁；高度越大长方体越立体。 */
const wallHeight = ref(1.0);

/** 2.5D 投影（纯正交俯视压缩 + 源楼层「转正」对齐，无视图 yaw 旋转 / 无剪切 / 无 3D 引擎）：
 *  关键教训：任何「视图 yaw 旋转 + 非等比 Y 压缩」叠加都会产生错切(shear)，把矩形压成平行四边形——
 *  仿射变换保平行性，纯 SVG 仿射只能得到平行四边形、做不出真梯形（那需要透视除法）。
 *  解决「斜画矩形」的正确顺序是：先把源矩形「转正到坐标轴」(纯旋转，按最长边方向绕质心转 -θ)，
 *  再做纯 Y 压缩 k（k = cos(纵向俯仰角)，0.55~0.65），旋转与压缩不耦合 → 底面恒为矩形、阳角严格 90°。
 *    alignSource(x,y) → (ax, ay)                  （源转正：使矩形长边水平）
 *    screenX = ax                                  （水平方向原样，房间宽度不变）
 *    screenY = ay * k - z * Z_EXAG                （深度压缩 + 墙高抬升）
 *  视图层面不含任何旋转（水平旋转滑杆已移除），故任意俯仰下底面都保持直角矩形。
 *  立体感不靠剪切，而靠：① 每个房间/墙线向下拉伸出半透明灰侧面多边形（模拟墙厚/格子内壁）② 顶面白色/侧面灰半透明分层 ③ 按屏幕 Y 升序绘制（近处遮挡远处）。 */
/** 纵向俯仰角（度）：由「纵向旋转」滑杆控制，默认 55°（→ k=cos55°≈0.574，落在推荐的 0.55~0.65 区间，给底面适度俯视压缩、保留明显立体感）。
 *  仅作为深度压缩系数 k=cos(俯仰)，不引入任何旋转；范围 0°(k=1 正俯视无压缩) ~ 80°(k≈0.17 压得很扁)。 */
const pitchDeg = ref(55);
const PITCH = computed(() => (pitchDeg.value * Math.PI) / 180);
/** 深度方向压缩系数 k = cos(纵向俯仰角)：纯对角矩阵的 Y 缩放，无旋转项。屏幕 Y 按此压缩、墙高按 Z_EXAG 抬升。 */
const K = computed(() => Math.cos(PITCH.value));
/** 高度夸张系数（1 = 与楼层平面同真实比例，墙体即真实 wallHeight 米高）。 */
const Z_EXAG = 1;
/** 墙体厚度（米）：把一条墙线拉伸成有体积的墙体时赋予的真实厚度。 */
const WALL_THICK = 0.3;

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

// ---- 鼠标交互：左键拖拽 = 平移（视图不做任何旋转，避免引入错切把矩形压成平行四边形）；滚轮 = 缩放 ----
const isDragging = ref(false);
const dragMoved = ref(false);
let dragStart = { x: 0, y: 0, panX: 0, panY: 0 };
function onStageMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return;
  isDragging.value = true;
  dragMoved.value = false;
  dragStart = { x: e.clientX, y: e.clientY, panX: panX.value, panY: panY.value };
}
function onStageMouseMove(e: MouseEvent): void {
  if (!isDragging.value) return;
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;
  // 仅当「按住并移动超过阈值」才视为拖拽，避免「点一下松开鼠标」就产生位移
  if (!dragMoved.value && Math.hypot(dx, dy) < 4) return;
  dragMoved.value = true;
  panX.value = dragStart.panX + dx;
  panY.value = dragStart.panY + dy;
}
function onStageMouseUp(): void {
  isDragging.value = false;
}
function onStageMouseLeave(): void {
  isDragging.value = false;
}
onMounted(() => {
  window.addEventListener('mousemove', onStageMouseMove);
  window.addEventListener('mouseup', onStageMouseUp);
});
onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onStageMouseMove);
  window.removeEventListener('mouseup', onStageMouseUp);
});

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

/** 右侧楼层格子数据：每格显示楼层号 / 房间数 / 总面积 / 状态（来自已上传 DXF 的楼层） */
const floorSummary = computed(() =>
  floors.value.map((f) => {
    const floor = store.getFloor(props.buildingName ?? '', f);
    const list = floor ? store.roomsOfFloor(floor.id) : [];
    const area = list.reduce((s, r) => s + (r.useArea || 0), 0);
    return {
      floorNo: f,
      id: floor?.id ?? '',
      roomCount: list.length,
      area,
      status: (floor?.status ?? 'pending') as Floor['status'],
    };
  }),
);

function selectFloor(n: number): void {
  selectedFloor.value = n;
  selectedId.value = null;
  fillMode.value = false;
}

function floorStatusLabel(s: Floor['status']): string {
  return { pending: '待导入', parsed: '正常', partial: '部分完成', failed: '失败' }[s] ?? s;
}

// ---- 维护信息（Room.maintenance）----
const maintForm = reactive({ responsibleDept: '', lastInspect: '', note: '' });
function loadMaint(r: RoomLike | null): void {
  const m = r && 'maintenance' in r ? r.maintenance : undefined;
  maintForm.responsibleDept = m?.responsibleDept ?? '';
  maintForm.lastInspect = m?.lastInspect ?? '';
  maintForm.note = m?.note ?? '';
}

function saveMaint(): void {
  const f = currentFloor.value;
  const r = selectedRoom.value;
  if (!f || !r) return;
  store.updateRoom(f.id, r.id, {
    maintenance: {
      responsibleDept: maintForm.responsibleDept.trim() || undefined,
      lastInspect: maintForm.lastInspect.trim() || undefined,
      note: maintForm.note.trim() || undefined,
    },
  });
  ElMessage.success('已保存维护信息');
}

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

/** 颜色变亮 amt∈[0,1]，把状态色提亮到接近白，用于「分格盒子」底面（白/灰对比里的「白」） */
function lighten(hex: string, amt: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  const r = Math.round(((n >> 16) & 255) + (255 - ((n >> 16) & 255)) * amt);
  const g = Math.round(((n >> 8) & 255) + (255 - ((n >> 8) & 255)) * amt);
  const b = Math.round((n & 255) + (255 - (n & 255)) * amt);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

/** 中性灰：凸起的墙面（白/灰对比里的「灰」）与界定每个格子的边框线 */
const WALL_GRAY = '#c4cbd4';
const CELL_STROKE = '#8b94a0';

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff;
  return Math.abs(h) % 360;
}

/** 兼容 Room.outline 与 ParsedRoom.polygon */
function polyOf(r: RoomLike): [number, number][] {
  return 'polygon' in r ? r.polygon : r.outline;
}

/** 多边形质心（屏幕坐标） */
function polyCentroid(pts: [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  for (const [px, py] of pts) {
    x += px;
    y += py;
  }
  const n = pts.length || 1;
  return [x / n, y / n];
}

/** 沿「质心→顶点」方向偏移多边形：amt>0 向外膨胀（凸起边框外缘），amt<0 向内收缩（格内开口内缘） */
function offsetPoly(pts: [number, number][], amt: number): [number, number][] {
  const c = polyCentroid(pts);
  return pts.map(([x, y]) => {
    const dx = x - c[0];
    const dy = y - c[1];
    const len = Math.hypot(dx, dy) || 1;
    return [x + (dx / len) * amt, y + (dy / len) * amt] as [number, number];
  });
}

/** 点到线段距离（用于估算安全内缩量，避免小房间内缩自交） */
function distPointToSeg(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx;
  const y = a[1] + t * dy;
  return Math.hypot(p[0] - x, p[1] - y);
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

// ---- 源楼层「转正」对齐（关键修复：DXF 里斜画的矩形必须先转正到坐标轴，再做纯 Y 压缩，否则会被压成平行四边形）----
//   任何「旋转 + 非等比 Y 压缩」叠加都产生错切 → 平行四边形；但正确顺序是「先把矩形转正到坐标轴(纯旋转)」再「纯 Y 压缩」：
//   旋转作用在已对齐的矩形上、压缩只沿对齐后的 y 轴，二者不耦合 → 不会剪切，底面恒为矩形、阳角严格 90°。
//   做法：取源楼层外轮廓（兜底用所有房间）最长边方向 θ，绕质心旋转 -θ 使矩形长边水平 → 轴对齐；之后 scale(1,k) 仅压缩深度。
//   此旋转是「把斜画矩形扶正」的数据预处理，不是视图 yaw 旋转（视图 yaw 旋转 + 压缩才是产生错切的根因，已彻底移除）。
//   alignToAxisEnabled 关闭时按 DXF 真实朝向渲染（斜矩形会如实呈平行四边形，属几何预期，非 bug）。 ----

/** 是否将源楼层「转正到坐标轴」后再投影（默认开启）。关闭则按 DXF 真实朝向（斜画矩形会呈平行四边形，非 bug）。 */
const alignToAxisEnabled = ref(true);

const outlinePoints = computed<[number, number][]>(() => {
  if (props.embedded && props.preview) {
    return (props.preview.outline as unknown as [number, number][]) ?? [];
  }
  return (currentFloor.value?.outline as [number, number][]) ?? [];
});

/** 求源楼层的「主方向」：最长边方向角 θ（绕质心旋转 -θ 可把矩形转正到坐标轴）。对矩形鲁棒：最长边即矩形边。 */
const sourceAlign = computed(() => {
  let pts: [number, number][] = outlinePoints.value ?? [];
  if (!pts || pts.length < 3) {
    pts = [];
    for (const r of displayedRooms.value) for (const p of polyOf(r)) pts.push(p);
  }
  if (pts.length < 3) return { cx: 0, cy: 0, angle: 0 };
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= pts.length; cy /= pts.length;
  let best = 0, bestLen = -1;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = dx * dx + dy * dy;
    if (len > bestLen) { bestLen = len; best = Math.atan2(dy, dx); }
  }
  return { cx, cy, angle: best };
});

/** 把图纸坐标点「转正到坐标轴」（绕楼层质心纯旋转，使矩形长边水平）。alignToAxisEnabled 关闭时原样返回。纯旋转，无拉伸/无剪切。 */
function alignSource(p: [number, number]): [number, number] {
  if (!alignToAxisEnabled.value) return p;
  const { cx, cy, angle } = sourceAlign.value;
  const phi = -angle;
  const c = Math.cos(phi), s = Math.sin(phi);
  const dx = p[0] - cx, dy = p[1] - cy;
  return [dx * c - dy * s + cx, dx * s + dy * c + cy];
}

const fit = computed(() => {
  // 先按投影算整层（含墙顶 z=wallHeight）的屏幕包围盒，再求缩放与居中
  let minIX = Infinity, maxIX = -Infinity, minIY = Infinity, maxIY = -Infinity;
  const consider = (x: number, y: number, z: number) => {
    const [ax, ay] = alignSource([x, y]);
    const ix = ax;
    const iy = ay * K.value - z * Z_EXAG;
    if (ix < minIX) minIX = ix;
    if (ix > maxIX) maxIX = ix;
    if (iy < minIY) minIY = iy;
    if (iy > maxIY) maxIY = iy;
  };
  const outline =
    (props.embedded && props.preview ? props.preview.outline : currentFloor.value?.outline) ?? [];
  for (const pt of outline) {
    consider(pt[0], pt[1], 0);
    consider(pt[0], pt[1], wallHeight.value);
  }
  for (const r of displayedRooms.value) {
    for (const pt of polyOf(r)) {
      consider(pt[0], pt[1], 0);
      consider(pt[0], pt[1], wallHeight.value);
    }
  }
  if (!isFinite(minIX)) {
    minIX = 0; maxIX = 1; minIY = 0; maxIY = 1;
  }
  const M = 28; // 边距，避免墙顶 / 墙厚被裁切
  const isoW = Math.max(maxIX - minIX, 1e-6);
  const isoH = Math.max(maxIY - minIY, 1e-6);
  const scale = Math.min((VIEW_W - 2 * M) / isoW, (VIEW_H - 2 * M) / isoH) * FIT_MARGIN;
  const padX = (VIEW_W - isoW * scale) / 2 - minIX * scale;
  const padY = (VIEW_H - isoH * scale) / 2 - minIY * scale;
  return { scale, padX, padY };
});

function toScreen(p: [number, number]): [number, number] {
  return project(p[0], p[1], 0);
}

/** 2.5D 投影（纯正交俯视压缩，无旋转项）：平面点 (x,y) 抬升 z 米后的屏幕坐标。
 *    screenX = x                         （水平方向原样，房间格子宽度不变）
 *    screenY = y * k - z * Z_EXAG        （k = cos(纵向俯仰角)：深度方向等比压缩；z 为墙高抬升，向上为正）
 *  对角矩阵（screenX 只含 x、screenY 只含 y 与 z）→ 轴对齐矩形恒为矩形、阳角严格 90°、墙体竖直；
 *  绝不退化成平行四边形/梯形（那需要旋转+yaw 或透视除法，本实现两者皆无）。
 *  立体感来自墙体侧面暗色多边形 + 顶面亮色 + 按屏幕 Y 升序绘制（见 wallFaces / wallSideFaces）。 */
function project(x: number, y: number, z: number): [number, number] {
  const f = fit.value;
  // 关键修复：渲染路径必须与 fit 一致地先「源对齐转正」再投影，否则斜画的 DXF 矩形会被原样
  // 画出（常常呈竖向斜片），而 fit 却按转正后的包围盒去缩放/居中 → 内容错位、整体竖向斜置。
  // 这里对齐后再做纯 Y 压缩 k=cos(俯仰)，旋转与压缩不耦合 → 底面恒为矩形、长边水平、阳角严格 90°。
  const [ax, ay] = alignSource([x, y]);
  const ix = ax;
  const iy = ay * K.value - z * Z_EXAG;
  return [ix * f.scale + f.padX, iy * f.scale + f.padY];
}

// ---- 房间文字标签 ----
interface LabelLine {
  text: string;
  size: number;
  weight: number;
  color: string;
  badge: boolean;
  y: number;
}

/** 平面模式（top）的侧壁 quad */
interface Face {
  points: string;
  fill: string;
}

/** 单个房间的平铺填充（z=0 地面，无侧面）+ 其文字标签 */
interface RoomFill {
  id: string;
  room: RoomLike;
  /** 房间轮廓（屏幕坐标，z=0） */
  points: string;
  fill: string;
  stroke: string;
  dimmed: boolean;
  lines: LabelLine[];
  labelX: number;
}

/** 房间文字标签：固定 4 项（房间号 / 名称 / 建筑面积 / 使用面积），房间号缺省兜底「未命名」。 */
function buildLabelLines(room: RoomLike): Omit<LabelLine, 'y' | 'rect'>[] {
  const code = (room.code || room.number || room.name || '').trim();
  const d = (s: string) => (s.trim() !== '' ? s.trim() : '—');
  return [
    { text: code !== '' ? code : '未命名房间', size: 11, weight: 500, color: '#1f2937', badge: false },
    { text: `名称:${d(room.name)}`, size: 8, weight: 400, color: '#374151', badge: false },
    { text: `建筑面积:${room.buildArea > 0 ? room.buildArea.toFixed(1) : '—'}㎡`, size: 8, weight: 400, color: '#111827', badge: true },
    { text: `使用面积:${room.useArea > 0 ? room.useArea.toFixed(1) : '—'}㎡`, size: 8, weight: 400, color: '#111827', badge: true },
  ];
}

// ---- 墙体与房间填充（建筑分层渲染：①地面/②走廊 → ③房间 → ④墙侧面 → ⑤墙顶面 → ⑥文字）----

/** 需要渲染墙体的房间（剔除预览阶段未勾选的候选） */
const visibleRooms = computed(() => displayedRooms.value.filter((r) => r.selected !== false));

/** 墙线来源（等效于 DXF 的「内部结构外墙线」+「内部结构内墙线」层）：
 *  - 楼层外轮廓（outerWall 周长，即 外墙线）作为外墙，每条边拉伸成一段墙体；
 *  - 每个房间轮廓（innerWall 房间，即 内墙线）作为内墙，每条边拉伸成一段墙体。
 *  每段墙线 (a,b) 经 wallFaces 拉伸成带厚度的实心盒：4 个侧面（灰半透明 rgba(138,138,138,0.5)，即格子内壁）+ 1 个顶面（白色，即拉伸墙顶部面）。
 *  关键修复：相邻房间「共一堵墙」时，两侧房间各自贡献一条重合边 → 会画出两堵重叠墙。
 *  这里在聚合后做「共线重叠合并」(mergeWallSegments)，把同一物理墙的多条重合边合并成唯一一段，只画一次。 */

/** 把若干墙线段做「共线重叠合并」：相邻房间共用的同一堵墙、外轮廓与房间周界重合的边，会被合并成唯一一段，
 *  只画一次，避免「共一堵墙显示两堵」的重叠双描。
 *  判定两条边属于同一堵墙（单位无关，全部以 WALL_THICK 为量纲基准，因为 WALL_THICK 是直接叠加到墙线坐标上的，
 *  与坐标同单位）：
 *    1) 近似平行：方向叉积 |ux·uy' − uy·ux'| ≤ ANGLE_TOL（≈2.3°），吸收极小的绘制/解析角度抖动；
 *    2) 两线垂直距离 |c₁ − c₂| ≤ DIST_TOL（= 2×墙厚）：吸收共享墙坐标错位、半墙偏移；
 *    3) 两线段在墙方向上的投影区间重叠或间隙 ≤ GAP_TOL（= 2×墙厚）：吸收端点不齐。
 *  用并查集合并，组内按长度加权平均取代表方向与垂距，还原为单段，使单堵墙落在平均位置。 */
function mergeWallSegments(raw: { a: [number, number]; b: [number, number] }[]): {
  a: [number, number];
  b: [number, number];
}[] {
  const EPS = 1e-6;
  const ANGLE_TOL = 0.04; // |sin(Δθ)| ≈ 2.3°
  const DIST_TOL = WALL_THICK * 2;
  const GAP_TOL = WALL_THICK * 2;
  type Item = { ux: number; uy: number; c: number; t0: number; t1: number; len: number };
  const items: Item[] = [];
  for (const s of raw) {
    const dx = s.b[0] - s.a[0];
    const dy = s.b[1] - s.a[1];
    const len = Math.hypot(dx, dy);
    if (len < EPS) continue;
    let ux = dx / len;
    let uy = dy / len;
    // 规范化方向，使反向线段（a→b 与 b→a）归入同向
    if (ux < 0 || (ux === 0 && uy < 0)) {
      ux = -ux;
      uy = -uy;
    }
    // 单位法向量 n=(-uy,ux)，c = a·n 即直线到原点的有符号垂距
    const c = s.a[0] * -uy + s.a[1] * ux;
    const t1 = s.a[0] * ux + s.a[1] * uy;
    const t2 = s.b[0] * ux + s.b[1] * uy;
    items.push({ ux, uy, c, t0: Math.min(t1, t2), t1: Math.max(t1, t2), len });
  }
  const parent = items.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i]!;
      const B = items[j]!;
      if (Math.abs(A.ux * B.uy - A.uy * B.ux) > ANGLE_TOL) continue;
      if (Math.abs(A.c - B.c) > DIST_TOL) continue;
      const gap = Math.max(A.t0, B.t0) - Math.min(A.t1, B.t1);
      if (gap > GAP_TOL) continue;
      union(i, j);
    }
  }
  const groups = new Map<number, Item[]>();
  for (let i = 0; i < items.length; i++) {
    const r = find(i);
    const arr = groups.get(r) ?? [];
    arr.push(items[i]!);
    groups.set(r, arr);
  }
  const out: { a: [number, number]; b: [number, number] }[] = [];
  for (const arr of groups.values()) {
    let sux = 0;
    let suy = 0;
    let sc = 0;
    let sl = 0;
    let tmin = Infinity;
    let tmax = -Infinity;
    for (const it of arr) {
      sux += it.ux * it.len;
      suy += it.uy * it.len;
      sc += it.c * it.len;
      sl += it.len;
      tmin = Math.min(tmin, it.t0);
      tmax = Math.max(tmax, it.t1);
    }
    let ux = sux / sl;
    let uy = suy / sl;
    const ul = Math.hypot(ux, uy) || 1;
    ux /= ul;
    uy /= ul;
    if (ux < 0 || (ux === 0 && uy < 0)) {
      ux = -ux;
      uy = -uy;
    }
    const c = sc / sl;
    out.push({
      a: [-c * uy + tmin * ux, c * ux + tmin * uy],
      b: [-c * uy + tmax * ux, c * ux + tmax * uy],
    });
  }
  return out;
}

const wallSegments = computed<{ a: [number, number]; b: [number, number] }[]>(() => {
  const raw: { a: [number, number]; b: [number, number] }[] = [];
  const outline =
    (props.embedded && props.preview ? props.preview.outline : currentFloor.value?.outline) ?? [];
  const pushLoop = (poly: [number, number][]) => {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) continue;
      raw.push({ a, b });
    }
  };
  pushLoop(outline);
  for (const r of visibleRooms.value) pushLoop(polyOf(r));
  return mergeWallSegments(raw);
});

/** 把一段墙线 (a,b) 拉伸成高 wallHeight 米的墙体：4 个竖直侧面 + 1 个顶面。 */
function wallFaces(seg: { a: [number, number]; b: [number, number] }): { sides: Face[]; top: Face } {
  const { a, b } = seg;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const t = WALL_THICK / 2;
  const A1: [number, number] = [a[0] + nx * t, a[1] + ny * t];
  const B1: [number, number] = [b[0] + nx * t, b[1] + ny * t];
  const A2: [number, number] = [a[0] - nx * t, a[1] - ny * t];
  const B2: [number, number] = [b[0] - nx * t, b[1] - ny * t];
  const H = wallHeight.value;
  const P = (p: [number, number], z: number): [number, number] => project(p[0], p[1], z);
  const q = (p: [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  const sideFill = 'rgba(138,138,138,0.5)'; // 格子内壁：灰(半透明)（用户规范）
  const topFill = '#ffffff'; // 拉伸的墙(顶部的面)：白色（用户规范）
  const sides: Face[] = [
    { points: `${q(P(A1, 0))} ${q(P(B1, 0))} ${q(P(B1, H))} ${q(P(A1, H))}`, fill: sideFill },
    { points: `${q(P(A2, 0))} ${q(P(B2, 0))} ${q(P(B2, H))} ${q(P(A2, H))}`, fill: sideFill },
    { points: `${q(P(A1, 0))} ${q(P(A2, 0))} ${q(P(A2, H))} ${q(P(A1, H))}`, fill: sideFill },
    { points: `${q(P(B1, 0))} ${q(P(B2, 0))} ${q(P(B2, H))} ${q(P(B1, H))}`, fill: sideFill },
  ];
  const top: Face = {
    points: `${q(P(A1, H))} ${q(P(B1, H))} ${q(P(B2, H))} ${q(P(A2, H))}`,
    fill: topFill,
  };
  return { sides, top };
}

/** 单一深度排序键：墙体地面中点的屏幕 Y（越小越靠后，先画） */
function segDepthKey(seg: { a: [number, number]; b: [number, number] }): number {
  const mx = (seg.a[0] + seg.b[0]) / 2;
  const my = (seg.a[1] + seg.b[1]) / 2;
  return toScreen([mx, my])[1];
}

/** ④ 墙侧面（先画）：按深度升序，保证遮挡正确 */
const wallSideFaces = computed<Face[]>(() =>
  wallSegments.value
    .slice()
    .sort((p, q) => segDepthKey(p) - segDepthKey(q))
    .flatMap((seg) => wallFaces(seg).sides),
);
/** ⑤ 墙顶面（后画，盖在侧面上） */
const wallTopFaces = computed<Face[]>(() =>
  wallSegments.value
    .slice()
    .sort((p, q) => segDepthKey(p) - segDepthKey(q))
    .map((seg) => wallFaces(seg).top),
);

const LINE_GAP = 13;
/** ③ 房间平铺填充（z=0 地面，无侧面），含文字标签 */
const roomFills = computed<RoomFill[]>(() =>
  displayedRooms.value.map((room) => {
    const base = polyOf(room).map(toScreen);
    const points = base.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const color = '#ffffff'; // 格子底部：白色（用户规范）
    const stroke = '#c4cbd4'; // 浅灰描边：区分相邻房间、呈现格子边界
    // 标签锚点：直接用「房间多边形自身在屏幕上的几何质心」，而非依赖 room.centroid 字段。
    // 原因：真实 App 用的是 store 持久化的 Room 数据，若持久化时未写入 centroid，
    // toScreen(undefined) 会返回 [NaN,NaN]，文字被画到画布外不可见（而多边形用的是 polyOf，照常显示）→ 表现为「格子在、里面没字」。
    // 由多边形顶点反推质心永远成立，杜绝该问题。
    const c: [number, number] =
      base.length > 0
        ? [
            base.reduce((s, p) => s + p[0], 0) / base.length,
            base.reduce((s, p) => s + p[1], 0) / base.length,
          ]
        : toScreen(room.centroid ?? [0, 0]);
    const baseLines = buildLabelLines(room);
    const startY = c[1] - ((baseLines.length - 1) * LINE_GAP) / 2;
    const lines: LabelLine[] = baseLines.map((ln, i) => {
      const y = startY + i * LINE_GAP;
      return { ...ln, y };
    });
    return {
      id: room.id,
      room,
      points,
      fill: color,
      stroke,
      dimmed: room.selected === false,
      lines,
      labelX: c[0],
    };
  }),
);

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

// ---- 交互：仅点击选中弹出小卡片（已移除 hover tooltip，避免遮挡与误触）----
const selectedId = ref<string | null>(null);
/** 点击房间弹出的小卡片位置（stage 内像素坐标）与展开模式 */
const popupPos = ref({ x: 0, y: 0 });
const popMode = ref<'edit' | 'maint' | null>(null);

const selectedRoom = computed(() => displayedRooms.value.find((r) => r.id === selectedId.value) ?? null);

/** 选中房间缩略图：用房间自身轮廓生成一张「对应的图片」（无外部图片数据时也能稳定展示） */
const roomThumb = computed<{ viewBox: string; points: string; fill: string } | null>(() => {
  const r = selectedRoom.value;
  if (!r) return null;
  const poly = polyOf(r);
  if (poly.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  const W = 220;
  const H = 130;
  const pad = 10;
  const scale = Math.min((W - pad * 2) / w, (H - pad * 2) / h);
  const ox = pad + (W - pad * 2 - w * scale) / 2;
  const oy = pad + (H - pad * 2 - h * scale) / 2;
  const points = poly
    .map(([x, y]) => {
      const px = ox + (x - minX) * scale;
      const py = oy + (maxY - y) * scale; // 翻转 Y（SVG 向下为正）
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(' ');
  return { viewBox: `0 0 ${W} ${H}`, points, fill: colorFor(r) };
});

/** 弹窗数据：一行两个属性，按 [label, value] 成对排列 */
const roomInfoPairs = computed<{ label: string; value: string }[]>(() => {
  const r = selectedRoom.value;
  if (!r) return [];
  return [
    { label: '房间号', value: r.code || '—' },
    { label: '名称', value: r.name || '—' },
    { label: '部门', value: r.dept || '—' },
    { label: '用途', value: r.usePurpose || '—' },
    { label: '使用面积', value: `${r.useArea > 0 ? r.useArea.toFixed(1) : '—'} ㎡` },
    { label: '建筑面积', value: `${r.buildArea > 0 ? r.buildArea.toFixed(1) : '—'} ㎡` },
    { label: '业务状态', value: USE_LABELS[r.useStatus] ?? '—' },
    { label: '审图状态', value: INSPECT_LABELS[r.inspectStatus] ?? '—' },
  ];
});

/** 选中房间变化时，同步加载其维护信息到表单 */
watch(selectedRoom, (r) => loadMaint(r), { immediate: true });

function onSelect(room: RoomLike, ev?: MouseEvent): void {
  if (props.embedded) {
    emit('room-click', room as ParsedRoom);
    return;
  }
  // 拖拽平移（移动超过阈值）结束后松手会触发一次 click，需忽略；
  // 用「按下点→松开点」的直线距离判断，容忍点击瞬间的微小手抖（≤8px 仍算点击），
  // 避免「必须点中房间正中才能弹出」的误吞现象。
  if (ev) {
    const d = Math.hypot(ev.clientX - dragStart.x, ev.clientY - dragStart.y);
    if (d > 8) return;
  }
  const isSame = selectedId.value === room.id;
  selectedId.value = isSame ? null : room.id;
  if (!selectedId.value) return;
  popMode.value = null;
  const stage = stageRef.value;
  if (!stage) return;
  const r = stage.getBoundingClientRect();
  let x: number;
  let y: number;
  if (ev) {
    // 以点击点为锚，向右下偏移，避免遮挡房间
    x = ev.clientX - r.left + 14;
    y = ev.clientY - r.top + 14;
  } else {
    // 由房间列表等无坐标来源触发时，居中偏上
    x = r.width / 2 - 130;
    y = 24;
  }
  // 夹取在舞台内，防止弹出卡片被裁切
  x = Math.min(Math.max(x, 8), Math.max(8, r.width - 268));
  y = Math.min(Math.max(y, 8), Math.max(8, r.height - 248));
  popupPos.value = { x, y };
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
    width="80%"
    top="5vh"
    :fullscreen="fullscreen"
    :show-close="true"
    class="fpv-dialog"
  >
    <template #header>
      <div class="fpv__head">
        <strong class="fpv__title">{{ buildingName }} · 楼宇分层图（2.5D）</strong>
        <el-button link type="primary" @click="visible = false">← 返回室外</el-button>
      </div>
    </template>
    <el-empty v-if="!floors.length" description="暂无室内图纸，请先导入">
      <el-button type="primary" @click="requestImport">导入图纸</el-button>
    </el-empty>

    <div v-else class="fpv fpv--ws">
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
          <div class="fpv-stage" ref="stageRef" @wheel.prevent="onWheel" @mousedown="onStageMouseDown" @mouseleave="onStageMouseLeave">
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
              <linearGradient id="rimGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#d9dee5" />
                <stop offset="100%" stop-color="#aeb6c2" />
              </linearGradient>
            </defs>
            <g>
            <!-- ① 地面(楼板) + ② 走廊：楼层外轮廓填充；房间在③层覆盖其上，自然得到「外轮廓减房间」的走廊区 -->
            <path v-if="outlinePath" :d="outlinePath" fill="#eef1f5" stroke="#c4cbd4" stroke-width="1.5" pointer-events="none" />
            <!-- ③ 房间平铺填充（z=0 地面，无侧面） -->
            <g
              v-for="rf in roomFills"
              :key="rf.id"
              class="fpv-room"
              :opacity="rf.dimmed ? 0.18 : 1"
              @click="onSelect(rf.room, $event)"
            >
              <polygon
                :points="rf.points"
                :fill="rf.fill"
                :stroke="rf.stroke"
                stroke-width="1"
              />
            </g>
            <!-- ④ 墙侧面（先画，仅作视觉，不拦截点击） -->
            <polygon
              v-for="(f, i) in wallSideFaces"
              :key="'s' + i"
              :points="f.points"
              :fill="f.fill"
              stroke="none"
              pointer-events="none"
            />
            <!-- ⑤ 墙顶面（后画，盖在侧面上）：浅灰实心面，非白线，不拦截点击 -->
            <polygon
              v-for="(f, i) in wallTopFaces"
              :key="'t' + i"
              :points="f.points"
              :fill="f.fill"
              stroke="#8a8a8a"
              stroke-width="0.5"
              pointer-events="none"
            />
            <!-- ⑥ 文字（最上层） -->
            <g class="fpv-labels" pointer-events="none">
              <template v-for="rf in roomFills" :key="'L' + rf.id">
                <g v-for="(ln, i) in rf.lines" :key="i">
                  <text
                    :x="rf.labelX"
                    :y="ln.y"
                    text-anchor="middle"
                    :font-size="ln.size"
                    :font-weight="ln.weight"
                    :fill="ln.color"
                    dominant-baseline="middle"
                  >{{ ln.text }}</text>
                </g>
              </template>
            </g>
            </g>
          </svg>

          <div
            v-if="selectedRoom"
            class="fpv-pop"
            :style="{ left: popupPos.x + 'px', top: popupPos.y + 'px' }"
            @mousedown.stop
          >
            <div class="fpv-pop__hd">
              <span class="fpv-pop__title">{{ selectedRoom.code || selectedRoom.name || '未命名房间' }}</span>
              <button class="fpv-pop__x" type="button" @click="selectedId = null">×</button>
            </div>
            <div v-if="roomThumb" class="fpv-pop__img">
              <svg :viewBox="roomThumb.viewBox" preserveAspectRatio="xMidYMid meet">
                <polygon :points="roomThumb.points" :fill="roomThumb.fill" :stroke="darken(roomThumb.fill, 0.45)" stroke-width="2" />
              </svg>
              <span class="fpv-pop__img-tag">房间缩略图</span>
            </div>
            <div v-else class="fpv-pop__img fpv-pop__img--empty">暂无图形</div>
            <div class="fpv-pop__info">
              <div v-for="p in roomInfoPairs" :key="p.label" class="fpv-pop__cell">
                <span>{{ p.label }}</span><b>{{ p.value }}</b>
              </div>
            </div>
            <div class="fpv-pop__acts">
              <el-button size="small" :type="popMode === 'edit' ? 'primary' : 'default'" @click="popMode = 'edit'">修改信息</el-button>
              <el-button size="small" :type="popMode === 'maint' ? 'primary' : 'default'" @click="popMode = 'maint'">维护房间信息</el-button>
            </div>
            <div v-if="popMode === 'edit'" class="fpv-pop__form">
              <div class="fpv-edit__row"><label>房间号</label><el-input v-model="editRoom.code" size="small" /></div>
              <div class="fpv-edit__row"><label>名称</label><el-input v-model="editRoom.name" size="small" /></div>
              <div class="fpv-edit__row"><label>部门</label><el-input v-model="editRoom.dept" size="small" /></div>
              <div class="fpv-edit__row"><label>用途</label><el-input v-model="editRoom.usePurpose" size="small" /></div>
              <div class="fpv-edit__row"><label>使用面积</label><el-input v-model="editRoom.useArea" size="small" type="number" /></div>
              <div class="fpv-edit__row"><label>建筑面积</label><el-input v-model="editRoom.buildArea" size="small" type="number" /></div>
              <div class="fpv-info__actions">
                <el-button type="primary" size="small" @click="saveEdit">保存</el-button>
              </div>
              <div class="fpv-info__actions">
                <el-button size="small" @click="setUseStatus('occupied')">使用中</el-button>
                <el-button size="small" @click="setUseStatus('noaccess')">无权限</el-button>
                <el-button size="small" @click="setUseStatus('vacant')">空置</el-button>
                <el-button size="small" text @click="setUseStatus('')">清空</el-button>
              </div>
              <div class="fpv-info__actions">
                <el-button size="small" type="danger" plain @click="hideRoom">隐藏此房间</el-button>
              </div>
            </div>
            <div v-if="popMode === 'maint'" class="fpv-pop__form">
              <div class="fpv-edit__row"><label>责任部门</label><el-input v-model="maintForm.responsibleDept" size="small" /></div>
              <div class="fpv-edit__row"><label>最近巡检</label><el-input v-model="maintForm.lastInspect" size="small" placeholder="yyyy-mm-dd" /></div>
              <div class="fpv-edit__row"><label>备注</label><el-input v-model="maintForm.note" size="small" type="textarea" :rows="2" /></div>
              <div class="fpv-info__actions">
                <el-button type="primary" size="small" @click="saveMaint">保存维护信息</el-button>
              </div>
            </div>
          </div>

          <p v-if="!roomFills.length" class="fpv-embed-empty">暂无房间数据</p>
        </div>

        <aside class="fpv-side fpv-side--ws">
          <div class="fpv-legend">
            <span v-for="l in legend" :key="l.label" class="fpv-legend__item">
              <i :style="{ background: l.color }"></i>{{ l.label }}
            </span>
          </div>

          <!-- 楼层格子：按已上传 DXF 动态生成，每格显示楼层信息 -->
          <section class="fpv-sec">
            <h4 class="fpv-sec__title">楼层（{{ floorSummary.length }}）</h4>
            <div class="fpv-floorgrid">
              <button
                v-for="c in floorSummary"
                :key="c.floorNo"
                class="fpv-floorcard"
                :class="{ active: c.floorNo === selectedFloor }"
                @click="selectFloor(c.floorNo)"
              >
                <div class="fpv-floorcard__no">{{ c.floorNo }}F</div>
                <div class="fpv-floorcard__meta">{{ c.roomCount }} 间 · {{ c.area.toFixed(0) }} ㎡</div>
                <span class="fpv-floorcard__status" :data-s="c.status">{{ floorStatusLabel(c.status) }}</span>
              </button>
            </div>
          </section>

          <!-- 工具操作按钮 -->
          <section class="fpv-sec">
            <h4 class="fpv-sec__title">工具</h4>
            <div class="fpv-tools">
              <el-button size="small" type="primary" plain @click="requestImport">+ 导入图纸</el-button>
              <div class="fpv-tools__row">
                <span class="fpv-tools__label">着色</span>
                <el-radio-group v-model="colorMode" size="small">
                  <el-radio-button value="use">业务</el-radio-button>
                  <el-radio-button value="inspect">审图</el-radio-button>
                  <el-radio-button value="dept">部门</el-radio-button>
                  <el-radio-button value="purpose">用途</el-radio-button>
                </el-radio-group>
              </div>
              <div class="fpv-tools__row">
                <span class="fpv-tools__label">墙高(米)</span>
                <el-slider v-model="wallHeight" :min="0.5" :max="5" :step="0.5" :show-tooltip="true" class="fpv__lift" />
              </div>
              <div class="fpv-tools__row">
                <span class="fpv-tools__label">纵向旋转</span>
                <el-slider v-model="pitchDeg" :min="0" :max="80" :step="1" :show-tooltip="true" class="fpv__lift" />
                <span class="fpv-tools__val">{{ pitchDeg }}°</span>
              </div>
              <div class="fpv-tools__row">
                <el-checkbox v-model="alignToAxisEnabled" size="small">源对齐(转正为水平矩形)</el-checkbox>
              </div>
              <div class="fpv-tools__row">
                <span class="fpv-tools__hint">左键拖拽平移图层；滚轮缩放。底面经源对齐转正为水平矩形，仅做俯视压缩保持直角；墙体竖直抬升形成长方体</span>
              </div>
              <div class="fpv-tools__row">
                <el-button-group>
                  <el-button size="small" @click="zoomBy(1.2)">＋</el-button>
                  <el-button size="small" @click="zoomBy(1 / 1.2)">－</el-button>
                  <el-button size="small" @click="resetView">复位</el-button>
                </el-button-group>
              </div>
            </div>
          </section>

        </aside>
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
        <div class="fpv-tools__row fpv-tools__row--embed">
          <span class="fpv-tools__label">倾角</span>
          <el-slider v-model="pitchDeg" :min="0" :max="80" :step="1" :show-tooltip="true" class="fpv__lift fpv__lift--embed" />
          <span class="fpv-tools__val">{{ pitchDeg }}°</span>
        </div>
        <div class="fpv-tools__row fpv-tools__row--embed">
          <el-checkbox v-model="alignToAxisEnabled" size="small">源对齐</el-checkbox>
        </div>
      </div>
    </div>
    <div class="fpv-stage" ref="stageRef" @wheel.prevent="onWheel" @mousedown="onStageMouseDown" @mouseleave="onStageMouseLeave">
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
              <linearGradient id="rimGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#d9dee5" />
                <stop offset="100%" stop-color="#aeb6c2" />
              </linearGradient>
            </defs>
        <g>
        <!-- ① 地面(楼板) + ② 走廊：楼层外轮廓填充；房间在③层覆盖其上，自然得到「外轮廓减房间」的走廊区 -->
        <path v-if="outlinePath" :d="outlinePath" fill="#eef1f5" stroke="#c4cbd4" stroke-width="1.5" pointer-events="none" />
        <!-- ③ 房间平铺填充（z=0 地面，无侧面） -->
        <g
          v-for="rf in roomFills"
          :key="rf.id"
          class="fpv-room"
          :opacity="rf.dimmed ? 0.18 : 1"
          @click="onSelect(rf.room, $event)"
            >
              <polygon
                :points="rf.points"
                :fill="rf.fill"
                :stroke="rf.stroke"
                stroke-width="1"
              />
            </g>
        <!-- ④ 墙侧面（先画，仅作视觉，不拦截点击） -->
        <polygon
          v-for="(f, i) in wallSideFaces"
          :key="'s' + i"
          :points="f.points"
          :fill="f.fill"
          stroke="none"
          pointer-events="none"
        />
        <!-- ⑤ 墙顶面（后画，盖在侧面上）：浅灰实心面，非白线，不拦截点击 -->
        <polygon
          v-for="(f, i) in wallTopFaces"
          :key="'t' + i"
          :points="f.points"
          :fill="f.fill"
          stroke="#8a8a8a"
          stroke-width="0.5"
          pointer-events="none"
        />
        <!-- ⑥ 文字（最上层） -->
        <g class="fpv-labels" pointer-events="none">
          <template v-for="rf in roomFills" :key="'L' + rf.id">
            <g v-for="(ln, i) in rf.lines" :key="i">
              <text
                :x="rf.labelX"
                :y="ln.y"
                text-anchor="middle"
                :font-size="ln.size"
                :font-weight="ln.weight"
                :fill="ln.color"
                dominant-baseline="middle"
              >{{ ln.text }}</text>
            </g>
          </template>
        </g>
        </g>
      </svg>

      <p v-if="!roomFills.length" class="fpv-embed-empty">所选房间均已剔除，左侧重新勾选即可恢复</p>
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
.fpv__top--embed { justify-content: space-between; }
.fpv__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 2px 2px 10px; }
.fpv__title { font-size: 16px; font-weight: 700; color: #111827; }

/* 工作区主区：中央 stage + 右侧栏 */
.fpv--ws { display: flex; flex-direction: column; gap: 10px; height: 100%; }
.fpv--ws .fpv-main { flex: 1; min-height: 0; }
.fpv--ws .fpv-stage { height: 100%; }
.fpv--ws .fpv-svg { height: 100%; min-height: 50vh; }

/* 右侧栏 */
.fpv-side--ws { width: 340px; border-left: 1px solid #eef0f3; padding-left: 14px; overflow-y: auto; gap: 14px; }
.fpv-sec { display: flex; flex-direction: column; gap: 8px; }
.fpv-sec__title { margin: 0; font-size: 13px; font-weight: 700; color: #374151; }
.fpv-sec--grow { flex: 1; min-height: 0; }

/* 楼层格子 */
.fpv-floorgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 8px; }
.fpv-floorcard {
  display: flex; flex-direction: column; gap: 2px; align-items: flex-start;
  border: 1px solid #d0d5dd; background: #fff; border-radius: 9px; padding: 8px 10px;
  cursor: pointer; text-align: left; transition: all .15s;
}
.fpv-floorcard:hover { border-color: #93c5fd; }
.fpv-floorcard.active { background: #eff6ff; border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,.15); }
.fpv-floorcard__no { font-size: 15px; font-weight: 700; color: #111827; }
.fpv-floorcard__meta { font-size: 11px; color: #6b7280; }
.fpv-floorcard__status { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #f1f5f9; color: #64748b; }
.fpv-floorcard__status[data-s="parsed"] { background: #dcfce7; color: #15803d; }
.fpv-floorcard__status[data-s="partial"] { background: #fef9c3; color: #a16207; }
.fpv-floorcard__status[data-s="failed"] { background: #fee2e2; color: #b91c1c; }

/* 工具 */
.fpv-tools { display: flex; flex-direction: column; gap: 8px; }
.fpv-tools__row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fpv-tools__label { font-size: 13px; color: #6b7280; width: 32px; flex-shrink: 0; }
.fpv__lift { flex: 1; min-width: 80px; }
.fpv-tools__val { font-size: 12px; color: #6b7280; width: 40px; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; }
.fpv__lift--embed { min-width: 90px; max-width: 150px; }

/* 房间列表 */
.fpv-roomlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; }
.fpv-roomlist__item { display: flex; gap: 8px; padding: 6px 8px; border-radius: 7px; cursor: pointer; font-size: 13px; border: 1px solid transparent; }
.fpv-roomlist__item:hover { background: #f8fafc; }
.fpv-roomlist__item.active { background: #eff6ff; border-color: #bfdbfe; }
.fpv-roomlist__code { font-weight: 700; color: #1f2937; }
.fpv-roomlist__name { color: #6b7280; }

/* 房间详情（tabs） */
.fpv-roomdetail { margin-top: 10px; border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px 12px; background: #fff; }
.fpv-detail { margin: 0; }
.fpv-detail div { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; border-bottom: 1px dashed #eef0f3; }
.fpv-detail div:last-child { border-bottom: 0; }
.fpv-detail dt { color: #6b7280; }
.fpv-detail dd { margin: 0; color: #111827; }
.fpv-showall { margin-top: 8px; }
.fpv-main { display: flex; gap: 12px; align-items: stretch; }
.fpv-stage { position: relative; flex: 1; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; background: linear-gradient(180deg, #8fc1ec 0%, #bfdcf4 55%, #eef6fc 100%); }
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

/* 点击房间弹出的小卡片（替代原右侧房间信息面板） */
.fpv-pop {
  position: absolute;
  z-index: 30;
  width: 252px;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, .18);
  padding: 10px 12px;
  font-size: 13px;
  color: #111827;
}
.fpv-pop__hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.fpv-pop__title { font-size: 14px; font-weight: 700; color: #111827; }
.fpv-pop__x { border: 0; background: transparent; font-size: 18px; line-height: 1; color: #9ca3af; cursor: pointer; padding: 0 2px; }
.fpv-pop__x:hover { color: #374151; }
.fpv-pop__img { position: relative; width: 100%; height: 132px; margin-bottom: 10px; background: #f8fafc; border: 1px solid #eef0f3; border-radius: 8px; overflow: hidden; }
.fpv-pop__img svg { width: 100%; height: 100%; display: block; }
.fpv-pop__img-tag { position: absolute; left: 6px; bottom: 4px; font-size: 10px; color: #9ca3af; background: rgba(255,255,255,.75); padding: 0 4px; border-radius: 4px; }
.fpv-pop__img--empty { display: flex; align-items: center; justify-content: center; color: #9ca3af; font-size: 12px; }
.fpv-pop__info { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; margin-bottom: 8px; }
.fpv-pop__cell { display: flex; flex-direction: column; gap: 1px; padding: 4px 6px; background: #f8fafc; border-radius: 6px; }
.fpv-pop__cell span { color: #6b7280; font-size: 11px; }
.fpv-pop__cell b { font-weight: 600; color: #111827; font-size: 13px; }
.fpv-pop__acts { display: flex; gap: 8px; margin-bottom: 4px; }
.fpv-pop__form { border-top: 1px dashed #eef0f3; padding-top: 8px; margin-top: 4px; }
.fpv-tools__row--embed { margin-left: 10px; min-width: 160px; }
</style>
