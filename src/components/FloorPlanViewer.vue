<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useFloorPlanStore } from '../stores/floorPlanStore';
import { fitTransform, projectPoint } from '../floorplan/geometry';
import { ROOM_STATUS_CONFIG, type RoomStatus } from '../data/roomData';
import type { FloorPlan, ParsedRoom, RoomVertex } from '../floorplan/types';

const props = defineProps<{
  modelValue: boolean;
  buildingName: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'request-import'): void;
}>();

const store = useFloorPlanStore();

const VIEW_W = 920;
const VIEW_H = 640;
const WALL_H = 18;

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const floors = computed(() => store.floorsOf(props.buildingName));
const selectedFloor = ref<number>(1);

watch(
  [() => props.modelValue, () => props.buildingName, floors],
  () => {
    if (props.modelValue && floors.value.length && !floors.value.includes(selectedFloor.value)) {
      selectedFloor.value = floors.value[0];
    }
  },
  { immediate: true },
);

const currentPlan = computed<FloorPlan | undefined>(() =>
  store.getPlan(props.buildingName, selectedFloor.value),
);

/** 颜色映射（淡色填充 + 深色描边/侧壁 + 深字），保证在浅色 viewer 上可读 */
const COLOR_SET: Record<RoomStatus, { fill: string; stroke: string; wall: string; text: string }> = {
  occupied: { fill: 'rgba(59,130,246,0.16)', stroke: '#2563eb', wall: '#1e3a8a', text: '#1e3a8a' },
  noaccess: { fill: 'rgba(245,158,11,0.16)', stroke: '#d97706', wall: '#92400e', text: '#92400e' },
  vacant: { fill: 'rgba(34,197,94,0.16)', stroke: '#16a34a', wall: '#166534', text: '#166534' },
};

interface RoomShape {
  room: ParsedRoom;
  topPoints: string;
  wallPoints: string;
  labelX: number;
  labelY: number;
  colors: (typeof COLOR_SET)[RoomStatus];
}

const fit = computed(() => {
  if (!currentPlan.value) return null;
  return fitTransform(currentPlan.value.bounds, VIEW_W, VIEW_H);
});

const roomShapes = computed<RoomShape[]>(() => {
  if (!currentPlan.value || !fit.value) return [];
  const t = fit.value;
  const b = currentPlan.value.bounds;
  return currentPlan.value.rooms.map((room) => {
    const top = room.polygon.map((p: RoomVertex) => projectPoint(p, b, t));
    const topStr = top.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const wallStr = top.map((p) => `${p.x.toFixed(1)},${(p.y + WALL_H).toFixed(1)}`).join(' ');
    const c = projectPoint(room.centroid, b, t);
    return {
      room,
      topPoints: topStr,
      wallPoints: wallStr,
      labelX: c.x,
      labelY: c.y,
      colors: COLOR_SET[room.status],
    };
  });
});

const hoveredId = ref<string | null>(null);
const selectedId = ref<string | null>(null);
const tooltip = ref<{ x: number; y: number; room: ParsedRoom } | null>(null);

const hoveredRoom = computed(() => roomShapes.value.find((s) => s.room.id === hoveredId.value)?.room ?? null);
const selectedRoom = computed(() => currentPlan.value?.rooms.find((r) => r.id === selectedId.value) ?? null);

function onEnter(room: ParsedRoom, ev: MouseEvent) {
  hoveredId.value = room.id;
  moveTooltip(room, ev);
}
function onMove(room: ParsedRoom, ev: MouseEvent) {
  moveTooltip(room, ev);
}
function onLeave() {
  hoveredId.value = null;
  tooltip.value = null;
}
function moveTooltip(room: ParsedRoom, ev: MouseEvent) {
  const host = (ev.currentTarget as HTMLElement).closest('.fpv-stage') as HTMLElement | null;
  if (!host) return;
  const rect = host.getBoundingClientRect();
  tooltip.value = { x: ev.clientX - rect.left, y: ev.clientY - rect.top, room };
}
function onSelect(room: ParsedRoom) {
  selectedId.value = selectedId.value === room.id ? null : room.id;
}

const legend = computed(() =>
  (Object.keys(ROOM_STATUS_CONFIG) as RoomStatus[]).map((s) => ({
    status: s,
    label: ROOM_STATUS_CONFIG[s].label,
    color: ROOM_STATUS_CONFIG[s].color,
  })),
);

