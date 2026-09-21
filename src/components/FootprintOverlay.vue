<script setup lang="ts">
/**
 * FootprintOverlay：UTM 坐标系下「解析楼层外轮廓 ↔ 楼栋 footprint」叠加预览。
 * 纯 SVG（不依赖地图），用于坐标配准步骤「自动算指纹」后目视确认对齐情况。
 * 坐标均为 UTM 49N（米）；整体翻转 Y 使「北」朝上，与高德/平面图习惯一致。
 */
import { computed } from 'vue';
import type { Pt } from '../utils/geometry';

const props = withDefaults(
  defineProps<{
    /** 目标楼栋 footprint（UTM 米），蓝色 */
    footprint?: Pt[] | null;
    /** 解析得到的楼层外轮廓（UTM 米），橙色虚线 */
    outline?: Pt[] | null;
    /** 房间轮廓（UTM 米），灰色淡显 */
    rooms?: Pt[][];
  }>(),
  { footprint: null, outline: null, rooms: () => [] },
);

function flipY(p: Pt): Pt {
  return [p[0], -p[1]];
}
function toStr(poly: Pt[] | null | undefined): string {
  if (!poly || poly.length < 2) return '';
  return poly.map((p) => flipY(p).join(',')).join(' ');
}

const allPts = computed<Pt[]>(() => {
  const pts: Pt[] = [];
  if (props.footprint) pts.push(...props.footprint);
  if (props.outline) pts.push(...props.outline);
  for (const r of props.rooms) pts.push(...r);
  return pts;
});

const viewBox = computed<string>(() => {
  const pts = allPts.value;
  if (!pts.length) return '0 0 100 100';
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);
  const pad = Math.max(w, h) * 0.08;
  // 翻转 Y：CAD/UTM 的 +y（北）在屏幕上朝上
  return `${minX - pad} ${-(maxY + pad)} ${w + 2 * pad} ${h + 2 * pad}`;
});

const hasData = computed(() => allPts.value.length >= 2);
</script>

<template>
  <div class="fp">
    <svg v-if="hasData" class="fp__svg" :viewBox="viewBox">
      <polygon
        v-for="(r, i) in rooms"
        :key="'r' + i"
        class="fp__room"
        :points="toStr(r)"
      />
      <polygon v-if="footprint && footprint.length >= 3" class="fp__foot" :points="toStr(footprint)" />
      <polygon v-if="outline && outline.length >= 3" class="fp__outline" :points="toStr(outline)" />
    </svg>
    <div v-else class="fp__empty">暂无可叠加的轮廓</div>
    <div class="fp__legend">
      <span class="fp__lg fp__lg--foot">楼栋 footprint</span>
      <span class="fp__lg fp__lg--outline">楼层外轮廓（解析）</span>
      <span class="fp__lg fp__lg--room">房间</span>
    </div>
  </div>
</template>

<style scoped>
.fp { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; background: #fbfcfe; }
.fp__svg { width: 100%; height: 300px; display: block; background: #fbfcfe; }
.fp__room { fill: #eef1f6; stroke: #c8ccd4; stroke-width: 0.5; }
.fp__foot { fill: rgba(47, 109, 246, 0.1); stroke: #2f6df6; stroke-width: 1.5; }
.fp__outline { fill: none; stroke: #ff8c1a; stroke-width: 1.5; stroke-dasharray: 5 4; }
.fp__empty { padding: 40px; text-align: center; color: #9ca3af; font-size: 13px; }
.fp__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  padding: 8px 12px;
  font-size: 12px;
  color: #4b5563;
  border-top: 1px solid #eef0f3;
  background: #fff;
}
.fp__lg { display: inline-flex; align-items: center; gap: 6px; }
.fp__lg::before { content: ''; width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
.fp__lg--foot::before { background: rgba(47, 109, 246, 0.2); border: 1.5px solid #2f6df6; }
.fp__lg--outline::before { background: transparent; border: 1.5px dashed #ff8c1a; }
.fp__lg--room::before { background: #eef1f6; border: 0.5px solid #c8ccd4; }
</style>
