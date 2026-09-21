<script setup lang="ts">
/**
 * FloorPlan2D：楼层 2.5D 平面图查看器（SVG 渲染，Y 轴翻转）。
 *
 * 渲染规范（2026-09-21）：
 * - 数据坐标 X 东 / Y 北，SVG 的 Y 向下，故做 Y 翻转：
 *     scale = min(viewW/(maxX-minX), viewH/(maxY-minY)) * 0.95
 *     toScreen(p) = [ (p[0]-minX)*scale + padX, (maxY-p[1])*scale + padY ]
 * - 每个房间一个 <polygon>，@click / @mouseenter / @mouseleave；selected=false 的半透明。
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
import { computed, ref, watch } from 'vue';
import { useBuildingStore } from '../stores/building';
import { polygonArea } from '../utils/geometry';
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
  const scale = Math.min(VIEW_W / w, VIEW_H / h) * FIT_MARGIN;
  // 居中留白：padX/padY 取「视图中心减去缩放后图形半幅」
  const padX = (VIEW_W - w * scale) / 2;
  const padY = (VIEW_H - h * scale) / 2;
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

interface RoomShape {
  room: RoomLike;
  points: string;
  fill: string;
  stroke: string;
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

const roomShapes = computed<RoomShape[]>(() => {
  const LINE_GAP = 14;
  return displayedRooms.value.map((room) => {
    const proj = polyOf(room).map(toScreen);
    const points = proj.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const color = colorFor(room);
    const selected = room.selected !== false;
    const c = toScreen(room.centroid);
    const areaScreen = polygonArea(proj);
    const baseLines = buildLabelLines(room, areaScreen);
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
    return { room, points, fill: color, stroke: color, dimmed: !selected, labelX: c[0], lines };
  });
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

// ---- 缩放 / 平移（楼层切换保留）----
const zoom = ref(1);
const panX = ref(0);
const panY = ref(0);
const stageRef = ref<HTMLElement | null>(null);
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 6;

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
    <div v-if="!floors.length" class="fpv-empty">
      <div class="fpv-empty__icon">🗂️</div>
      <p>该楼尚未导入楼层平面图。</p>
      <el-button type="primary" @click="requestImport">导入 DXF 图纸</el-button>
    </div>

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
          <el-button-group>
            <el-button size="small" title="放大" @click="zoomBy(1.2)">＋</el-button>
            <el-button size="small" title="缩小" @click="zoomBy(1 / 1.2)">－</el-button>
            <el-button size="small" title="复位视图" @click="resetView">复位</el-button>
          </el-button-group>
        </div>
        <el-button link type="primary" class="fpv__import" @click="requestImport">+ 导入图纸</el-button>
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
              <polygon
                :points="shape.points"
                :fill="shape.fill"
                :stroke="shape.stroke"
                :stroke-width="hoveredId === shape.room.id ? 3 : 1.2"
                :filter="shape.dimmed ? undefined : 'url(#roomShadow)'"
              />
              <template v-for="(ln, i) in shape.lines" :key="i">
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
              <dl>
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
          <polygon
            :points="shape.points"
            :fill="shape.fill"
            :stroke="shape.stroke"
            :stroke-width="hoveredId === shape.room.id ? 3 : 1.2"
            :filter="shape.dimmed ? undefined : 'url(#roomShadow)'"
          />
          <template v-for="(ln, i) in shape.lines" :key="i">
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
.fpv-empty { text-align: center; padding: 40px 0; color: #6b7280; }
.fpv-empty__icon { font-size: 40px; margin-bottom: 8px; }
.fpv { display: flex; flex-direction: column; gap: 12px; }
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
