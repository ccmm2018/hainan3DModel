<script setup lang="ts">
/**
 * AnchorMap：局部坐标配准用的高德地图小窗。
 * - 显示该楼已有 footprint（UTM → GCJ-02 后绘制为蓝色轮廓）
 * - 显示变换后的楼层外轮廓预览（橙色虚线，由 AnchorPicker 实时传入）
 * - 用户在地图上点选 2 个同名锚点（① / ②），回调以 UTM 坐标 emit 出去
 * - 无高德 key / 加载失败时优雅降级为「地图不可用」提示，由父组件提供手动坐标输入
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { loadAMap } from '../utils/loadAMap';
import { utm49nToGcj02, gcj02ToUtm49n } from '../utils/coordTransform';
import { DEFAULT_SCENE_CONFIG } from '../config/mapConfig';
import { wgs84ToGcj02 } from '../utils/coordinate';
import type { Pt } from '../utils/geometry';

const props = withDefaults(
  defineProps<{
    /** 楼栋已有 footprint（UTM 米），可选 */
    footprintUtm?: Pt[] | null;
    /** 用户已拾取的锚点（UTM 米） */
    anchorsUtm?: Pt[];
    /** 解算后变换的楼层外轮廓预览（UTM 米） */
    previewUtm?: Pt[] | null;
    /** 是否禁用地图点选（如 DXF 侧锚点不足 2 个时） */
    disabled?: boolean;
  }>(),
  { footprintUtm: null, anchorsUtm: () => [], previewUtm: null, disabled: false },
);

const emit = defineEmits<{
  (e: 'add', utm: Pt): void;
  (e: 'unavailable'): void;
}>();

// ---- 最小类型声明，避免 any（AMap 无官方 TS 类型） ----
interface AmapMarker {
  setMap(m: AmapMap | null): void;
}
interface AmapPolygon {
  setMap(m: AmapMap | null): void;
}
interface AmapMap {
  on(ev: string, cb: (e: unknown) => void): void;
  add(o: unknown): void;
  setFitView(o?: unknown): void;
  destroy?(): void;
}
interface AmapNs {
  Map: new (el: HTMLElement, opts: Record<string, unknown>) => AmapMap;
  Marker: new (opts: {
    position: [number, number];
    map?: AmapMap;
    content?: string;
    anchor?: string;
    zIndex?: number;
  }) => AmapMarker;
  Polygon: new (opts: {
    path: [number, number][];
    map?: AmapMap;
    strokeColor?: string;
    fillColor?: string;
    fillOpacity?: number;
    strokeWeight?: number;
    strokeStyle?: string;
    zIndex?: number;
  }) => AmapPolygon;
}

const mapEl = ref<HTMLDivElement | null>(null);
const available = ref<boolean>(false);
const loading = ref<boolean>(true);
const tip = ref<string>('正在加载高德地图…');

let ns: AmapNs | null = null;
let map: AmapMap | null = null;
let overlays: unknown[] = [];

function utmToGcjPath(pts: Pt[] | null): [number, number][] {
  if (!pts) return [];
  return pts.map((p) => utm49nToGcj02(p[0], p[1]));
}

function centerGcj(): [number, number] {
  if (props.footprintUtm && props.footprintUtm.length >= 3) {
    const path = utmToGcjPath(props.footprintUtm);
    const sx = path.reduce((s, p) => s + p[0], 0);
    const sy = path.reduce((s, p) => s + p[1], 0);
    return [sx / path.length, sy / path.length];
  }
  // 回退：项目默认中心（WGS84 → GCJ）
  return wgs84ToGcj02(DEFAULT_SCENE_CONFIG.center[0], DEFAULT_SCENE_CONFIG.center[1]);
}

function pinHtml(label: string, color: string): string {
  return (
    `<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;` +
    `transform:rotate(-45deg);background:${color};border:2px solid #fff;` +
    `box-shadow:0 1px 3px rgba(0,0,0,.4);display:flex;align-items:center;` +
    `justify-content:center;color:#fff;font:600 12px/1 sans-serif">` +
    `<span style="transform:rotate(45deg)">${label}</span></div>`
  );
}

function clearOverlays(): void {
  for (const o of overlays) {
    if (o && typeof (o as AmapPolygon).setMap === 'function') (o as AmapPolygon).setMap(null);
  }
  overlays = [];
}

