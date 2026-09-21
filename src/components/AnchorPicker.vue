<script setup lang="ts">
/**
 * AnchorPicker：local 图纸（坐标不在 UTM 量级，学校图纸常见）的局部坐标 → UTM 配准。
 *
 * 规范流程（local 不允许走指纹自动匹配，必须手动配准）：
 *  1) 在 DXF 预览图上点 2 个同名锚点（①、②）—— 图纸局部坐标；
 *  2) 在高德地图上点 2 个同名锚点（①、②）—— 对应楼栋 footprint 上的实际位置（UTM）；
 *  3) 由两组点对解算二维相似变换（scale / rotation / offset），写入 Floor.transform；
 *  4) 解算后把楼层轮廓 applyTransform 到 UTM，与 footprint 做重合度检查（面积偏差），
 *     偏差 > 20% 给红色警告；
 *  5) 用户可反复调整锚点，实时预览叠加效果，确认后才进入下一步。
 *
 * 无高德 key / 地图不可用时，降级为「手动输入 2 个 UTM 锚点坐标」的兜底输入。
 */
import { computed, ref, watch } from 'vue';
import AnchorMap from './AnchorMap.vue';
import {
  applyTransform,
  OVERLAP_DEVIATION_THRESHOLD,
  polygonAreaDiffRatio,
  solveSimilarityTransform,
} from '../utils/coordinate';
import { bounds, convexHull, transformPolygon, type Pt } from '../utils/geometry';
import type { FloorTransform, LengthUnit } from '../types/cad';

const props = withDefaults(
  defineProps<{
    modelValue?: FloorTransform;
    unit: LengthUnit;
    /** 楼层外轮廓（DXF 局部坐标），解算与叠加预览用；缺省时回退到房间外包络 */
    floorOutlineLocal?: [number, number][] | null;
    /** 房间轮廓（DXF 局部坐标），仅用于预览绘制 */
    roomsLocal?: [number, number][][];
    /** 楼栋已有 footprint（UTM 米），重合度检查与地图绘制用 */
    footprintUtm?: [number, number][] | null;
  }>(),
  {
    modelValue: undefined,
    floorOutlineLocal: null,
    roomsLocal: () => [],
    footprintUtm: null,
  },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: FloorTransform): void;
}>();

// ---- 局部坐标侧锚点（DXF SVG 点选） ----
const localAnchors = ref<Pt[]>([]);
// ---- UTM 侧锚点（地图点选 / 手动输入） ----
const utmAnchors = ref<Pt[]>([]);
// 手动输入 UTM 锚点（地图不可用时兜底）
const manualUtm = ref<{ e: number; n: number }[]>([
  { e: 0, n: 0 },
  { e: 0, n: 0 },
]);

// ---- 视图：DXF 局部预览 SVG ----
const svgRef = ref<SVGSVGElement | null>(null);
const allLocalPts = computed<Pt[]>(() => {
  const pts: Pt[] = [];
  if (props.floorOutlineLocal) pts.push(...props.floorOutlineLocal);
  for (const r of props.roomsLocal) pts.push(...r);
  return pts;
});
const viewBox = computed<string>(() => {
  const b = bounds(allLocalPts.value.length ? allLocalPts.value : [[0, 0]]);
  const w = Math.max(b.maxX - b.minX, 1);
  const h = Math.max(b.maxY - b.minY, 1);
  const pad = Math.max(w, h) * 0.08;
  // 翻转 Y，使 CAD 的 +y（上）在屏幕上朝上
  return `${b.minX - pad} ${-(b.maxY + pad)} ${w + 2 * pad} ${h + 2 * pad}`;
});
function flipY(p: Pt): Pt {
  return [p[0], -p[1]];
}
const drawRooms = computed(() => props.roomsLocal.map((r) => r.map(flipY)));

function toLocal(evt: MouseEvent): Pt | null {
  const svg = svgRef.value;
  if (!svg) return null;
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const p = pt.matrixTransform(ctm.inverse());
  // 视图翻转了 Y，还原回原始局部坐标
  return [p.x, -p.y];
}
function onSvgClick(evt: MouseEvent): void {
  if (localAnchors.value.length >= 2) return;
  const p = toLocal(evt);
  if (p) localAnchors.value = [...localAnchors.value, p];
}

