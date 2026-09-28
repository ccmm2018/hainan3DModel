<script setup lang="ts">
/**
 * FloorPlan2D：楼层 2.5D 平面图查看器（SVG 渲染，正交俯视压缩 + 源对齐转正，底面恒为水平直角矩形、墙体竖直抬升成长方体）。
 *
 * 渲染规范：
 * - 渲染架构（建筑分层）：① 楼层外轮廓地面 + ② 走廊（外轮廓减房间，由③层房间覆盖得到）
 *   + ③ 房间盒子（z=H 顶面 + 朝向观察者的可见侧墙）+ ④ 墙侧面（外墙线/内墙线拉伸成 wallHeight 米高，先画）
 *   + ⑤ 墙顶面（后画）+ ⑥ 文字标签。墙体高度由「墙高(米)」滑杆驱动。
 * - 2.5D 投影（斜投影 / 正交等距类，纯仿射：对角 + 剪切，无透视除法、无 3D 引擎依赖）：对深度 y 同时做竖向压缩 SY=cos(纵向俯仰角) 与「极轻」水平错切 SX=sin(纵向俯仰角)×0.08，
 *   使楼面读成一个「几乎直立的正常长方体盒子、仅带极轻斜度」，规避明显平行四边形/梯形观感、也避免房间格子被斜切看扁。
 *   楼层按 DXF 真实朝向渲染，轴对齐矩形恒为矩形、阳角 90°；立体感来自暗色墙侧面 + 亮色顶面 + 按屏幕 Y 升序遮挡。
 *   纵向俯仰角由「纵向旋转」滑杆控制、默认 55°（SY≈0.574、SX≈sin55°×0.08≈0.066；俯仰越小越接近正俯视矩形、越大深度越向水平展开）。
 *     screenX = x + (y - yc) * SX        （水平宽度原样；深度 y 相对楼层中心 yc 错切 SX=sin(俯仰)×0.08 → 极轻斜度底面，绕中心居中保持左右对称）
 *     screenY = y * SY - z * Z_EXAG      （SY=cos(俯仰)：深度竖向压缩；z 为墙高抬升，向上为正）
 *   纯仿射（保平行性）：轴对齐矩形恒为轻微斜平行四边形、阳角对应平行、墙体恒为竖直侧壁；刻意极小 SX 使其看上去就是「直立长方体」而非扁平行四边形。
 *   墙体一律「向内偏移一个墙厚」绘制（见 wallFaces 的 inwardShift），最外缘压在楼层外轮廓线上、不向外伸出（修复最外层横向墙体两头冒出）。
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
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
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
/** 弹窗的直接定位祖先（.fpv-main，已设为 position:relative）。弹窗的 left/top 是相对它的，
 *  故 onSelect / fitPopupInStage 都以它的包围盒为基准计算，避免「相对 stage 计算、却相对 viewport 渲染」的错位。 */
const mainRef = ref<HTMLElement | null>(null);
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 6;
/** 墙体高度（米）：从墙线竖直拉伸出的墙体高度，由侧栏「墙高(米)」滑杆控制（默认 0.5m；滑杆可调 0.5~5m）。
 *  墙体沿 z 轴竖直抬升（screenY 减小=向上），构成每个房间格子的长方体侧壁；高度越大长方体越立体。
 *  注：Z_EXAG=1，即 0.5m 为真实视觉高度（不做夸张），靠两面明暗着色呈现立体感。 */
const wallHeight = ref(0.5);

/** 渐进式渲染阶段（用于分步交付、每步确认）：
 *  1 = 仅画整栋楼的「盒子」（顶面地板 + 朝观察者的连续前墙），不画房间/走廊/文字；
 *  2 = + 顶面上一条横向走廊带（浅灰、无侧墙无边框，仅作区域标记）；
 *  3 = + 走廊两侧共 12 个房间色块分区（普通统一浅蓝、特殊醒目色，无立体无侧墙）；
 *  4 = + 每个房间正中心四行文字（号码/名称/部门/两面积）。
 *  当前交付进度停在 4（含文字标签）。 */
const renderStage = ref(4);

/** 2.5D 投影（斜投影 = 源楼层「转正」对齐 + 深度「竖向压缩 SY + 水平错切 SX」，纯仿射、无视图 yaw 旋转、无 3D 引擎）：
 *  关键认知：仿射变换保平行性——矩形经「纯 Y 压缩」只会得到矩形；要得到经典 2.5D 的平行四边形楼面，必须主动引入
 *  水平错切 SX（=sin(俯仰)）让深度方向在屏幕上向右偏移；纯 SVG 仿射只能得到平行四边形、做不出真梯形（那需要透视除法）。
 *  正确顺序是：先把源矩形「转正到坐标轴」(纯旋转，按最长边方向绕质心转 -θ) 使长边水平，
 *  再做「竖向压缩 SY=cos(俯仰) + 水平错切 SX=sin(俯仰)」，旋转与压缩/错切不耦合 → 底面恒为平行四边形、阳角对应平行。
 *    alignSource(x,y) → (ax, ay)                  （源转正：使矩形长边水平，作为屏幕水平轴）
 *    screenX = ax + (ay - ayc) * SX               （水平宽度原样 + 深度绕中心 ayc 错切 SX=sin(俯仰)×0.16 → 平行四边形，居中不右倾）
 *    screenY = ay * SY - z * Z_EXAG               （深度竖向压缩 + 墙高抬升）
 *  立体感来自：① 墙线竖直抬升出的半透明灰侧面多边形（模拟墙厚）② 顶面白色/侧面灰半透明分层 ③ 按屏幕 Y 升序绘制（近处遮挡远处）。 */
/** 纵向俯仰角（度）：由「纵向旋转」滑杆控制，默认 55°（→ k=cos55°≈0.574，落在推荐的 0.55~0.65 区间，给底面适度俯视压缩、保留明显立体感）。
 *  仅作为深度压缩系数 k=cos(俯仰)，不引入任何旋转；范围 0°(k=1 正俯视无压缩) ~ 80°(k≈0.17 压得很扁)。 */
const pitchDeg = ref(55);
const PITCH = computed(() => (pitchDeg.value * Math.PI) / 180);
/** 深度方向竖向压缩系数 SY = cos(纵向俯仰角)：屏幕 Y 按此压缩、墙高按 Z_EXAG 抬升。 */
const K = computed(() => Math.cos(PITCH.value));
/** 深度方向水平错切系数 SX：用户明确要求「顶面 = 长方形（上下边水平且等长、左右边竖直）」，
 *  故本项目采用【零错切 SX=0 + 纯竖向压缩 SY=cos(俯仰)】的投影——轴对齐矩形经投影后仍是矩形，绝不退化成平行四边形 / 梯形。
 *  立体感仅靠「顶面 + 朝观察者的一整条连续前墙」表达：前墙由 z=0→H 竖向拉伸、颜色比顶面明显更暗。
 *  纵向俯仰角仅作为深度压缩系数 K=cos(俯仰)（俯仰越小越不扁），不再引入任何水平错切。 */
const SX = computed(() => 0);
/** 高度夸张系数（1 = 与楼层平面同真实比例，墙体即真实 wallHeight 米高）。 */
const Z_EXAG = 1;
/** 墙体厚度（米）：把一条墙线拉伸成有体积的墙体时赋予的真实厚度（0.22，较此前 0.3 再减薄，避免厚墙吃掉格子/外冒）。
 *  关键：墙体一律「向内偏移一个墙厚」绘制（见 wallFaces 的 inwardShift），使最外缘正好压在楼层外轮廓线上、
 *  绝不向外伸出（修复「最外层横向墙体两头冒出来」的外冒问题），且内墙也同步内收、不侵占房间格子。 */