function redraw(): void {
  if (!ns || !map) return;
  const api = ns;
  const m = map;
  clearOverlays();

  // 楼栋已有 footprint
  const fp = utmToGcjPath(props.footprintUtm);
  if (fp.length >= 3) {
    const poly = new api.Polygon({
      path: fp,
      strokeColor: '#2f6df6',
      fillColor: '#2f6df6',
      fillOpacity: 0.12,
      strokeWeight: 2,
    });
    poly.setMap(map);
    overlays.push(poly);
  }

  // 变换后外轮廓预览
  const pv = utmToGcjPath(props.previewUtm);
  if (pv.length >= 3) {
    const poly = new api.Polygon({
      path: pv,
      strokeColor: '#ff8c1a',
      fillColor: '#ff8c1a',
      fillOpacity: 0.1,
      strokeWeight: 2,
      strokeStyle: 'dashed',
    });
    poly.setMap(map);
    overlays.push(poly);
  }

  // 锚点
  props.anchorsUtm.forEach((a, i) => {
    const [lng, lat] = utm49nToGcj02(a[0], a[1]);
    const marker = new api.Marker({
      position: [lng, lat],
      content: pinHtml(String.fromCharCode(9312 + i), '#16a34a'),
      anchor: 'bottom-center',
      zIndex: 200,
    });
    marker.setMap(map);
    overlays.push(marker);
  });

  if (fp.length >= 3 || props.anchorsUtm.length || pv.length) map.setFitView(overlays);
}

function onClick(e: unknown): void {
  if (props.disabled) return;
  const ev = e as { lnglat?: unknown };
  const ll = ev.lnglat as
    | { getLng?: () => number; getLat?: () => number; lng?: number; lat?: number }
    | undefined;
  if (!ll) return;
  const lng = typeof ll.getLng === 'function' ? ll.getLng() : (ll.lng ?? 0);
  const lat = typeof ll.getLat === 'function' ? ll.getLat() : (ll.lat ?? 0);
  if (!lng || !lat) return;
  const utm = gcj02ToUtm49n(lng, lat);
  emit('add', utm);
}

async function init(): Promise<void> {
  const key = import.meta.env.VITE_AMAP_KEY as string | undefined;
  const sec = import.meta.env.VITE_AMAP_SECURITY_CODE as string | undefined;
  if (!key) {
    available.value = false;
    loading.value = false;
    tip.value = '未配置高德地图 Key（VITE_AMAP_KEY），无法进行地图点选，请改用右侧手动坐标输入。';
    emit('unavailable');
    return;
  }
  try {
    const AMap = (await loadAMap({ key, securityJsCode: sec })) as unknown as AmapNs;
    ns = AMap;
    if (!mapEl.value) return;
    const center = centerGcj();
    map = new AMap.Map(mapEl.value, {
      center,
      zoom: 18,
      viewMode: '2D',
      mapStyle: 'amap://styles/whitesmoke',
    }) as AmapMap;
    map.on('click', onClick);
    available.value = true;
    loading.value = false;
    redraw();
  } catch (err) {
    available.value = false;
    loading.value = false;
    tip.value = `地图加载失败：${(err as Error).message ?? '未知错误'}，请改用右侧手动坐标输入。`;
    emit('unavailable');
  }
}

watch(
  () => [props.footprintUtm, props.anchorsUtm, props.previewUtm, props.disabled],
  () => redraw(),
  { deep: true },
);

onMounted(init);
onBeforeUnmount(() => {
  if (map && typeof map.destroy === 'function') map.destroy();
  map = null;
  ns = null;
  overlays = [];
});
</script>

<template>
  <div class="anchor-map">
    <div ref="mapEl" class="anchor-map__canvas">
      <div v-if="loading" class="anchor-map__mask">{{ tip }}</div>
      <div v-else-if="!available" class="anchor-map__mask anchor-map__mask--warn">{{ tip }}</div>
    </div>
    <div v-if="available" class="anchor-map__bar">
      <span><i class="dot dot--fp" />楼栋轮廓</span>
      <span><i class="dot dot--pv" />变换后外轮廓</span>
      <span><i class="dot dot--an" />已拾取锚点（{{ anchorsUtm.length }}/2）</span>
    </div>
  </div>
</template>

<style scoped>
.anchor-map {
  position: relative;
  width: 100%;
  height: 240px;
  border: 1px solid #dcdfe6;
  border-radius: 8px;
  overflow: hidden;
  background: #eef1f6;
}
.anchor-map__canvas {
  width: 100%;
  height: 100%;
}
.anchor-map__mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
  text-align: center;
  font-size: 12px;
  color: #4b5563;
  background: #eef1f6;
}
.anchor-map__mask--warn {
  color: #b45309;
}
.anchor-map__bar {
  position: absolute;
  left: 8px;
  bottom: 8px;
  display: flex;
  gap: 10px;
  font-size: 11px;
  color: #374151;
  background: rgba(255, 255, 255, 0.85);
  padding: 3px 8px;
  border-radius: 6px;
}
.anchor-map__bar .dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  margin-right: 4px;
  vertical-align: middle;
}
.dot--fp { background: #2f6df6; }
.dot--pv { background: #ff8c1a; }
.dot--an { background: #16a34a; }
</style>