// ---- 解算 ----
const canSolve = computed(() => localAnchors.value.length === 2 && utmAnchors.value.length === 2);
const solved = ref<FloorTransform | null>(null);
const localPolygon = computed<Pt[] | null>(() => {
  if (props.floorOutlineLocal && props.floorOutlineLocal.length >= 3) return props.floorOutlineLocal;
  if (props.roomsLocal.length) {
    const pts = props.roomsLocal.flat();
    return pts.length >= 3 ? convexHull(pts) : null;
  }
  return null;
});
const deviation = computed<number | null>(() => {
  if (!canSolve.value || !localPolygon.value) return null;
  const tr = solved.value;
  if (!tr) return null;
  const transformed = transformPolygon(localPolygon.value, tr);
  if (!props.footprintUtm || props.footprintUtm.length < 3) return null;
  return polygonAreaDiffRatio(transformed, props.footprintUtm);
});
const deviationWarn = computed(() => deviation.value !== null && deviation.value > OVERLAP_DEVIATION_THRESHOLD);
const previewUtm = computed<Pt[] | null>(() => {
  if (!canSolve.value || !localPolygon.value || !solved.value) return null;
  return transformPolygon(localPolygon.value, solved.value);
});

// utmAnchors 为主数据源（地图点选或手动输入写入）；手动输入框仅作为镜像展示 / 兜底编辑
watch(
  utmAnchors,
  (val) => {
    manualUtm.value = val.map((a) => ({ e: a[0], n: a[1] }));
  },
  { deep: true },
);

watch(
  [localAnchors, utmAnchors],
  () => {
    if (canSolve.value) {
      const tr = solveSimilarityTransform(
        localAnchors.value as [Pt, Pt],
        utmAnchors.value as [Pt, Pt],
      );
      solved.value = tr;
      emit('update:modelValue', tr);
    } else {
      solved.value = null;
    }
  },
  { deep: true },
);

function onMapAdd(utm: Pt): void {
  if (utmAnchors.value.length >= 2) return;
  utmAnchors.value = [...utmAnchors.value, utm];
}
function resetAnchors(): void {
  localAnchors.value = [];
  utmAnchors.value = [];
  manualUtm.value = [
    { e: 0, n: 0 },
    { e: 0, n: 0 },
  ];
  solved.value = null;
}
function onManualChange(): void {
  utmAnchors.value = manualUtm.value.map((m) => [m.e, m.n] as Pt);
}

// 初始：若父级已带入 modelValue（如从历史 transform 恢复），展示提示
const hasInitial = computed(() => !!props.modelValue);
</script>