const WALL_THICK = 0.22;
/** 楼栋盒子（第 1 步渐进渲染）的视觉厚度（米）：仅为让「整栋楼=一块躺下去的地板」在图上清晰可读而设，
 *  非真实层高；楼栋盒子比房间盒子(墙高滑杆)更高更厚，呈「容器/底板」观感。 */
const BUILDING_H = 3.0;
/** 房间之间的「隔墙」平面厚度（米）：隔墙在楼面平面上的物理粗细，决定俯视图里墙的宽窄。 */
const WALL_T = 0.3;
/** 隔墙「抬升高度」（米）：房间是平铺在地板(BUILDING_H)上的色块，房间之间用一条抬升 WALL_H 的隔墙分隔 →
 *  房间平、隔墙凸、走廊凹，形成凹凸感。用户明确要求 0.5 米高。 */
const WALL_H = 0.5;

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
  selectedRoom.value = null;
  popMode.value = null;
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
  if (!isRealRoom(r)) {
    // 合成预览房间不入库，仅给出提示，不写 store
    ElMessage.info('当前为预览房间，维护信息未写入数据库');
    return;
  }
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

// ---- 源楼层「转正」对齐（关键修复：DXF 里斜画的矩形必须先转正到坐标轴，再做斜投影，否则会被画成竖向斜片、与 fit 包围盒错位）----
//   正确顺序是「先把矩形转正到坐标轴(纯旋转)」再「斜投影（竖向压缩 SY + 水平错切 SX）」：
//   旋转使矩形长边水平作为屏幕水平轴，之后斜投影的错切只沿对齐后的 y 轴（深度），二者不耦合 → 底面恒为平行四边形、阳角对应平行。
//   做法：取源楼层外轮廓（兜底用所有房间）最长边方向 θ，绕质心旋转 -θ 使矩形长边水平 → 轴对齐。
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

/** 投影中心：取本层全部点（外轮廓 + 房间）「源对齐转正」后的质心，用作错切的居中基准，
 *  使整栋建筑绕自身中心错切、不再整体向右偏移（避免右侧边被过度拉开成「右倾」）。 */
const projectionCenter = computed(() => {
  const pts: [number, number][] = [];
  const outline =
    (props.embedded && props.preview ? props.preview.outline : currentFloor.value?.outline) ?? [];
  for (const p of outline) pts.push(p);
  for (const r of displayedRooms.value) for (const p of polyOf(r)) pts.push(p);
  if (!pts.length) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    const [ax, ay] = alignSource(p);
    sx += ax;
    sy += ay;
  }
  return { x: sx / pts.length, y: sy / pts.length };
});

/** 楼层质心（源坐标，未对齐前）：取外轮廓（兜底用全部房间）的几何质心，用作「墙体向内偏移」的朝向基准，
 *  使每道墙都向楼层中心收一个墙厚（最外缘正好压在外轮廓线上，不外伸）。 */
const buildingCentroid = computed(() => {
  let pts: [number, number][] = (props.embedded && props.preview ? props.preview.outline : currentFloor.value?.outline) ?? [];
  if (!pts || pts.length < 3) {
    pts = [];
    for (const r of displayedRooms.value) for (const p of polyOf(r)) pts.push(p);
  }
  if (!pts.length) return { x: 0, y: 0 };
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  return { x: cx / pts.length, y: cy / pts.length };
});

/** 2.5D 斜投影核心（纯仿射：对角 + 剪切，无透视除法 → 恒为平行四边形，绝不退化成梯形）。
 *  输入为「源对齐转正」后的 (ax, ay) 与抬升高度 z：
 *    ix = ax + (ay - ayc) * SX   —— 水平宽度原样保留；深度 ay 相对楼层中心 ayc 错切 SX，形成斜投影的平行四边形底面（绕中心居中，避免整栋向右偏）
 *    iy = ay * SY - z * Z_EXAG    —— 深度按 SY=cos(俯仰) 竖向压缩；墙高 z 竖直抬升（屏幕 Y 向上为负）
 *  该变换保平行性：矩形楼面恒为平行四边形、墙体恒为平行四边形侧壁，杜绝「上窄下宽」的梯形错觉。 */
function projectXY(ax: number, ay: number, z: number): [number, number] {
  const ayc = projectionCenter.value.y;
  const ix = ax + (ay - ayc) * SX.value;
  const iy = ay * K.value - z * Z_EXAG;
  return [ix, iy];
}