function formatArea(a: number): string {
  // DXF 单位平方，直接展示数值（保留 1 位小数）
  return a.toFixed(1);
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="`${buildingName} · 楼宇分层图（2.5D）`"
    width="78%"
    top="5vh"
    class="fpv-dialog"
  >
    <div v-if="!floors.length" class="fpv-empty">
      <div class="fpv-empty__icon">🗂️</div>
      <p>该楼尚未导入楼层平面图。</p>
      <el-button type="primary" @click="emit('request-import')">导入 DXF 图纸</el-button>
    </div>

    <div v-else class="fpv">
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
        <el-button link type="primary" class="fpv__import" @click="emit('request-import')">
          + 导入图纸
        </el-button>
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
              :points="shape.wallPoints"
              :fill="shape.colors.wall"
              :opacity="hoveredId === shape.room.id || selectedId === shape.room.id ? 1 : 0.55"
            />
            <polygon
              :points="shape.topPoints"
              :fill="shape.colors.fill"
              :stroke="shape.colors.stroke"
              :stroke-width="selectedId === shape.room.id ? 3 : 1.5"
            />
            <text
              :x="shape.labelX"
              :y="shape.labelY"
              text-anchor="middle"
              dominant-baseline="middle"
              :fill="shape.colors.text"
              font-size="13"
              font-weight="600"
              pointer-events="none"
            >
              {{ shape.room.label }}
            </text>
          </g>
        </svg>

        <div
          v-if="tooltip"
          class="fpv-tooltip"
          :style="{ left: tooltip.x + 12 + 'px', top: tooltip.y + 12 + 'px' }"
        >
          <div class="fpv-tooltip__no">{{ tooltip.room.label }}</div>
          <div class="fpv-tooltip__row">楼层：{{ tooltip.room.floor }}F</div>
          <div class="fpv-tooltip__row">面积：{{ formatArea(tooltip.room.area) }} ㎡*</div>
          <div class="fpv-tooltip__row">状态：{{ ROOM_STATUS_CONFIG[tooltip.room.status].label }}</div>
        </div>
      </div>

      <div class="fpv-side">
        <div class="fpv-legend">
          <span v-for="l in legend" :key="l.status" class="fpv-legend__item">
            <i :style="{ background: l.color }"></i>{{ l.label }}
          </span>
        </div>
        <div class="fpv-info">
          <template v-if="selectedRoom">
            <div class="fpv-info__title">{{ selectedRoom.label }}</div>
            <dl>
              <div><dt>楼层</dt><dd>{{ selectedRoom.floor }}F</dd></div>
              <div><dt>面积</dt><dd>{{ formatArea(selectedRoom.area) }} ㎡*</dd></div>
              <div><dt>状态</dt><dd>{{ ROOM_STATUS_CONFIG[selectedRoom.status].label }}</dd></div>
              <div v-if="!selectedRoom.labelled"><dt>编号</dt><dd>自动生成</dd></div>
            </dl>
          </template>
          <p v-else class="fpv-info__hint">点击房间查看详情</p>
        </div>
        <p class="fpv-note">* 面积为 DXF 原始坐标计算，单位取决于图纸（米/毫米）。</p>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.fpv-dialog :deep(.el-dialog__body) { padding-top: 8px; }
.fpv-empty { text-align: center; padding: 40px 0; color: #6b7280; }
.fpv-empty__icon { font-size: 40px; margin-bottom: 8px; }
.fpv { display: flex; flex-direction: column; gap: 12px; }
.fpv__floors { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
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
  min-width: 120px;
}
.fpv-tooltip__no { font-weight: 700; margin-bottom: 2px; }
.fpv-side { display: flex; flex-direction: column; gap: 10px; }
.fpv-legend { display: flex; gap: 14px; font-size: 13px; color: #4b5563; }
.fpv-legend__item { display: inline-flex; align-items: center; gap: 5px; }
.fpv-legend i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.fpv-info { border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px 14px; background: #fff; }
.fpv-info__title { font-size: 15px; font-weight: 700; color: #111827; margin-bottom: 6px; }
.fpv-info dl { margin: 0; }
.fpv-info dl div { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; border-bottom: 1px dashed #eef0f3; }
.fpv-info dl div:last-child { border-bottom: 0; }
.fpv-info dt { color: #6b7280; }
.fpv-info dd { margin: 0; color: #111827; }
.fpv-info__hint { color: #9ca3af; font-size: 13px; margin: 0; }
.fpv-note { font-size: 11px; color: #9ca3af; margin: 0; }
</style>