<template>
  <div class="anchor">
    <div class="anchor__title">局部坐标 → UTM 配准（点选 2 对同名锚点）</div>

    <div class="anchor__grid2">
      <!-- 左：DXF 局部预览，点选锚点 -->
      <div class="anchor__side">
        <div class="anchor__side-h">
          <span>① 图纸预览（点 2 点）</span>
          <span class="anchor__cnt">{{ localAnchors.length }}/2</span>
        </div>
        <svg
          ref="svgRef"
          class="anchor__svg"
          :viewBox="viewBox"
          :class="{ 'is-armed': localAnchors.length < 2 }"
          @click="onSvgClick"
        >
          <polygon
            v-for="(room, i) in drawRooms"
            :key="'r' + i"
            class="anchor__room"
            :points="room.map((p) => p.join(',')).join(' ')"
          />
          <polygon
            v-if="floorOutlineLocal"
            class="anchor__outline"
            :points="floorOutlineLocal.map((p) => flipY(p).join(',')).join(' ')"
          />
          <g v-for="(a, i) in localAnchors" :key="'la' + i">
            <circle :cx="flipY(a)[0]" :cy="flipY(a)[1]" r="6" class="anchor__pin" />
            <text :x="flipY(a)[0]" :y="flipY(a)[1] - 10" class="anchor__pin-t">
              {{ String.fromCharCode(9312 + i) }}
            </text>
          </g>
        </svg>
      </div>

      <!-- 右：高德地图，点选锚点 -->
      <div class="anchor__side">
        <div class="anchor__side-h">
          <span>② 楼栋 footprint（点 2 点）</span>
          <span class="anchor__cnt">{{ utmAnchors.length }}/2</span>
        </div>
        <AnchorMap
          :footprint-utm="footprintUtm"
          :anchors-utm="utmAnchors"
          :preview-utm="previewUtm"
          :disabled="localAnchors.length < 2"
          @add="onMapAdd"
        />
      </div>
    </div>

    <!-- 兜底：地图不可用时手动输入 2 个 UTM 锚点 -->
    <div class="anchor__manual">
      <span class="anchor__manual-t">手动锚点坐标（UTM 49N 米，与左侧顺序对应）</span>
      <div v-for="(m, i) in manualUtm" :key="i" class="anchor__manual-row">
        <span class="anchor__badge">{{ String.fromCharCode(9312 + i) }}</span>
        <label>E<input v-model.number="m.e" type="number" step="0.1" @input="onManualChange" /></label>
        <label>N<input v-model.number="m.n" type="number" step="0.1" @input="onManualChange" /></label>
      </div>
    </div>

    <div class="anchor__actions">
      <el-button size="small" @click="resetAnchors">重置锚点</el-button>
      <span v-if="hasInitial && !solved" class="anchor__hint">已载入上次配准结果，可重选锚点覆盖。</span>
    </div>

    <!-- 解算结果 + 重合度检查 -->
    <template v-if="canSolve && solved">
      <el-alert
        class="anchor__result"
        type="success"
        :closable="false"
        :title="`已解算变换：scale=${solved.scale.toFixed(4)}，rotation=${(solved.rotation * 180 / Math.PI).toFixed(2)}°，偏移=[${solved.offset[0].toFixed(1)}, ${solved.offset[1].toFixed(1)}]`"
      />
      <el-alert
        v-if="deviation !== null"
        class="anchor__result"
        :type="deviationWarn ? 'error' : 'success'"
        :closable="false"
        :title="deviationWarn ? `重合度偏差 ${(deviation * 100).toFixed(1)}% > 20%，变换后外轮廓与楼栋 footprint 偏差过大，请重新选点` : `重合度偏差 ${(deviation * 100).toFixed(1)}%（≤20%，配准良好）`"
      />
      <el-alert
        v-else
        class="anchor__result"
        type="info"
        :closable="false"
        title="该楼暂无 footprint，无法做重合度校验；请尽量精确拾取锚点。"
      />
    </template>

    <p v-else class="anchor__hint">
      在图纸与地图上各点 2 个同名锚点（如左下角↔左下角、右上角↔右上角），系统自动解算变换并实时预览。
    </p>
  </div>
</template>

<style scoped>
.anchor { border: 1px solid #dcdfe6; border-radius: 8px; padding: 12px 14px; background: #f7f9fc; }
.anchor__title { font-size: 13px; font-weight: 600; color: #1f2a3a; margin-bottom: 10px; }
.anchor__grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.anchor__side { display: flex; flex-direction: column; gap: 6px; }
.anchor__side-h { display: flex; justify-content: space-between; font-size: 12px; color: #5a6678; }
.anchor__cnt { color: #2f6df6; font-weight: 600; }
.anchor__svg {
  width: 100%; height: 240px; background: #fff; border: 1px solid #e4e7ed; border-radius: 6px;
  cursor: crosshair;
}
.anchor__svg.is-armed { outline: 2px dashed #2f6df6; }
.anchor__room { fill: #eef1f6; stroke: #c0c4cc; stroke-width: 1; }
.anchor__outline { fill: none; stroke: #2f6df6; stroke-width: 2; }
.anchor__pin { fill: #16a34a; stroke: #fff; stroke-width: 1.5; }
.anchor__pin-t { fill: #16a34a; font: 600 12px sans-serif; text-anchor: middle; }
.anchor__manual { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.anchor__manual-t { font-size: 12px; color: #5a6678; }
.anchor__manual-row { display: flex; align-items: center; gap: 10px; font-size: 12px; color: #4b5563; }
.anchor__manual-row input { width: 110px; margin-left: 4px; }
.anchor__badge {
  display: inline-flex; width: 18px; height: 18px; border-radius: 50%;
  background: #16a34a; color: #fff; align-items: center; justify-content: center; font-size: 11px;
}
.anchor__actions { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.anchor__hint { font-size: 11px; color: #9ca3af; margin: 8px 0 0; line-height: 1.6; }
.anchor__result { margin-top: 8px; }
</style>