const fit = computed(() => {
  // 先按投影算整层（含墙顶 z=wallHeight）的屏幕包围盒，再求缩放与居中
  let minIX = Infinity, maxIX = -Infinity, minIY = Infinity, maxIY = -Infinity;
  const consider = (x: number, y: number, z: number) => {
    const [ax, ay] = alignSource([x, y]);
    const [ix, iy] = projectXY(ax, ay, z);
    if (ix < minIX) minIX = ix;
    if (ix > maxIX) maxIX = ix;
    if (iy < minIY) minIY = iy;
    if (iy > maxIY) maxIY = iy;
  };
  const outline =
    (props.embedded && props.preview ? props.preview.outline : currentFloor.value?.outline) ?? [];
  for (const pt of outline) {
    consider(pt[0], pt[1], BUILDING_H); // 楼板顶面（第 1 步地板）须纳入包围盒，避免被裁切
    consider(pt[0], pt[1], BUILDING_H + WALL_H); // 房间之间隔墙顶面（抬升 0.5m）亦须纳入，避免被裁切
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

/** 第 1 步（精简）：地板的「楼板顶面」——一块躺下去的长方形地板（零错切，顶面=水平长方形）。
 *  仅保留顶面(z=BUILDING_H, 近白 #f4f7fb：从斜上方俯视看进去的楼板)，不再绘制整楼连续前墙。
 *  理由：现在房间平铺在此楼板上、且房间四周已有 0.5m 抬升的隔墙(含最外圈外墙)勾出整栋楼轮廓，
 *  再画一条 3m 高的整楼前墙会沦为「底部一大块灰色」、与内部矮墙风格冲突，故去掉。
 *  不画任何房间、走廊、文字。 */
const buildingBox = computed<{ top: string; sides: Face[] } | null>(() => {
  const poly = outlinePoints.value;
  if (!poly || poly.length < 3) return null;
  const H = BUILDING_H;
  const P = (p: [number, number], z: number) => project(p[0], p[1], z);
  const q = (p: [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  const top = poly.map((p) => q(P(p, H))).join(' ');
  // 不再生成侧面（前墙）多边形：楼板顶面即地板，外圈由 0.5m 隔墙勾勒。
  const sides: Face[] = [];
  return { top, sides };
});

/** 第 2 步：在顶面上「画出来」的一条走廊带（不是独立盒子，无侧墙/无边框凸起）。
 *  在「源对齐转正」坐标系下取楼层包围盒：横向(x)贯穿整栋、纵向(y)取中线 ± 进深/12（带宽 = 进深/6），
 *  与顶面同处 z=BUILDING_H 平面，画在顶面之上即呈现为楼板上的一条浅灰带子。颜色比顶面(#f4f7fb)深一点。 */
const corridorBand = computed<string | null>(() => {
  const poly = outlinePoints.value;
  if (!poly || poly.length < 3) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of poly) {
    const [ax, ay] = alignSource(p);
    if (ax < minX) minX = ax;
    if (ax > maxX) maxX = ax;
    if (ay < minY) minY = ay;
    if (ay > maxY) maxY = ay;
  }
  if (!isFinite(minX)) return null;
  const depth = Math.max(maxY - minY, 1e-6);
  const midY = (minY + maxY) / 2;
  const half = depth / 12; // 带宽 = 进深/6
  const z = BUILDING_H;
  const f = fit.value;
  const P = (ax: number, ay: number) => {
    const [ix, iy] = projectXY(ax, ay, z);
    return `${(ix * f.scale + f.padX).toFixed(1)},${(iy * f.scale + f.padY).toFixed(1)}`;
  };
  return [P(minX, midY - half), P(maxX, midY - half), P(maxX, midY + half), P(minX, midY + half)].join(' ');
});

/** 第 3+4 步：在走廊两侧划分 12 个房间（上排 6 + 下排 6），每个房间=平铺在地板(BUILDING_H)上的「彩色矩形色块」——不做任何立体、不画侧墙。
 *  - 源对齐转正坐标系下取楼层包围盒；横向(x)贯穿整栋、纵向(y)以中线为界，上排 [minY, midY-half]、下排 [midY+half, maxY]；
 *  - 每排横向均分 6 份（ROOM_COLS），相邻房间共用边界 → 紧贴无空隙、顶到左右两边无外边距；不覆盖中间走廊带；
 *  - 房间平铺、保留颜色与四行文字；凹凸感改由「房间之间的隔墙(roomWalls)」表达（房间平、隔墙凸、走廊凹）。
 *  - 颜色：所有普通房间统一浅蓝(NORMAL_TOP)、不做渐变；少数特殊房间醒目色标出（颜色只区分普通/特殊）。 */
const ROOM_COLS = 6;
/** 普通房间统一顶面色（浅蓝）；不区分排、不按列渐变。 */
const NORMAL_TOP = '#cfe2f3';
/** 普通房间前墙色（同色深色版本，制造明暗对比）。 */
const NORMAL_SIDE = '#a9c7e0';
const NORMAL_STROKE = '#7c8392';
/** 特殊房间（id 形如 `r{排}_{列}`）：醒目色标出「需注意」的房间；side 为其深色版本。 */
const SPECIAL: Record<string, { fill: string; side: string; stroke: string; number: string; name: string; dept: string; area: string }> = {
  '0_2': { fill: '#d6453f', side: '#b5372f', stroke: '#a32e2a', number: '103', name: '配电室', dept: '后勤处', area: '42.10㎡ / 42.10㎡' },
  '0_5': { fill: '#d6453f', side: '#b5372f', stroke: '#a32e2a', number: '106', name: '消防控制室', dept: '安保处', area: '38.55㎡ / 38.55㎡' },
  '1_3': { fill: '#8e5bd1', side: '#6f43a8', stroke: '#6b3fa6', number: '204', name: '档案涉密室', dept: '档案科', area: '51.20㎡ / 51.20㎡' },
};
/** 普通房间的样例数据（按 排×列 生成，仅用于预览展示）。 */
const ROOM_SAMPLE: { names: string[]; depts: string[]; areas: string[] } = {
  names: ['办公室', '会议室', '实验室', '资料室', '设备间', '休息室'],
  depts: ['侦查系', '刑技系', '治安系', '交管系', '网安系', '法化系'],
  areas: ['69.84㎡ / 108.25㎡', '74.30㎡ / 112.60㎡', '82.15㎡ / 120.40㎡', '58.90㎡ / 95.30㎡', '45.20㎡ / 71.10㎡', '63.75㎡ / 98.40㎡'],
};
/** 预览态（无真实入库房间）下，弹窗内对合成房间的本地覆盖（业务状态 / 隐藏等），保证交互可闭环；真实房间走 store。 */
const synthOverrides = reactive<Record<string, Partial<RoomLike>>>({});

const roomBlocks = computed<RoomBlock[]>(() => {
  const poly = outlinePoints.value;
  if (!poly || poly.length < 3) return [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of poly) {
    const [ax, ay] = alignSource(p);
    if (ax < minX) minX = ax;
    if (ax > maxX) maxX = ax;
    if (ay < minY) minY = ay;
    if (ay > maxY) maxY = ay;
  }
  if (!isFinite(minX)) return [];
  const width = Math.max(maxX - minX, 1e-6);
  const depth = Math.max(maxY - minY, 1e-6);
  const midY = (minY + maxY) / 2;
  const half = depth / 12; // 走廊半宽 = 进深/12（带宽 = 进深/6）
  const zBase = BUILDING_H;             // 地板高度（房间/走廊均平铺在此平面）
  const zTop = BUILDING_H;              // 房间=平铺色块，不再整体抬升；凹凸感由 roomWalls 隔墙表达
  const f = fit.value;
  const P = (ax: number, ay: number, z: number): [number, number] => {
    const [ix, iy] = projectXY(ax, ay, z);
    return [ix * f.scale + f.padX, iy * f.scale + f.padY];
  };
  const bands: { y0: number; y1: number; prefix: number }[] = [
    { y0: minY, y1: midY - half, prefix: 1 },
    { y0: midY + half, y1: maxY, prefix: 2 },
  ];
  const blocks: RoomBlock[] = [];
  bands.forEach((band, bi) => {
    for (let c = 0; c < ROOM_COLS; c++) {
      const x0 = minX + (width * c) / ROOM_COLS;
      const x1 = minX + (width * (c + 1)) / ROOM_COLS;
      const y0 = band.y0;
      const y1 = band.y1; // 较大的 ay = 朝向观察者的前边
      // 顶面四个角（z=zTop，亮色）
      const t0 = P(x0, y0, zTop);
      const t1 = P(x1, y0, zTop);
      const t2 = P(x1, y1, zTop);
      const t3 = P(x0, y1, zTop);
      const topPoints = `${t0[0].toFixed(1)},${t0[1].toFixed(1)} ${t1[0].toFixed(1)},${t1[1].toFixed(1)} ${t2[0].toFixed(1)},${t2[1].toFixed(1)} ${t3[0].toFixed(1)},${t3[1].toFixed(1)}`;
      const cx = (t0[0] + t1[0] + t2[0] + t3[0]) / 4;
      const cy = (t0[1] + t1[1] + t2[1] + t3[1]) / 4;
      const roomHpx = Math.abs(t0[1] - t3[1]); // 房间顶面屏幕竖向像素高度
      // 四行文字自适应字号（房间越高字越大，但夹紧在可读/可放范围内）
      const gap = Math.max(roomHpx * 0.21, 8);
      const sizeNumber = Math.min(Math.max(gap * 0.95, 10), 16);
      const sizeOther = Math.min(Math.max(gap * 0.62, 7.5), 11);
      const top = cy - gap * 1.5;

      const idx = bi * ROOM_COLS + c;
      const real = displayedRooms.value[idx] ?? null;
      const sp = SPECIAL[`${bi}_${c}`];
      const isSpecial = !!sp;
      const number = real?.code || (sp ? sp.number : `${band.prefix}${String(c + 1).padStart(2, '0')}`);
      const name = real?.name || (sp ? sp.name : ROOM_SAMPLE.names[c]!);
      const dept = real?.dept || (sp ? sp.dept : ROOM_SAMPLE.depts[c]!);
      const area = real
        ? `${real.useArea > 0 ? real.useArea.toFixed(2) : '—'}㎡ / ${real.buildArea > 0 ? real.buildArea.toFixed(2) : '—'}㎡`
        : sp
          ? sp.area
          : ROOM_SAMPLE.areas[c]!;

      // 该格子对应的房间对象：优先使用真实入库房间，否则合成一个占位 ParsedRoom 供弹窗展示/编辑
      let room: RoomLike;
      if (real) {
        room = real;
      } else {
        const m = area.match(/([\d.]+)\s*㎡\s*\/\s*([\d.]+)\s*㎡/);
        const base: ParsedRoom = {
          id: `r${bi}_${c}`,
          buildingName: props.buildingName ?? '',
          floorNo: selectedFloor.value,
          code: number,
          number,
          name,
          dept,
          usePurpose: '',
          useArea: m ? parseFloat(m[1]) : 0,
          buildArea: m ? parseFloat(m[2]) : 0,
          polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
          centroid: [(x0 + x1) / 2, (y0 + y1) / 2],
          area: Math.abs((x1 - x0) * (y1 - y0)),
          inspectStatus: 'normal',
          useStatus: '' as UseStatus,
          selected: true,
          layers: [],
          unmatchedTexts: [],
        };
        const ov = synthOverrides[base.id];
        room = ov ? ({ ...base, ...ov } as ParsedRoom) : base;
      }
      // 隐藏（预览态剔除 / 真实态 store 已剔除）的房间不渲染格子
      if ((room as ParsedRoom).selected === false) return;

      blocks.push({
        id: room.id,
        room,
        topPoints,
        sidePoints: '', // 平铺色块无侧壁
        topFill: isSpecial ? sp!.fill : NORMAL_TOP,
        sideFill: isSpecial ? sp!.side : NORMAL_SIDE,
        stroke: isSpecial ? sp!.stroke : NORMAL_STROKE,
        cx,
        cy,
        number,
        name,
        dept,
        area,
        special: isSpecial,
        textColor: isSpecial ? '#ffffff' : '#2d3a47',
        yNumber: top,
        yName: top + gap,
        yDept: top + gap * 2,
        yArea: top + gap * 3,
        sizeNumber,
        sizeOther,
      });
    }
  });
  return blocks;
});

/** 房间之间的「隔墙」（第 5 步，表达凹凸感）：平铺的房间色块之间，用一条抬升 WALL_H(0.5米) 的矮墙分隔。
 *  - 内部隔墙：每排房间之间 5 道纵向隔墙 + 上下两排与走廊之间各 1 道横向隔墙（共 12 道）。
 *  - 外圈隔墙（用户明确要求补齐）：最上(y=minY)/最下(y=maxY)两条横向外边 + 最左(x=minX)/最右(x=maxX)两条纵向外边，
 *    使整栋楼四周都立起 0.5m 高的外墙，与内部隔墙同款（房间平、墙凸、走廊凹，凹凸感贯通全楼）。
 *  - 房间平铺、隔墙凸出 → 房间平、墙凸、走廊凹，凹凸感成立；墙是站在同一块地板上的连续矮墙（非悬浮）。
 *  - 投影 SX=0（顶面保持长方形）：纵向隔墙靠「顶面抬升 + 轻微右上位移(WALL_PX*0.5)」露出墙体侧面；横向隔墙靠纯竖直抬升露出前脸。 */
const roomWalls = computed<WallBox[]>(() => {
  const poly = outlinePoints.value;
  if (!poly || poly.length < 3) return [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of poly) {
    const [ax, ay] = alignSource(p);
    if (ax < minX) minX = ax;
    if (ax > maxX) maxX = ax;
    if (ay < minY) minY = ay;
    if (ay > maxY) maxY = ay;
  }
  if (!isFinite(minX)) return [];
  const width = Math.max(maxX - minX, 1e-6);
  const depth = Math.max(maxY - minY, 1e-6);
  const midY = (minY + maxY) / 2;
  const half = depth / 12;
  const z = BUILDING_H;
  const f = fit.value;
  const P = (ax: number, ay: number): [number, number] => {
    const [ix, iy] = projectXY(ax, ay, z);
    return [ix * f.scale + f.padX, iy * f.scale + f.padY];
  };
  const wallPx = WALL_H * Z_EXAG * f.scale; // 0.5 米在屏幕上的抬升像素
  // 隔墙中线集合
  const segs: { horiz: boolean; a: [number, number]; b: [number, number] }[] = [];
  const rows: { y0: number; y1: number }[] = [
    { y0: minY, y1: midY - half },
    { y0: midY + half, y1: maxY },
  ];
  // 每排房间之间的纵向隔墙（c=1..5）
  for (const row of rows) {
    for (let c = 1; c < ROOM_COLS; c++) {
      const xc = minX + (width * c) / ROOM_COLS;
      segs.push({ horiz: false, a: [xc, row.y0], b: [xc, row.y1] });
    }
  }
  // 上下两排与走廊之间的横向隔墙（各 1 道）
  segs.push({ horiz: true, a: [minX, midY - half], b: [maxX, midY - half] });
  segs.push({ horiz: true, a: [minX, midY + half], b: [maxX, midY + half] });
  // 外圈隔墙（补齐四周外墙）：最上 / 最下两条横向外边 + 最左 / 最右两条纵向外边，贯穿整栋楼
  segs.push({ horiz: true, a: [minX, minY], b: [maxX, minY] }); // 最上横线
  segs.push({ horiz: true, a: [minX, maxY], b: [maxX, maxY] }); // 最下横线
  segs.push({ horiz: false, a: [minX, minY], b: [minX, maxY] }); // 最左竖线（外墙，贯穿全深）
  segs.push({ horiz: false, a: [maxX, minY], b: [maxX, maxY] }); // 最右竖线（外墙，贯穿全深）

  const q = (p: [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  const walls: WallBox[] = [];
  segs.forEach((seg, idx) => {
    // 平面占位矩形（WALL_T 厚度）的四角（按顺时针）
    let basePlan: [number, number][];
    if (seg.horiz) {
      const yc = seg.a[1];
      basePlan = [
        [seg.a[0], yc - WALL_T / 2],
        [seg.b[0], yc - WALL_T / 2],
        [seg.b[0], yc + WALL_T / 2],
        [seg.a[0], yc + WALL_T / 2],
      ];
    } else {
      const xc = seg.a[0];
      basePlan = [
        [xc - WALL_T / 2, seg.a[1]],
        [xc + WALL_T / 2, seg.a[1]],
        [xc + WALL_T / 2, seg.b[1]],
        [xc - WALL_T / 2, seg.b[1]],
      ];
    }
    const b = basePlan.map(([x, y]) => P(x, y));
    // 顶面：在屏幕坐标上整体抬升 wallPx；纵向隔墙额外轻微右移，露出墙体侧面（SX=0 下竖向墙否则不可见）
    const dispX = seg.horiz ? 0 : wallPx * 0.5;
    const dispY = -wallPx;
    const t = b.map(([sx, sy]) => [sx + dispX, sy + dispY] as [number, number]);
    const sides: string[] = [];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      sides.push(`${q(b[i]!)} ${q(b[j]!)} ${q(t[j]!)} ${q(t[i]!)}`);
    }
    const top = `${q(t[0]!)} ${q(t[1]!)} ${q(t[2]!)} ${q(t[3]!)}`;
    walls.push({ id: `w${idx}`, sides, top, stroke: '#8a93a3' });
  });
  return walls;
});

function toScreen(p: [number, number]): [number, number] {
  return project(p[0], p[1], 0);
}

/** 2.5D 投影（斜投影，纯仿射：无旋转项，但有水平错切）：平面点 (x,y) 抬升 z 米后的屏幕坐标。
 *    screenX = x + (y - yc) * SX        （水平宽度原样 + 深度绕楼层中心 yc 错切 SX=sin(俯仰)×0.16 → 平行四边形底面，居中不右倾）
 *    screenY = y * SY - z * Z_EXAG      （SY=cos(俯仰)：深度方向竖向压缩；z 为墙高抬升，向上为正）
 *  纯仿射（保平行性）→ 轴对齐矩形恒为平行四边形、阳角对应平行、墙体竖直；绝不退化成上窄下宽的梯形（那需要透视除法）。
 *  立体感来自墙体侧面暗色多边形 + 顶面亮色 + 按屏幕 Y 升序绘制（见 wallFaces / wallSideFaces）。 */
function project(x: number, y: number, z: number): [number, number] {
  const f = fit.value;
  // 渲染路径必须与 fit 一致地先「源对齐转正」再投影（否则斜画 DXF 矩形会被原样画出、与 fit 包围盒错位）。
  // 对齐后做斜投影（竖向压缩 SY=cos(俯仰) + 水平错切 SX=sin(俯仰)）：底面呈平行四边形、墙体竖直抬升成平行四边形侧壁。
  const [ax, ay] = alignSource([x, y]);
  const [ix, iy] = projectXY(ax, ay, z);
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

/** 第 3 步：房间只是「顶面上的色块分区」——一块平铺在顶面(z=BUILDING_H)平面上的彩色矩形，
 *  带一条细分隔线(描边)表示墙；不做任何立体、不画侧墙（整栋楼只有第 1 步那一圈侧墙）。 */
interface RoomBlock {
  id: string;
  /** 该格子对应的房间数据（真实 Room / ParsedRoom，或预览合成的占位对象）；点击时交由弹窗展示与编辑 */
  room: RoomLike;
  /** 顶面多边形（z=BUILDING_H+ROOM_THICK，亮色） */
  topPoints: string;
  /** 朝向观察者的前墙多边形（z=BUILDING_H→BUILDING_H+ROOM_THICK，同色深色版本） */
  sidePoints: string;
  topFill: string;
  sideFill: string;
  stroke: string;
  /** 房间顶面的屏幕几何中心，文字锚点 */
  cx: number;
  cy: number;
  /** 第 1 行：房间号码（最大、加粗） */
  number: string;
  /** 第 2 行：房间名称 */
  name: string;
  /** 第 3 行：部门名称 */
  dept: string;
  /** 第 4 行：两个面积 */
  area: string;
  /** 是否特殊房间（用醒目色标出） */
  special: boolean;
  /** 文字颜色：普通房间深色、特殊房间白色以保证对比 */
  textColor: string;
  /** 四行文字的 y 坐标与各自字号（已按房间屏幕高度自适应） */
  yNumber: number;
  yName: number;
  yDept: number;
  yArea: number;
  sizeNumber: number;
  sizeOther: number;
}

/** 房间之间的「隔墙」（抬升 0.5m 的矮墙，表达凹凸感）：一个墙体盒子 = 4 个侧面 + 1 个顶面。 */
interface WallBox {
  id: string;
  /** 4 个侧面 quad（屏幕坐标多边形字符串），按方向填充暗色 → 露出墙体厚度 */
  sides: string[];
  /** 顶面 quad（屏幕坐标多边形字符串），比侧面亮 */
  top: string;
  stroke: string;
}

/** 单个房间的平铺填充（z=0 地面，无侧面）+ 其文字标签 */
interface RoomFill {
  id: string;
  room: RoomLike;
  /** 房间顶面（屏幕坐标，z=H） */
  points: string;
  fill: string;
  stroke: string;
  dimmed: boolean;
  /** 朝向观察者的可见侧墙（z=0→H，较顶面更暗） */
  sides: Face[];
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
  // 两面明暗着色必须基于「源对齐转正后」的墙段方向分类，而非原始 DXF 方向——
  // 否则斜画楼栋经 alignSource 旋转后，源方向分类会错位，导致左右侧壁明暗不一致、盒子读不出。
  const [aax, aay] = alignSource(a);
  const [bax, bay] = alignSource(b);
  const dx = bax - aax;
  const dy = bay - aay;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const t = WALL_THICK / 2;
  let A1: [number, number] = [a[0] + nx * t, a[1] + ny * t];
  let B1: [number, number] = [b[0] + nx * t, b[1] + ny * t];
  let A2: [number, number] = [a[0] - nx * t, a[1] - ny * t];
  let B2: [number, number] = [b[0] - nx * t, b[1] - ny * t];
  // 向内偏移一个墙厚：把整道墙朝「楼层质心」方向平移 t，使最外缘正好压在源墙线上（外轮廓墙不再向外伸出 → 修复「最外层横向墙体两头冒出来」）。
  // 平移后墙体完全落在源线内侧、厚度不变（仍为 WALL_THICK），既消除外冒、又不侵占房间格子。
  {
    const midX = (a[0] + b[0]) / 2;
    const midY = (a[1] + b[1]) / 2;
    let inx = buildingCentroid.value.x - midX;
    let iny = buildingCentroid.value.y - midY;
    const il = Math.hypot(inx, iny) || 1;
    inx /= il;
    iny /= il;
    const shx = inx * t;
    const shy = iny * t;
    A1 = [A1[0] + shx, A1[1] + shy];
    B1 = [B1[0] + shx, B1[1] + shy];
    A2 = [A2[0] + shx, A2[1] + shy];
    B2 = [B2[0] + shx, B2[1] + shy];
  }
  const H = wallHeight.value;
  const P = (p: [number, number], z: number): [number, number] => project(p[0], p[1], z);
  const q = (p: [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  // 2.5D 两面明暗着色：沿对齐后 X 轴（水平/正面）的墙=较亮，沿 Y 轴（深度/侧面）的墙=较暗。
  // 基于「对齐后」方向分类，保证左右两侧壁（均为深度墙）明暗一致，盒子立体感对称清晰。
  const isXWall = Math.abs(dx) >= Math.abs(dy);
  const frontFill = 'rgba(158,166,180,0.92)'; // 正面墙：较亮灰
  const sideFill = 'rgba(112,120,136,0.92)'; // 侧面墙：较暗灰（深度方向，强化立体）
  const longFill = isXWall ? frontFill : sideFill;
  const endFill = isXWall ? sideFill : frontFill;
  const topFill = '#e3e8ef'; // 楼顶(拉伸墙顶部面)：浅灰，区别于白色房间地面，呈现「盖子」悬浮感
  const sides: Face[] = [
    { points: `${q(P(A1, 0))} ${q(P(B1, 0))} ${q(P(B1, H))} ${q(P(A1, H))}`, fill: longFill },
    { points: `${q(P(A2, 0))} ${q(P(B2, 0))} ${q(P(B2, H))} ${q(P(A2, H))}`, fill: longFill },
    { points: `${q(P(A1, 0))} ${q(P(A2, 0))} ${q(P(A2, H))} ${q(P(A1, H))}`, fill: endFill },
    { points: `${q(P(B1, 0))} ${q(P(B2, 0))} ${q(P(B2, H))} ${q(P(B1, H))}`, fill: endFill },
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
/** 房间几何质心（源坐标），由多边形顶点反推（不依赖 room.centroid 字段，杜绝持久化缺失导致的 NaN）。 */
function centroidOf(room: RoomLike): [number, number] {
  const poly = polyOf(room);
  if (!poly.length) return room.centroid ?? [0, 0];
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p[0];
    y += p[1];
  }
  return [x / poly.length, y / poly.length];
}
/** ③ 房间盒子渲染（取代原先 z=0 平铺卡片）：每个房间=有高度的长方体——
 *  顶面(z=H, 较亮) + 朝向观察者的可见侧墙(z=0→H, 较暗)；由远及近排序绘制使近处盒子盖住远处；
 *  盒子之间未被覆盖的底板(①层 light 灰)即自然露出「走廊」。 */
const roomFills = computed<RoomFill[]>(() => {
  const blocks = displayedRooms.value.map((room) => {
    const poly = polyOf(room);
    const H = wallHeight.value;
    // 房间盒子向内收一点(INSET)：在相邻房间、上下两排之间留出可见的走廊/隔墙缝；
    // 仅相对各自质心收缩，房间中心位置与 6列×2排 的排布均不变。
    const INSET = 0.06;
    let icx = 0;
    let icy = 0;
    for (const p of poly) {
      icx += p[0];
      icy += p[1];
    }
    icx /= poly.length;
    icy /= poly.length;
    const ipoly = poly.map(
      (p) => [icx + (p[0] - icx) * (1 - INSET), icy + (p[1] - icy) * (1 - INSET)] as [number, number],
    );
    // 对齐后多边形（法线/可见性判定须与 project 内部的 alignSource 一致）
    const apoly = ipoly.map((p) => alignSource(p));
    const acx = apoly.reduce((s, p) => s + p[0], 0) / apoly.length;
    const acy = apoly.reduce((s, p) => s + p[1], 0) / apoly.length;
    // 顶面（z=H，较亮）
    const topPts = ipoly.map((p) => project(p[0], p[1], H));
    const points = topPts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    // 可见侧墙：仅画「朝向观察者」的边（外法线 n 满足 n·v<0，v=(-SX,1) 为竖向深度方向）
    const sides: Face[] = [];
    const q = (p: [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    for (let i = 0; i < apoly.length; i++) {
      const a = apoly[i]!;
      const b = apoly[(i + 1) % apoly.length]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      let nx = dy / len;
      let ny = -dx / len;
      // 外法线：应指向房间外侧
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      if (nx * (acx - mx) + ny * (acy - my) > 0) {
        nx = -nx;
        ny = -ny;
      }
      // 可见性：n·v < 0（v=(-SX,1)），背向观察者的边剔除，避免背面墙穿出盖住顶面
      if (nx * -SX.value + ny * 1 >= 0) continue;
      // 底面 z=0 → 顶面 z=H 的竖向侧壁 quad
      const srcA = ipoly[i]!;
      const srcB = ipoly[(i + 1) % ipoly.length]!;
      const Pa0 = project(srcA[0], srcA[1], 0);
      const Pb0 = project(srcB[0], srcB[1], 0);
      const PaH = project(srcA[0], srcA[1], H);
      const PbH = project(srcB[0], srcB[1], H);
      // 前墙(法线偏 ±y)稍亮、侧墙(法线偏 ±x)更暗，强化长方体立体
      const isFront = Math.abs(ny) >= Math.abs(nx);
      const fill = isFront ? 'rgba(150,158,172,0.96)' : 'rgba(112,120,136,0.96)';
      sides.push({ points: `${q(Pa0)} ${q(Pb0)} ${q(PbH)} ${q(PaH)}`, fill });
    }
    // 标签锚点：顶面质心（z=H），文字落在盒子顶面上
    const c: [number, number] =
      topPts.length > 0
        ? [
            topPts.reduce((s, p) => s + p[0], 0) / topPts.length,
            topPts.reduce((s, p) => s + p[1], 0) / topPts.length,
          ]
        : toScreen(room.centroid ?? [0, 0]);
    const baseLines = buildLabelLines(room);
    const startY = c[1] - ((baseLines.length - 1) * LINE_GAP) / 2;
    const lines: LabelLine[] = baseLines.map((ln, i) => ({ ...ln, y: startY + i * LINE_GAP }));
    return {
      id: room.id,
      room,
      points,
      fill: '#ffffff',
      stroke: '#c4cbd4',
      dimmed: room.selected === false,
      sides,
      lines,
      labelX: c[0],
    };
  });
  // 由远及近排序：对齐质心 ay 升序（小 ay=远=先画），近处盒子盖住远处盒子，纵深成立
  blocks.sort((p, q) => {
    const cp = alignSource(centroidOf(p.room));
    const cq = alignSource(centroidOf(q.room));
    return cp[1] - cq[1];
  });
  return blocks;
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

// ---- 交互：仅点击选中弹出小卡片（已移除 hover tooltip，避免遮挡与误触）----
const selectedId = ref<string | null>(null);
/** 点击房间弹出的小卡片位置（stage 内像素坐标）与展开模式 */
const popupPos = ref({ x: 0, y: 0 });
const popMode = ref<'edit' | 'maint' | null>(null);

/** 当前选中房间（弹窗数据来源）。直接由 onSelect 赋值（真实或合成 RoomLike），避免仅从 displayedRooms 派生导致合成房间无法被选中。 */
const selectedRoom = ref<RoomLike | null>(null);

/** 弹窗 DOM 引用，用于测量真实尺寸后夹取在舞台内（展开子面板后尺寸变化也能重新适配） */
const popupEl = ref<HTMLElement | null>(null);

/** 按弹窗真实尺寸，把它夹取在舞台可视范围内（防止展开子面板后按钮超出界面） */
function fitPopupInStage(): void {
  const stage = mainRef.value ?? stageRef.value;
  const el = popupEl.value;
  if (!stage || !el) return;
  const r = stage.getBoundingClientRect();
  const pr = el.getBoundingClientRect();
  if (pr.width <= 0 || pr.height <= 0) return;
  // 当前左上角相对舞台的偏移
  let x = pr.left - r.left;
  let y = pr.top - r.top;
  const pad = 8;
  // 右侧/底部溢出 → 向左/上回拉
  if (pr.right > r.right) x -= pr.right - r.right + pad;
  if (pr.bottom > r.bottom) y -= pr.bottom - r.bottom + pad;
  // 左侧/顶部溢出 → 向右/下推入
  if (pr.left < r.left) x += r.left - pr.left + pad;
  if (pr.top < r.top) y += r.top - pr.top + pad;
  // 最终夹取，保证整张卡片可见
  x = Math.min(Math.max(x, pad), Math.max(pad, r.width - pr.width - pad));
  y = Math.min(Math.max(y, pad), Math.max(pad, r.height - pr.height - pad));
  popupPos.value = { x, y };
}

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

/** 展开 / 收起子面板（修改信息、维护房间信息）会改变弹窗高度，重新夹取位置避免超出界面 */
watch(popMode, () => nextTick(fitPopupInStage));

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
  selectedRoom.value = selectedId.value ? room : null;
  if (!selectedId.value) return;
  popMode.value = null;
  const stage = mainRef.value ?? stageRef.value;
  if (!stage) return;
  const r = stage.getBoundingClientRect();
  let x: number;
  let y: number;
  if (ev) {
    // 以点击点为锚：弹窗左上角贴在点击点（向右下展开）。坐标系相对 .fpv-main（弹窗的真实定位祖先），
    // 与 :style 的 left/top 基准一致，避免「相对 stage 算、却相对 viewport 渲染」导致的错位。
    // 展开子面板时再按真实尺寸夹取回可视范围内，保证「修改信息 / 维护房间信息」按钮不超出界面。
    x = ev.clientX - r.left + 10;
    y = ev.clientY - r.top + 10;
  } else {
    // 由房间列表等无坐标来源触发时，居中偏上
    x = r.width / 2 - 130;
    y = 24;
  }
  // 先给一个初步夹取值，渲染后由 fitPopupInStage 按真实尺寸二次校正
  x = Math.min(Math.max(x, 8), Math.max(8, r.width - 268));
  y = Math.min(Math.max(y, 8), Math.max(8, r.height - 248));
  popupPos.value = { x, y };
  nextTick(() => fitPopupInStage());
}

/** 该房间是否为真实入库房间（存在于 displayedRooms），决定后续是写 store 还是走本地覆盖 */
function isRealRoom(r: RoomLike | null): boolean {
  return !!r && displayedRooms.value.some((x) => x.id === r.id);
}

function setUseStatus(status: UseStatus): void {
  const r = selectedRoom.value;
  if (!r) return;
  if (isRealRoom(r)) {
    const f = currentFloor.value;
    if (f) store.setRoomUseStatus(f.id, r.id, status);
  } else {
    // 合成预览房间：写入本地覆盖，弹窗即时反映
    synthOverrides[r.id] = { ...(synthOverrides[r.id] ?? {}), useStatus: status } as Partial<RoomLike>;
  }
}
function hideRoom(): void {
  const r = selectedRoom.value;
  if (!r) return;
  if (isRealRoom(r)) {
    const f = currentFloor.value;
    if (f) store.setRoomSelected(f.id, r.id, false);
  } else {
    synthOverrides[r.id] = { ...(synthOverrides[r.id] ?? {}), selected: false } as Partial<RoomLike>;
  }
  selectedId.value = null;
  selectedRoom.value = null;
}

/** 关闭房间弹窗（同时清空选中 id 与房间对象，确保 v-if="selectedRoom" 失效）。 */
function closePop(): void {
  selectedId.value = null;
  selectedRoom.value = null;
  popMode.value = null;
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

        <div class="fpv-main" ref="mainRef">
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
            <!-- 楼栋盒子（第 1 步）：整栋楼=一块躺下去的地板。先画朝观察者的侧墙(暗)，再画顶面地板(亮) -->
            <template v-if="buildingBox">
              <polygon
                v-for="(s, si) in buildingBox.sides"
                :key="'bbs' + si"
                :points="s.points"
                :fill="s.fill"
                stroke="#9aa3b2"
                stroke-width="0.5"
                pointer-events="none"
              />
              <polygon :points="buildingBox.top" fill="#f4f7fb" stroke="#8a8a8a" stroke-width="1" pointer-events="none" />
            </template>
            <!-- 走廊带（第 2 步）：顶面上画出来的一条横向浅灰带子，无侧墙/无边框，仅作区域标记；与顶面同平面、画在顶面之上 -->
            <polygon
              v-if="renderStage >= 2 && corridorBand"
              :points="corridorBand"
              fill="#d8e0e9"
              stroke="none"
              pointer-events="none"
            />
            <!-- ③ 房间平铺色块（第 3 步）：每个房间=平铺在地板(BUILDING_H)上的彩色矩形，不做立体、不画侧墙；凹凸感由隔墙表达。
                 整块可点击：点击触发 onSelect 打开房间信息弹窗（真实或合成房间均可）。 -->
            <template
              v-if="renderStage >= 3"
              v-for="rb in roomBlocks"
              :key="rb.id"
            >
              <g
                class="fpv-room"
                :class="{ 'fpv-room--sel': rb.id === selectedId }"
                @click="onSelect(rb.room, $event)"
                style="cursor: pointer"
              >
                <polygon :points="rb.topPoints" :fill="rb.topFill" :stroke="rb.stroke" stroke-width="1" />
              </g>
            </template>
            <!-- ③b 房间之间的隔墙（第 5 步）：平铺房间之间抬升 0.5m 的矮墙，房间平、墙凸 → 凹凸感；先画暗色侧面再画亮色顶面 -->
            <template
              v-if="renderStage >= 3"
              v-for="w in roomWalls"
              :key="w.id"
            >
              <polygon v-for="(s, si) in w.sides" :key="'ws' + si" :points="s" fill="rgba(140,148,162,0.97)" :stroke="w.stroke" stroke-width="0.5" pointer-events="none" />
              <polygon :points="w.top" fill="#cdd5df" :stroke="w.stroke" stroke-width="0.5" pointer-events="none" />
            </template>
            <!-- ⑥ 房间文字（第 4 步）：每个房间顶面正中心四行（号码最大加粗 / 名称 / 部门 / 两面积），水平绘制不倾斜；
                 普通房间深色字、特殊房间白色字保证对比 -->
            <g v-if="renderStage >= 4" class="fpv-labels" pointer-events="none">
              <g v-for="rb in roomBlocks" :key="'L' + rb.id">
                <text :x="rb.cx" :y="rb.yNumber" text-anchor="middle" :font-size="rb.sizeNumber" font-weight="700" :fill="rb.textColor" dominant-baseline="middle">{{ rb.number }}</text>
                <text :x="rb.cx" :y="rb.yName" text-anchor="middle" :font-size="rb.sizeOther" :fill="rb.textColor" dominant-baseline="middle">{{ rb.name }}</text>
                <text :x="rb.cx" :y="rb.yDept" text-anchor="middle" :font-size="rb.sizeOther" :fill="rb.textColor" dominant-baseline="middle">{{ rb.dept }}</text>
                <text :x="rb.cx" :y="rb.yArea" text-anchor="middle" :font-size="rb.sizeOther" :fill="rb.textColor" dominant-baseline="middle">{{ rb.area }}</text>
              </g>
            </g>
            <!-- ① 地面(楼板) + ② 走廊：保留给后续阶段（第 4 步起）；当前第 3 步楼板已由第 1 步盒顶面提供 -->
            <path v-if="renderStage >= 5 && outlinePath" :d="outlinePath" fill="#eef1f5" stroke="#c4cbd4" stroke-width="1.5" pointer-events="none" />
            <!-- ③ 房间盒子（第 5 步起显示，预留）：先画朝向观察者的可见侧墙(较暗)，再画顶面(较亮) -->
            <template
              v-if="renderStage >= 5"
              v-for="rf in roomFills"
              :key="rf.id"
            >
              <g
                class="fpv-room"
                :opacity="rf.dimmed ? 0.18 : 1"
                @click="onSelect(rf.room, $event)"
              >
                <polygon
                  v-for="(s, si) in rf.sides"
                  :key="'rs' + si"
                  :points="s.points"
                  :fill="s.fill"
                  stroke="#9aa3b2"
                  stroke-width="0.5"
                  pointer-events="none"
                />
                <polygon
                  :points="rf.points"
                  :fill="rf.fill"
                  :stroke="rf.stroke"
                  stroke-width="1"
                />
              </g>
            </template>
            <!-- ④ 墙侧面（第 5 步起显示，预留，先画，仅作视觉，不拦截点击） -->
            <polygon
              v-if="renderStage >= 5"
              v-for="(f, i) in wallSideFaces"
              :key="'s' + i"
              :points="f.points"
              :fill="f.fill"
              stroke="none"
              pointer-events="none"
            />
            <!-- ⑤ 墙顶面（第 5 步起显示，预留，后画，盖在侧面上）：浅灰实心面，非白线，不拦截点击 -->
            <polygon
              v-if="renderStage >= 5"
              v-for="(f, i) in wallTopFaces"
              :key="'t' + i"
              :points="f.points"
              :fill="f.fill"
              stroke="#8a8a8a"
              stroke-width="0.5"
              pointer-events="none"
            />
            <!-- ⑥ 文字（第 5 步起显示，预留，最上层） -->
            <g v-if="renderStage >= 5" class="fpv-labels" pointer-events="none">
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
            ref="popupEl"
            class="fpv-pop"
            :style="{ left: popupPos.x + 'px', top: popupPos.y + 'px' }"
            @mousedown.stop
          >
            <div class="fpv-pop__hd">
              <span class="fpv-pop__title">{{ selectedRoom.code || selectedRoom.name || '未命名房间' }}</span>
              <button class="fpv-pop__x" type="button" @click="closePop">×</button>
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
              <el-button size="small" :type="popMode === 'edit' ? 'primary' : 'default'" @click="popMode = popMode === 'edit' ? null : 'edit'">修改信息</el-button>
              <el-button size="small" :type="popMode === 'maint' ? 'primary' : 'default'" @click="popMode = popMode === 'maint' ? null : 'maint'">维护房间信息</el-button>
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
                <el-button size="small" @click="popMode = null">返回</el-button>
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
                <el-button size="small" @click="popMode = null">返回</el-button>
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
                <span class="fpv-tools__hint">整栋楼「盒子」(亮顶面+连续暗色前墙) + 横向走廊带 + 12 个房间(普通统一浅蓝、少数特殊醒目色，平铺色块) + 房间之间 0.5m 抬升隔墙(灰，表达凹凸感：房间平、墙凸、走廊凹) + 每间正中心四行文字(号码/名称/部门/两面积)。颜色只区分「普通/特殊」，无深浅渐变。左键拖拽平移；滚轮缩放；纵向旋转可调俯视角。</span>
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
        <!-- 楼栋盒子（第 1 步）：整栋楼=一块躺下去的地板。先画朝观察者的侧墙(暗)，再画顶面地板(亮) -->
        <template v-if="buildingBox">
          <polygon
            v-for="(s, si) in buildingBox.sides"
            :key="'bbs' + si"
            :points="s.points"
            :fill="s.fill"
            stroke="#9aa3b2"
            stroke-width="0.5"
            pointer-events="none"
          />
          <polygon :points="buildingBox.top" fill="#f4f7fb" stroke="#8a8a8a" stroke-width="1" pointer-events="none" />
        </template>
        <!-- 走廊带（第 2 步）：顶面上画出来的一条横向浅灰带子，无侧墙/无边框；与顶面同平面、画在顶面之上 -->
        <polygon
          v-if="renderStage >= 2 && corridorBand"
          :points="corridorBand"
          fill="#d8e0e9"
          stroke="none"
          pointer-events="none"
        />
        <!-- ③ 房间平铺色块（第 3 步）：每个房间=平铺在地板上的彩色矩形；整块可点击触发 onSelect（嵌入预览模式 emit room-click） -->
        <template
          v-if="renderStage >= 3"
          v-for="rb in roomBlocks"
          :key="rb.id"
        >
          <g
            class="fpv-room"
            :class="{ 'fpv-room--sel': rb.id === selectedId }"
            @click="onSelect(rb.room, $event)"
            style="cursor: pointer"
          >
            <polygon :points="rb.topPoints" :fill="rb.topFill" :stroke="rb.stroke" stroke-width="1" />
          </g>
        </template>
        <!-- ③b 房间之间的隔墙（第 5 步）：平铺房间之间抬升 0.5m 的矮墙，房间平、墙凸 → 凹凸感 -->
        <template
          v-if="renderStage >= 3"
          v-for="w in roomWalls"
          :key="w.id"
        >
          <polygon v-for="(s, si) in w.sides" :key="'ws' + si" :points="s" fill="rgba(140,148,162,0.97)" :stroke="w.stroke" stroke-width="0.5" pointer-events="none" />
          <polygon :points="w.top" fill="#cdd5df" :stroke="w.stroke" stroke-width="0.5" pointer-events="none" />
        </template>
        <!-- ⑥ 房间文字（第 4 步）：每个房间顶面正中心四行（号码最大加粗 / 名称 / 部门 / 两面积），水平不倾斜 -->
        <g v-if="renderStage >= 4" class="fpv-labels" pointer-events="none">
          <g v-for="rb in roomBlocks" :key="'L' + rb.id">
            <text :x="rb.cx" :y="rb.yNumber" text-anchor="middle" :font-size="rb.sizeNumber" font-weight="700" :fill="rb.textColor" dominant-baseline="middle">{{ rb.number }}</text>
            <text :x="rb.cx" :y="rb.yName" text-anchor="middle" :font-size="rb.sizeOther" :fill="rb.textColor" dominant-baseline="middle">{{ rb.name }}</text>
            <text :x="rb.cx" :y="rb.yDept" text-anchor="middle" :font-size="rb.sizeOther" :fill="rb.textColor" dominant-baseline="middle">{{ rb.dept }}</text>
            <text :x="rb.cx" :y="rb.yArea" text-anchor="middle" :font-size="rb.sizeOther" :fill="rb.textColor" dominant-baseline="middle">{{ rb.area }}</text>
          </g>
        </g>
        <!-- ① 地面(楼板) + ② 走廊：保留给后续阶段（第 4 步起） -->
        <path v-if="renderStage >= 5 && outlinePath" :d="outlinePath" fill="#eef1f5" stroke="#c4cbd4" stroke-width="1.5" pointer-events="none" />
        <!-- ③ 房间盒子（第 5 步起显示，预留）：先画可见侧墙(较暗)，再画顶面(较亮) -->
        <template
          v-if="renderStage >= 5"
          v-for="rf in roomFills"
          :key="rf.id"
        >
          <g
            class="fpv-room"
            :opacity="rf.dimmed ? 0.18 : 1"
            @click="onSelect(rf.room, $event)"
          >
            <polygon
              v-for="(s, si) in rf.sides"
              :key="'rs' + si"
              :points="s.points"
              :fill="s.fill"
              stroke="#9aa3b2"
              stroke-width="0.5"
              pointer-events="none"
            />
            <polygon
              :points="rf.points"
              :fill="rf.fill"
              :stroke="rf.stroke"
              stroke-width="1"
            />
          </g>
        </template>
        <!-- ④ 墙侧面（第 5 步起显示，预留，先画，仅作视觉，不拦截点击） -->
        <polygon
          v-if="renderStage >= 5"
          v-for="(f, i) in wallSideFaces"
          :key="'s' + i"
          :points="f.points"
          :fill="f.fill"
          stroke="none"
          pointer-events="none"
        />
        <!-- ⑤ 墙顶面（第 5 步起显示，预留，后画，盖在侧面上）：浅灰实心面，非白线，不拦截点击 -->
        <polygon
          v-if="renderStage >= 5"
          v-for="(f, i) in wallTopFaces"
          :key="'t' + i"
          :points="f.points"
          :fill="f.fill"
          stroke="#8a8a8a"
          stroke-width="0.5"
          pointer-events="none"
        />
        <!-- ⑥ 文字（第 5 步起显示，预留，最上层） -->
        <g v-if="renderStage >= 5" class="fpv-labels" pointer-events="none">
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
.fpv-main { display: flex; gap: 12px; align-items: stretch; position: relative; }
.fpv-stage { position: relative; flex: 1; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; background: linear-gradient(180deg, #8fc1ec 0%, #bfdcf4 55%, #eef6fc 100%); }
.fpv-svg { display: block; width: 100%; height: 60vh; }
.fpv-room { cursor: pointer; }
.fpv-room--sel polygon { stroke: #1f6feb; stroke-width: 2.5; }
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
