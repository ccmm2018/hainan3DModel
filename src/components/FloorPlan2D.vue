<script setup lang="ts">
/**
 * FloorPlan2D：楼层 2.5D 平面图查看器。
 * - 楼层 Tab 切换；
 * - 房间以「挤出侧壁 + 顶面」呈现 2.5D 效果；
 * - 着色模式可切换：审图状态 / 业务占用状态 / 按部门 / 按用途；
 * - 悬停 tooltip、点击选中、可隐藏误识别房间（写回 store）。
 */
import { computed, ref, watch } from 'vue';
import { useFloorRoomStore } from '../stores/floorRoom';
import { fitTransform, projectPoint, type Pt } from '../utils/geometry';
import type { InspectStatus, Room, UseStatus } from '../types/cad';

const props = defineProps<{
  modelValue: boolean;
  buildingName: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'request-import'): void;
}>();

const store = useFloorRoomStore();

const VIEW_W = 920;
const VIEW_H = 640;
const WALL_H = 18;

type ColorMode = 'inspect' | 'use' | 'dept' | 'purpose';

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const floors = computed(() => store.floorsOf(props.buildingName));
const selectedFloor = ref<number>(1);
const colorMode = ref<ColorMode>('use');

watch(
  [() => props.modelValue, () => props.buildingName, floors],
  () => {
    if (props.modelValue && floors.value.length && !floors.value.includes(selectedFloor.value)) {
      selectedFloor.value = floors.value[0];
    }
  },
  { immediate: true },
);

const currentFloor = computed(() =>
  floors.value.length ? store.getFloor(props.buildingName, selectedFloor.value) : undefined,
);

const displayedRooms = computed<Room[]>(() => {
  const f = currentFloor.value;
  if (!f) return [];
  return store.roomsOfFloor(f.id).filter((r) => r.selected !== false);
});

// ---- 着色 ----
const INSPECT_COLORS: Record<InspectStatus, string> = {
  normal: '#9ca3af',
  highlight: '#2563eb',
  warning: '#dc2626',
  partial: '#d97706',
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
  partial: '部分',
};

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

