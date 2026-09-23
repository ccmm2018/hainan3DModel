<script setup lang="ts">
/**
 * FloorPlan2D：楼层 2.5D 平面图查看器（SVG 渲染，标准 30° 等轴测投影）。
 *
 * 渲染规范：
 * - 渲染架构（建筑分层）：① 楼层外轮廓地面 + ② 走廊（外轮廓减房间，由③层房间覆盖得到）
 *   + ③ 房间平铺填充（z=0 地面，无侧面）+ ④ 墙侧面（外墙线/内墙线拉伸成 wallHeight 米高，先画）
 *   + ⑤ 墙顶面（后画）+ ⑥ 文字标签。墙体高度由「墙高(米)」滑杆驱动。
 * - 倾斜横向（plan oblique / 斜二测）投影（无 3D 引擎依赖）：
 *     screenX = x + y * cos(30°)
 *     screenY = -y * sin(30°) - z
 *   楼地面的 X 轴保持水平（横向），Y 轴沿右上方向倾斜 30° 后退，墙体沿屏幕竖直方向拉出高度，
 *   形成「俯视平铺、倾斜横向」的 2.5D 楼层图，而非 45° 菱形等轴测；
 *   缩放/居中由 fit 对整层（含墙顶 z=wallHeight）的投影包围盒计算；按墙体地面中点屏幕 Y 排序保证遮挡正确。
 * - 房间中央文字：房间号码(14px 粗) / 房间名称(10px) / 部门(9px 灰) / 使用面积(9px 白底圆角)。
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
/** 墙体高度（米）：从墙线拉伸出的真实高度，由侧栏「墙高(米)」滑杆控制（默认 3m）。 */
const wallHeight = ref(3);

/** 倾斜横向（plan oblique / 斜二测）投影系数：
 *  X 轴保持水平（横向），Y 轴沿右上方向倾斜 TILT 角后退，Z（墙高）沿屏幕竖直向上。
 *  平面点 (x,y) 投屏：sx = x + y * OBLIQ_COS，sy = -y * OBLIQ_SIN - z（z 为高度，米）。
 *  TILT=40°（默认初始视角：向观看方向倾斜 40°，sin40°≈0.643，不小于 0.5，不退化成平面）。 */
const OBLIQ_TILT = (40 * Math.PI) / 180; // 40°
const OBLIQ_COS = Math.cos(OBLIQ_TILT); // ≈0.766
const OBLIQ_SIN = Math.sin(OBLIQ_TILT); // ≈0.643
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
  viewRotation.value = 0;
}

/** 视图旋转（度）：绕画面中心旋转整张 2.5D 平面图，默认 0（不旋转）。 */
const viewRotation = ref(0);

// ---- 拖拽平移（在 stage 上按住左键拖动）----
const isPanning = ref(false);
const dragMoved = ref(false);
let dragStart = { x: 0, y: 0, panX: 0, panY: 0 };
function onStageMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return;
  isPanning.value = true;
  dragMoved.value = false;
  dragStart = { x: e.clientX, y: e.clientY, panX: panX.value, panY: panY.value };
}
function onStageMouseMove(e: MouseEvent): void {
  if (!isPanning.value) return;
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved.value = true;
  panX.value = dragStart.panX + dx;
  panY.value = dragStart.panY + dy;
}
function onStageMouseUp(): void {
  isPanning.value = false;
}
function onStageMouseLeave(): void {
  isPanning.value = false;
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

// ---- 显示方向归一化：把斜放的图纸转正为水平 ----
// 背景：CAD 图纸常按楼栋自身轴网绘制（或经锚点配准继承了楼栋相对地图的真实朝向），
// 原始坐标里的楼层平面可能是斜的；toScreen 只做 Y 翻转，会整张斜放。
// 这里用「边长加权 + 角度倍频圆统计」估算墙体主方向（模 90°），仅用于显示时转正，
// 不修改任何持久化数据，也不影响指纹匹配 / 锚点配准。

/** 估算图纸相对坐标轴的旋转角（弧度，折叠到 [-45°, 45°)，接近 0° 时返回 0）。
 *  原理：房间/外轮廓的墙边在楼栋自身坐标系里是横平竖直的，把每条边的方向角 θ
 *  按 e^{i2θ} 做边长加权累计（倍频消除 mod 180° 歧义），合成向量的辐角一半即主方向。 */
const planRotation = computed<number>(() => {
  const polys: [number, number][][] = [];
  const outline = props.preview ? props.preview.outline : (currentFloor.value?.outline ?? null);
  if (outline && outline.length > 2) polys.push(outline);
  for (const r of displayedRooms.value) polys.push(polyOf(r));
  let sx = 0;
  let sy = 0;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i]!;
      const [x2, y2] = poly[(i + 1) % poly.length]!;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const a2 = 2 * Math.atan2(dy, dx);
      sx += len * Math.cos(a2);
      sy += len * Math.sin(a2);
    }
  }
  if (sx === 0 && sy === 0) return 0;
  let theta = Math.atan2(sy, sx) / 2;
  // 折叠到 [-45°, 45°)：转正时取最短旋转，避免长边被竖过来
  if (theta > Math.PI / 4) theta -= Math.PI / 2;
  if (theta < -Math.PI / 4) theta += Math.PI / 2;
  if (Math.abs(theta) < (1 * Math.PI) / 180) theta = 0;
  // 转正后若仍是「竖条」（高 > 宽），再补转 90°，保证楼层图横向铺开（匹配 3D 楼层平面图的横版观感）
  const [cx0, cy0] = rotationCenter.value;
  const bboxAt = (t: number): { w: number; h: number } => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const c = Math.cos(-t);
    const s = Math.sin(-t);
    for (const poly of polys) {
      for (const [px, py] of poly) {
        const dx = px - cx0;
        const dy = py - cy0;
        const x = cx0 + dx * c - dy * s;
        const y = cy0 + dx * s + dy * c;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    return { w: maxX - minX, h: maxY - minY };
  };
  if (bboxAt(theta).h > bboxAt(theta + Math.PI / 2).h) theta += Math.PI / 2;
  return theta;
});

/** 旋转中心：全部几何点的算术平均（与旋转角无关，避免 computed 循环依赖） */
const rotationCenter = computed<[number, number]>(() => {
  let sx = 0;
  let sy = 0;
  let n = 0;
  const outline = props.preview ? props.preview.outline : (currentFloor.value?.outline ?? null);
  if (outline && outline.length > 2) {
    for (const [x, y] of outline) {
      sx += x;
      sy += y;
      n++;
    }
  }
  for (const r of displayedRooms.value) {
    for (const [x, y] of polyOf(r)) {
      sx += x;
      sy += y;
      n++;
    }
  }
  if (!n) return [0, 0];
  return [sx / n, sy / n];
});

/** 把图纸坐标点绕旋转中心转正（planRotation 为 0 时原样返回） */
function rotatePlan(p: [number, number]): [number, number] {
  const t = planRotation.value;
  if (!t) return p;
  const [cx, cy] = rotationCenter.value;
  const dx = p[0] - cx;
  const dy = p[1] - cy;
  const cos = Math.cos(-t);
  const sin = Math.sin(-t);
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

// ---- 坐标变换（标准 30° 等轴测，见 fit / project）----

const fit = computed(() => {
  // 标准 30° 等轴测：先按投影算整层（含墙顶 z=wallHeight）的屏幕包围盒，再求缩放与居中
  let minIX = Infinity, maxIX = -Infinity, minIY = Infinity, maxIY = -Infinity;
  const consider = (x: number, y: number, z: number) => {
    const [rx, ry] = rotatePlan([x, y]);
    const ix = rx + ry * OBLIQ_COS;
    const iy = -ry * OBLIQ_SIN - z * Z_EXAG;
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

/** 倾斜横向（plan oblique）投影：平面点 (x,y) 抬升 z 米后的屏幕坐标（无任何 3D 引擎依赖）。
 *  screenX = x + y * cos(30°)
 *  screenY = -y * sin(30°) - z
 *  楼地面的 X 轴保持水平（横向），Y 轴沿右上倾斜后退，墙体沿屏幕竖直方向拉出高度，
 *  形成俯视平铺、倾斜横向的 2.5D 楼层图（非 45° 菱形等轴测）。 */
function project(x: number, y: number, z: number): [number, number] {
  const f = fit.value;
  const [rx, ry] = rotatePlan([x, y]);
  const ix = rx + ry * OBLIQ_COS;
  const iy = -ry * OBLIQ_SIN - z * Z_EXAG;
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
  rect: { x: number; y: number; w: number; h: number } | null;
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

/** 房间文字标签：固定 6 项（房间号 / 名称 / 部门 / 用途 / 使用面积 / 建筑面积），房间号缺省兜底「未命名」。
 *  去掉原按屏幕面积分档降级逻辑——按需求「文字补全 6 项」。 */
function buildLabelLines(room: RoomLike): Omit<LabelLine, 'y' | 'rect'>[] {
  const code = (room.code || room.number || room.name || '').trim();
  const d = (s: string) => (s.trim() !== '' ? s.trim() : '—');
  return [
    { text: code !== '' ? code : '未命名房间', size: 13, weight: 700, color: '#1f2937', badge: false },
    { text: `名称:${d(room.name)}`, size: 9, weight: 400, color: '#374151', badge: false },
    { text: `部门:${d(room.dept)}`, size: 9, weight: 400, color: '#6b7280', badge: false },
    { text: `用途:${d(room.usePurpose)}`, size: 9, weight: 400, color: '#6b7280', badge: false },
    { text: `使用:${room.useArea > 0 ? room.useArea.toFixed(1) : '—'}㎡`, size: 9, weight: 600, color: '#111827', badge: true },
    { text: `建筑:${room.buildArea > 0 ? room.buildArea.toFixed(1) : '—'}㎡`, size: 9, weight: 600, color: '#111827', badge: true },
  ];
}

// ---- 墙体与房间填充（建筑分层渲染：①地面/②走廊 → ③房间 → ④墙侧面 → ⑤墙顶面 → ⑥文字）----

/** 需要渲染墙体的房间（剔除预览阶段未勾选的候选） */
const visibleRooms = computed(() => displayedRooms.value.filter((r) => r.selected !== false));

/** 墙线来源（等效于 DXF 的「内部结构外墙线」+「内部结构内墙线」层）：
 *  - 楼层外轮廓（outerWall 周长，即 外墙线）作为外墙，每条边拉伸成一段墙体；
 *  - 每个房间轮廓（innerWall 房间，即 内墙线）作为内墙，每条边拉伸成一段墙体。
 *  每段墙线 (a,b) 经 wallFaces 拉伸成带厚度的实心盒：4 个侧面（深灰 #8a8a8a）+ 1 个顶面（浅灰 #c8c8c8）。 */
const wallSegments = computed<{ a: [number, number]; b: [number, number]; key: string }[]>(() => {
  const segs: { a: [number, number]; b: [number, number]; key: string }[] = [];
  const outline =
    (props.embedded && props.preview ? props.preview.outline : currentFloor.value?.outline) ?? [];
  const pushLoop = (poly: [number, number][], tag: string) => {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) continue;
      segs.push({ a, b, key: `${tag}-${i}` });
    }
  };
  pushLoop(outline, 'outer');
  for (const r of visibleRooms.value) pushLoop(polyOf(r), `r-${r.id}`);
  return segs;
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
  const sideFill = '#8a8a8a'; // 深灰墙体侧面（用户规范）
  const topFill = '#c8c8c8'; // 浅灰墙体顶面（用户规范）
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
    const color = colorFor(room);
    const stroke = darken(color, 0.45);
    const c = toScreen(room.centroid);
    const baseLines = buildLabelLines(room);
    const startY = c[1] - ((baseLines.length - 1) * LINE_GAP) / 2;
    const lines: LabelLine[] = baseLines.map((ln, i) => {
      const y = startY + i * LINE_GAP;
      let rect: LabelLine['rect'] = null;
      if (ln.badge) {
        const w = Math.max(ln.text.length * ln.size * 0.62 + 8, 22);
        const h = ln.size + 6;
        rect = { x: c[0] - w / 2, y: y - h / 2, w, h };
      }
      return { ...ln, y, rect };
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

// ---- 交互：hover / 选中 / tooltip ----
const hoveredId = ref<string | null>(null);
const selectedId = ref<string | null>(null);
/** 点击房间弹出的小卡片位置（stage 内像素坐标）与展开模式 */
const popupPos = ref({ x: 0, y: 0 });
const popMode = ref<'edit' | 'maint' | null>(null);
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

/** 选中房间变化时，同步加载其维护信息到表单 */
watch(selectedRoom, (r) => loadMaint(r), { immediate: true });

function onSelect(room: RoomLike, ev?: MouseEvent): void {
  if (props.embedded) {
    emit('room-click', room as ParsedRoom);
    return;
  }
  // 拖拽平移结束后松手会触发一次 click，需忽略（避免误选）
  if (dragMoved.value) {
    dragMoved.value = false;
    return;
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
    :title="`${buildingName} · 楼宇分层图（2.5D）`"
    width="80%"
    top="5vh"
    :fullscreen="fullscreen"
    :show-header="!fullscreen"
    :show-close="!fullscreen"
    class="fpv-dialog"
  >
    <el-empty v-if="!floors.length" description="暂无室内图纸，请先导入">
      <el-button type="primary" @click="requestImport">导入图纸</el-button>
    </el-empty>

    <div v-else class="fpv fpv--ws">
      <div v-if="fullscreen" class="fpv__head">
        <strong class="fpv__title">{{ buildingName }} · 楼宇分层图（2.5D）</strong>
        <el-button link type="primary" @click="visible = false">← 返回地图</el-button>
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
            <rect x="0" y="0" :width="VIEW_W" :height="VIEW_H" fill="#fbfcfe" pointer-events="none" />
            <g :transform="`rotate(${viewRotation} ${VIEW_W / 2} ${VIEW_H / 2})`">
            <!-- ① 地面(楼板) + ② 走廊：楼层外轮廓填充；房间在③层覆盖其上，自然得到「外轮廓减房间」的走廊区 -->
            <path v-if="outlinePath" :d="outlinePath" fill="#eef1f5" stroke="#c4cbd4" stroke-width="1.5" pointer-events="none" />
            <!-- ③ 房间平铺填充（z=0 地面，无侧面） -->
            <g
              v-for="rf in roomFills"
              :key="rf.id"
              class="fpv-room"
              :opacity="rf.dimmed ? 0.18 : 1"
              @mouseenter="onEnter(rf.room, $event)"
              @mouseleave="onLeave"
              @click="onSelect(rf.room, $event)"
            >
              <polygon
                :points="rf.points"
                :fill="rf.fill"
                :stroke="rf.stroke"
                :stroke-width="hoveredId === rf.id ? 2.5 : 1"
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
                  <rect
                    v-if="ln.rect"
                    :x="ln.rect.x"
                    :y="ln.rect.y"
                    :width="ln.rect.w"
                    :height="ln.rect.h"
                    rx="6"
                    fill="#ffffff"
                    :stroke="rf.stroke"
                    stroke-width="0.4"
                  />
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

          <!-- 点击房间弹出的小卡片：房间信息 + 修改 / 维护入口（替代原右侧房间信息面板） -->
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
            <div class="fpv-pop__info">
              <div><span>名称</span><b>{{ selectedRoom.name || '—' }}</b></div>
              <div><span>部门</span><b>{{ selectedRoom.dept || '—' }}</b></div>
              <div><span>用途</span><b>{{ selectedRoom.usePurpose || '—' }}</b></div>
              <div><span>使用面积</span><b>{{ selectedRoom.useArea.toFixed(1) }} ㎡</b></div>
              <div><span>建筑面积</span><b>{{ selectedRoom.buildArea.toFixed(1) }} ㎡</b></div>
              <div><span>业务状态</span><b>{{ USE_LABELS[selectedRoom.useStatus] }}</b></div>
              <div><span>审图状态</span><b>{{ INSPECT_LABELS[selectedRoom.inspectStatus] }}</b></div>
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
                <el-slider v-model="wallHeight" :min="1" :max="5" :step="0.5" :show-tooltip="true" class="fpv__lift" />
              </div>
              <div class="fpv-tools__row">
                <span class="fpv-tools__label">旋转</span>
                <el-slider v-model="viewRotation" :min="-180" :max="180" :step="5" :show-tooltip="true" class="fpv__lift" />
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
          <span class="fpv-tools__label">旋转</span>
          <el-slider v-model="viewRotation" :min="-180" :max="180" :step="5" :show-tooltip="true" class="fpv__lift" />
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
        <rect x="0" y="0" :width="VIEW_W" :height="VIEW_H" fill="#fbfcfe" pointer-events="none" />
        <g :transform="`rotate(${viewRotation} ${VIEW_W / 2} ${VIEW_H / 2})`">
        <!-- ① 地面(楼板) + ② 走廊：楼层外轮廓填充；房间在③层覆盖其上，自然得到「外轮廓减房间」的走廊区 -->
        <path v-if="outlinePath" :d="outlinePath" fill="#eef1f5" stroke="#c4cbd4" stroke-width="1.5" pointer-events="none" />
        <!-- ③ 房间平铺填充（z=0 地面，无侧面） -->
        <g
          v-for="rf in roomFills"
          :key="rf.id"
          class="fpv-room"
          :opacity="rf.dimmed ? 0.18 : 1"
          @mouseenter="onEnter(rf.room, $event)"
              @mouseleave="onLeave"
              @click="onSelect(rf.room, $event)"
            >
              <polygon
                :points="rf.points"
                :fill="rf.fill"
                :stroke="rf.stroke"
                :stroke-width="hoveredId === rf.id ? 2.5 : 1"
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
              <rect
                v-if="ln.rect"
                :x="ln.rect.x"
                :y="ln.rect.y"
                :width="ln.rect.w"
                :height="ln.rect.h"
                rx="6"
                fill="#ffffff"
                :stroke="rf.stroke"
                stroke-width="0.4"
              />
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
.fpv-pop__info { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
.fpv-pop__info div { display: flex; justify-content: space-between; gap: 10px; }
.fpv-pop__info span { color: #6b7280; }
.fpv-pop__info b { font-weight: 600; color: #111827; }
.fpv-pop__acts { display: flex; gap: 8px; margin-bottom: 4px; }
.fpv-pop__form { border-top: 1px dashed #eef0f3; padding-top: 8px; margin-top: 4px; }
.fpv-tools__row--embed { margin-left: 10px; min-width: 160px; }
</style>