function colorFor(room: Room): string {
  switch (colorMode.value) {
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

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.replace('#', '');
  const r = parseInt(m.substring(0, 2), 16);
  const g = parseInt(m.substring(2, 4), 16);
  const b = parseInt(m.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const bounds = computed(() => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of displayedRooms.value) {
    for (const [x, y] of r.outline) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
});

const fit = computed(() => fitTransform(bounds.value, VIEW_W, VIEW_H));

interface RoomShape {
  room: Room;
  top: string;
  wall: string;
  labelX: number;
  labelY: number;
  fill: string;
  stroke: string;
  wallColor: string;
}

const roomShapes = computed<RoomShape[]>(() => {
  const t = fit.value;
  const b = bounds.value;
  return displayedRooms.value.map((room) => {
    const topPts: Pt[] = room.outline.map((p) => projectPoint(p, b, t));
    const top = topPts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const wall = topPts.map((p) => `${p[0].toFixed(1)},${(p[1] + WALL_H).toFixed(1)}`).join(' ');
    const c = projectPoint(room.centroid, b, t);
    const color = colorFor(room);
    return {
      room,
      top,
      wall,
      labelX: c[0],
      labelY: c[1],
      fill: hexToRgba(color, 0.5),
      stroke: color,
      wallColor: hexToRgba(color, 0.9),
    };
  });
});

const legend = computed(() => {
  if (colorMode.value === 'inspect') {
    return (Object.keys(INSPECT_COLORS) as InspectStatus[]).map((k) => ({ label: INSPECT_LABELS[k], color: INSPECT_COLORS[k] }));
  }
  if (colorMode.value === 'use') {
    return (Object.keys(USE_COLORS) as Exclude<UseStatus, ''>[])
      .map((k) => ({ label: USE_LABELS[k], color: USE_COLORS[k] }))
      .concat([{ label: USE_LABELS[''], color: '#cbd5e1' }]);
  }
  // dept / purpose：取实际出现的类别
  const map = new Map<string, string>();
  for (const r of displayedRooms.value) {
    const key = colorMode.value === 'dept' ? r.dept : r.usePurpose;
    if (key) map.set(key, colorFor(r));
  }
  if (!map.size) map.set('（无）', '#cbd5e1');
  return [...map.entries()].map(([label, color]) => ({ label, color }));
});

const hoveredId = ref<string | null>(null);
const selectedId = ref<string | null>(null);
const tooltip = ref<{ x: number; y: number; room: Room } | null>(null);

const hoveredRoom = computed(() => displayedRooms.value.find((r) => r.id === hoveredId.value) ?? null);
const selectedRoom = computed(() => displayedRooms.value.find((r) => r.id === selectedId.value) ?? null);

function onEnter(room: Room, ev: MouseEvent) {
  hoveredId.value = room.id;
  moveTooltip(room, ev);
}
function onMove(room: Room, ev: MouseEvent) {
  moveTooltip(room, ev);
}
function onLeave() {
  hoveredId.value = null;
  tooltip.value = null;
}
function moveTooltip(room: Room, ev: MouseEvent) {
  const host = (ev.currentTarget as HTMLElement).closest('.fpv-stage') as HTMLElement | null;
  if (!host) return;
  const rect = host.getBoundingClientRect();
  tooltip.value = { x: ev.clientX - rect.left, y: ev.clientY - rect.top, room };
}
function onSelect(room: Room) {
  selectedId.value = selectedId.value === room.id ? null : room.id;
}

function setUseStatus(status: UseStatus) {
  const f = currentFloor.value;
  if (!f || !selectedRoom.value) return;
  store.setRoomUseStatus(f.id, selectedRoom.value.id, status);
}
function hideRoom() {
  const f = currentFloor.value;
  if (!f || !selectedRoom.value) return;
  store.setRoomSelected(f.id, selectedRoom.value.id, false);
  selectedId.value = null;
}
function showAll() {
  const f = currentFloor.value;
  if (!f) return;
  for (const r of store.roomsOfFloor(f.id)) store.setRoomSelected(f.id, r.id, true);
}

function requestImport() {
  emit('request-import');
}
</script>

<template>
  <el-dialog
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
        <el-button link type="primary" class="fpv__import" @click="requestImport">+ 导入图纸</el-button>
      </div>

      <div class="fpv-stage">
        <svg :viewBox="`0 0 ${VIEW_W} ${VIEW_H}`" class="fpv-svg" preserveAspectRatio="xMidYMid meet">
          <rect x="0" y="0" :width="VIEW_W" :height="VIEW_H" fill="#fbfcfe" />
          <g
            v-for="shape in roomShapes"
            :key="shape.room.id"
            class="fpv-room"
            @mouseenter="onEnter(shape.room, $event)"
            @mousemove="onMove(shape.room, $event)"
            @mouseleave="onLeave"
            @click="onSelect(shape.room)"
          >
            <polygon
              :points="shape.wall"
              :fill="shape.wallColor"
              :opacity="hoveredId === shape.room.id || selectedId === shape.room.id ? 1 : 0.55"
            />
            <polygon
              :points="shape.top"
              :fill="shape.fill"
              :stroke="shape.stroke"
              :stroke-width="selectedId === shape.room.id ? 3 : 1.5"
            />
            <text
              :x="shape.labelX"
              :y="shape.labelY"
              text-anchor="middle"
              dominant-baseline="middle"
              :fill="shape.stroke"
              font-size="13"
              font-weight="600"
              pointer-events="none"
            >
              {{ shape.room.code || shape.room.name }}
            </text>
          </g>
        </svg>

        <div
          v-if="tooltip"
          class="fpv-tooltip"
          :style="{ left: tooltip.x + 12 + 'px', top: tooltip.y + 12 + 'px' }"
        >
          <div class="fpv-tooltip__no">{{ tooltip.room.code || tooltip.room.name }}</div>
          <div class="fpv-tooltip__row">名称：{{ tooltip.room.name }}</div>
          <div v-if="tooltip.room.dept" class="fpv-tooltip__row">部门：{{ tooltip.room.dept }}</div>
          <div v-if="tooltip.room.usePurpose" class="fpv-tooltip__row">用途：{{ tooltip.room.usePurpose }}</div>
          <div class="fpv-tooltip__row">面积：{{ tooltip.room.buildArea.toFixed(1) }} ㎡</div>
          <div class="fpv-tooltip__row">业务：{{ USE_LABELS[tooltip.room.useStatus] }}</div>
          <div class="fpv-tooltip__row">审图：{{ INSPECT_LABELS[tooltip.room.inspectStatus] }}</div>
        </div>
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
              <div><dt>楼层</dt><dd>{{ currentFloor?.floorNo }}F</dd></div>
              <div><dt>部门</dt><dd>{{ selectedRoom.dept || '—' }}</dd></div>
              <div><dt>用途</dt><dd>{{ selectedRoom.usePurpose || '—' }}</dd></div>
              <div><dt>建筑面积</dt><dd>{{ selectedRoom.buildArea.toFixed(1) }} ㎡</dd></div>
              <div><dt>业务状态</dt><dd>{{ USE_LABELS[selectedRoom.useStatus] }}</dd></div>
              <div><dt>审图状态</dt><dd>{{ INSPECT_LABELS[selectedRoom.inspectStatus] }}</dd></div>
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
  </el-dialog>
</template>

<style scoped>
.fpv-dialog :deep(.el-dialog__body) { padding-top: 8px; }
.fpv-empty { text-align: center; padding: 40px 0; color: #6b7280; }
.fpv-empty__icon { font-size: 40px; margin-bottom: 8px; }
.fpv { display: flex; flex-direction: column; gap: 12px; }
.fpv__top { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
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
.fpv__import { margin-left: auto; }
.fpv-stage { position: relative; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; background: #fbfcfe; }
.fpv-svg { display: block; width: 100%; height: 60vh; }
.fpv-room { cursor: pointer; }
.fpv-tooltip {
  position: absolute;
  pointer-events: none;
  background: rgba(17, 24, 39, 0.92);
  color: #fff;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.6;
  z-index: 5;
  min-width: 140px;
}
.fpv-tooltip__no { font-weight: 700; margin-bottom: 2px; }
.fpv-side { display: flex; flex-direction: column; gap: 10px; }
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
</style>
