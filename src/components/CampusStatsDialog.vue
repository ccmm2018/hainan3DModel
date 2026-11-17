<template>
  <div class="csd-mask" @click.self="$emit('close')">
    <div class="csd-dialog" role="dialog" aria-modal="true" aria-label="校区数据统计">
      <!-- 顶部：标题 + 校区下拉（两 Tab 共用）+ 关闭 -->
      <div class="csd-head">
        <div class="csd-head__title">
          <span class="csd-head__dot"></span>
          <strong>校区数据统计</strong>
          <span v-if="!businessReady" class="csd-head__warn">示例数据</span>
        </div>
        <label class="csd-campus">
          <span>校区</span>
          <select v-model="campus" @change="onCampusChange">
            <option v-for="c in campuses" :key="c" :value="c">{{ c }}</option>
          </select>
        </label>
        <button class="csd-close" aria-label="关闭" @click="$emit('close')">×</button>
      </div>

      <!-- Tab 导航 -->
      <div class="csd-tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="csd-tab"
          :class="{ active: tab === t.key }"
          @click="tab = t.key"
        >{{ t.label }}</button>
      </div>

      <div class="csd-body">
        <!-- ============ Tab 1：校区总览 ============ -->
        <div v-if="tab === 'overview'" class="csd-pane">
          <p class="csd-hint">点击饼图的类别扇区，可下钻到「数据详情」查看该类楼栋。</p>
          <div class="csd-overview">
            <!-- 左：类别饼图 -->
            <section class="csd-card csd-card--chart">
              <h4>楼栋类别分布 <small>按建筑面积</small></h4>
              <div class="csd-chart-row">
                <svg class="csd-pie" viewBox="0 0 200 200" role="img" aria-label="楼栋类别占比饼图">
                  <g v-for="(s, i) in pieSlices" :key="s.key">
                    <path
                      :d="s.path"
                      :fill="s.color"
                      class="csd-pie__slice"
                      @click="drillCategory(s.key)"
                    >
                      <title>{{ s.label }}：{{ s.count }} 栋 · {{ fmtArea(s.area) }}</title>
                    </path>
                  </g>
                  <circle cx="100" cy="100" r="46" fill="#fff" />
                  <text x="100" y="95" text-anchor="middle" class="csd-pie__center-num">{{ overview.buildings }}</text>
                  <text x="100" y="115" text-anchor="middle" class="csd-pie__center-lab">栋楼</text>
                </svg>
                <ul class="csd-legend">
                  <li v-for="s in pieSlices" :key="s.key">
                    <button class="csd-legend__btn" @click="drillCategory(s.key)">
                      <i :style="{ background: s.color }"></i>
                      <span>{{ s.label }}</span>
                      <b>{{ s.count }} 栋</b>
                    </button>
                  </li>
                </ul>
              </div>
            </section>

            <!-- 右：关键指标（精简方案：面积 / 使用率 / 房间状态） -->
            <section class="csd-card csd-card--kpi">
              <h4>校区概况</h4>
              <div class="csd-kpi-grid">
                <div class="csd-kpi">
                  <span>建筑总面积</span><b>{{ fmtArea(overview.buildingArea) }}</b>
                </div>
                <div class="csd-kpi">
                  <span>使用面积</span><b>{{ fmtArea(overview.usableArea) }}</b>
                </div>
                <div class="csd-kpi csd-kpi--accent">
                  <span>空间使用率</span><b>{{ usageRate }}%</b>
                </div>
                <div class="csd-kpi">
                  <span>空置房间</span><b>{{ overview.vacantRooms }} 间</b>
                </div>
              </div>
              <div class="csd-status">
                <div class="csd-status__title">房间状态</div>
                <div class="csd-status__bar">
                  <span
                    v-for="s in statusBar"
                    :key="s.key"
                    :style="{ width: s.pct + '%', background: s.color }"
                    :title="`${s.label} ${s.count} 间`"
                  ></span>
                </div>
                <div class="csd-status__legend">
                  <span v-for="s in statusBar" :key="s.key">
                    <i :style="{ background: s.color }"></i>{{ s.label }} <b>{{ s.count }}</b>
                  </span>
                </div>
              </div>
            </section>
          </div>

          <!-- 汇总表 -->
          <section class="csd-card csd-card--table">
            <h4>楼栋汇总 <small>楼栋 › 楼层 › 房间，点行或箭头逐级下钻</small></h4>
            <table class="csd-table">
              <thead>
                <tr><th>楼栋</th><th>校区</th><th>类别</th><th>层数</th><th>建筑面积</th><th>房间数</th><th></th></tr>
              </thead>
              <tbody>
                <tr v-for="b in overview.buildingList" :key="b.name" @click="drillBuilding(b.name)">
                  <td class="csd-td-name">{{ b.name }}</td>
                  <td>{{ b.campus || '—' }}</td>
                  <td><span class="csd-cat" :style="{ '--c': categoryColor(b.category) }">{{ b.category }}</span></td>
                  <td>{{ b.totalFloors ?? '—' }}</td>
                  <td>{{ fmtArea(b.buildingArea) }}</td>
                  <td>{{ b.roomCount }}</td>
                  <td class="csd-td-arrow" title="下钻查看该楼栋的楼层与房间"><span>›</span></td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>

        <!-- ============ Tab 2：数据详情（三级下钻） ============ -->
        <div v-else class="csd-pane">
          <!-- 面包屑：校区总览 > 类别 > 楼栋 > 楼层 -->
          <nav class="csd-crumb">
            <button @click="backToOverview">校区总览</button>
            <template v-if="drill.category">
              <span class="csd-crumb__sep">›</span>
              <button :class="{ current: !drill.building }" @click="clearBelow('category')">{{ drill.category }}</button>
            </template>
            <template v-if="drill.building">
              <span class="csd-crumb__sep">›</span>
              <button :class="{ current: !drill.floor }" @click="clearBelow('building')">{{ drill.building }}</button>
            </template>
            <template v-if="drill.floor">
              <span class="csd-crumb__sep">›</span>
              <span class="csd-crumb__current">{{ drill.floor }}F</span>
            </template>
          </nav>

          <p class="csd-hint csd-hint--detail">
            {{ drillHint }}
          </p>

          <!-- 层级 1：类别下的楼栋列表 -->
          <section v-if="!drill.building" class="csd-card csd-card--table">
            <table class="csd-table csd-table--drill">
              <thead>
                <tr><th>楼栋</th><th>类别</th><th>校区</th><th>管理部门</th><th>层数</th><th>房间数</th><th></th></tr>
              </thead>
              <tbody>
                <tr v-for="b in detailBuildings" :key="b.name" @click="drillBuilding(b.name)">
                  <td class="csd-td-name">{{ b.name }}</td>
                  <td><span class="csd-cat" :style="{ '--c': categoryColor(b.category) }">{{ b.category }}</span></td>
                  <td>{{ b.campus || '—' }}</td>
                  <td>{{ b.managementDept ?? '—' }}</td>
                  <td>{{ b.totalFloors ?? '—' }}</td>
                  <td>{{ b.roomCount }}</td>
                  <td class="csd-td-arrow" title="下钻查看该楼栋的楼层与房间"><span>›</span></td>
                </tr>
              </tbody>
            </table>
            <p v-if="!detailBuildings.length" class="csd-empty">该类别下暂无楼栋</p>
          </section>

          <!-- 层级 2：某栋楼的楼层列表 -->
          <section v-else-if="drill.building && !drill.floor" class="csd-card csd-card--table">
            <table class="csd-table csd-table--drill">
              <thead>
                <tr><th>楼层</th><th>房间数</th><th>使用中</th><th>空置</th><th>无权限</th><th></th></tr>
              </thead>
              <tbody>
                <tr v-for="fl in detailFloors" :key="fl.floor" @click="drillFloor(fl.floor)">
                  <td class="csd-td-name">{{ fl.floor }}F</td>
                  <td>{{ fl.rooms.length }}</td>
                  <td>{{ fl.counts.occupied }}</td>
                  <td>{{ fl.counts.vacant }}</td>
                  <td>{{ fl.counts.noaccess }}</td>
                  <td class="csd-td-arrow" title="展开该楼层房间明细"><span>›</span></td>
                </tr>
              </tbody>
            </table>
          </section>

          <!-- 层级 3：某层的房间明细 -->
          <section v-else class="csd-card csd-card--table">
            <table class="csd-table csd-table--drill">
              <thead>
                <tr><th>房间号</th><th>用途</th><th>使用部门</th><th>面积</th><th>状态</th></tr>
              </thead>
              <tbody>
                <tr v-for="room in detailRooms" :key="room.id">
                  <td class="csd-td-name">{{ room.roomNo }}</td>
                  <td>{{ room.purpose ?? '—' }}</td>
                  <td>{{ room.department ?? '—' }}</td>
                  <td>{{ room.area }} ㎡</td>
                  <td><span class="csd-status-tag" :style="{ '--c': statusColor(room.status) }">{{ statusLabel(room.status) }}</span></td>
                </tr>
              </tbody>
            </table>
            <p v-if="!detailRooms.length" class="csd-empty">该楼层暂无房间数据</p>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import {
  BUILDING_CATEGORIES, CAMPUS_ORDER, OTHER_CATEGORY, resolveBizCategory,
} from '../data/buildingData';
import type { BuildingDataMap, BuildingProps } from '../data/buildingData';
import type { Room, RoomDataMap, RoomStatus } from '../data/roomData';
import { ROOM_STATUS_CONFIG } from '../data/roomData';

const props = defineProps<{
  buildings: BuildingDataMap;
  rooms: RoomDataMap;
  modelBuildings: number;
  businessReady: boolean;
}>();
defineEmits<{ (e: 'close'): void }>();

const tabs = [
  { key: 'overview', label: '校区总览' },
  { key: 'detail', label: '数据详情' },
] as const;
type TabKey = 'overview' | 'detail';

// 楼栋类别统一由数据层 resolveBizCategory 提供（基础数据 bizCategory 字段 → 楼名兜底），
// 不再在本组件内重复维护一套正则/颜色表，保证「类别分布 / 楼栋汇总 / 数据详情」口径一致。
function categoryOf(b: BuildingProps): string {
  return resolveBizCategory(b).label;
}
function categoryColor(c: string): string {
  const meta = [...BUILDING_CATEGORIES, OTHER_CATEGORY].find((m) => m.label === c);
  return meta?.color ?? OTHER_CATEGORY.color;
}

// 只取带业务字段的真实楼栋（排除 registerBuildings 登记的空记录）
const allBuildings = computed<BuildingProps[]>(() =>
  Object.values(props.buildings).filter(
    (p) => (p.category ?? 'building') === 'building' &&
      (p.totalFloors != null || p.buildingArea != null || p.roomCount != null || p.usableArea != null),
  ),
);

function roomsOfBuilding(name: string): Room[] {
  if (props.rooms[name]) return props.rooms[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(props.rooms)) {
    if (k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase())) return props.rooms[k];
  }
  return [];
}

const campuses = computed<string[]>(() => {
  const set = new Set<string>();
  for (const b of allBuildings.value) if (b.campus) set.add(String(b.campus));
  const list = [...set];
  if (!list.length) list.push('全部');
  // 基础数据里出现的校区按 CAMPUS_ORDER 排；数据里新增的校区追加到后面。
  return list.sort((a, b) => {
    const ia = CAMPUS_ORDER.indexOf(a), ib = CAMPUS_ORDER.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b, 'zh');
  });
});

const campus = ref('');
const tab = ref<TabKey>('overview');
const drill = reactive({ category: '', building: '', floor: 0 as number });

// 首次把校区设为主校区（若有），否则第一个
watch(campuses, (list) => {
  if (!list.includes(campus.value)) campus.value = list.includes('主校区') ? '主校区' : list[0];
}, { immediate: true });

const campusBuildings = computed<BuildingProps[]>(() =>
  allBuildings.value.filter((b) => !campus.value || campus.value === '全部' || String(b.campus) === campus.value),
);

// ---- 总览聚合 ----
const overview = computed(() => {
  const list = campusBuildings.value;
  const roomList = list.flatMap((b) => roomsOfBuilding(b.name));
  return {
    buildings: list.length,
    buildingArea: list.reduce((s, b) => s + (Number(b.buildingArea) || 0), 0),
    usableArea: list.reduce((s, b) => s + (Number(b.usableArea) || 0), 0),
    rooms: roomList.reduce((s) => s + 1, 0),
    // 空置房间数：与下方「房间状态」条里的「空置」口径一致，反映可分配房源
    vacantRooms: roomList.filter((r) => r.status === 'vacant').length,
    buildingList: list.map((b) => ({
      name: b.name,
      category: categoryOf(b),
      campus: String(b.campus ?? ''),
      totalFloors: b.totalFloors,
      buildingArea: b.buildingArea,
      roomCount: roomsOfBuilding(b.name).length || b.roomCount || 0,
      managementDept: b.managementDept ?? b.department,
    })),
  };
});

const usageRate = computed(() => {
  const o = overview.value;
  return o.buildingArea > 0 ? Math.round((o.usableArea / o.buildingArea) * 100) : 0;
});

// 按类别聚合（用于饼图）
const categoryStats = computed(() => {
  const map = new Map<string, { key: string; label: string; count: number; area: number; color: string; order: number }>();
  for (const b of campusBuildings.value) {
    const meta = resolveBizCategory(b);
    const c = meta.label;
    const cur = map.get(c) ?? { key: c, label: c, count: 0, area: 0, color: meta.color, order: meta.order };
    cur.count += 1;
    cur.area += Number(b.buildingArea) || 0;
    map.set(c, cur);
  }
  return [...map.values()].sort((a, b) => a.order - b.order || b.area - a.area);
});

// 纯 SVG 饼图（按 area 划分，可点击扇区）
const pieSlices = computed(() => {
  const slices = categoryStats.value.filter((s) => s.area > 0);
  const total = slices.reduce((s, x) => s + x.area, 0);
  if (!total) return [];
  let start = -Math.PI / 2;
  return slices.map((s) => {
    const angle = (s.area / total) * Math.PI * 2;
    const end = start + angle;
    const x1 = 100 + 78 * Math.cos(start), y1 = 100 + 78 * Math.sin(start);
    const x2 = 100 + 78 * Math.cos(end), y2 = 100 + 78 * Math.sin(end);
    const large = angle > Math.PI ? 1 : 0;
    const path = `M100 100 L${x1.toFixed(2)} ${y1.toFixed(2)} A78 78 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
    start = end;
    return { ...s, path };
  });
});

// 房间状态占比
const statusBar = computed(() => {
  const list = campusBuildings.value.flatMap((b) => roomsOfBuilding(b.name));
  const order: RoomStatus[] = ['occupied', 'vacant', 'noaccess'];
  const counts: Record<string, number> = { occupied: 0, vacant: 0, noaccess: 0 };
  for (const r of list) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const total = list.length || 1;
  return order.map((k) => ({
    key: k,
    label: ROOM_STATUS_CONFIG[k].label,
    color: ROOM_STATUS_CONFIG[k].deep,
    count: counts[k],
    pct: (counts[k] / total) * 100,
  }));
});

// ---- 详情下钻 ----
const detailBuildings = computed(() =>
  campusBuildings.value.filter((b) => !drill.category || categoryOf(b) === drill.category).map((b) => ({
    name: b.name,
    category: categoryOf(b),
    campus: String(b.campus ?? ''),
    totalFloors: b.totalFloors,
    roomCount: roomsOfBuilding(b.name).length || b.roomCount || 0,
    managementDept: b.managementDept ?? b.department,
  })),
);

const currentRooms = computed(() => roomsOfBuilding(drill.building));
const detailFloors = computed(() => {
  const map = new Map<number, Room[]>();
  for (const r of currentRooms.value) {
    const arr = map.get(r.floor) ?? [];
    arr.push(r);
    map.set(r.floor, arr);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([floor, rooms]) => ({
    floor,
    rooms,
    counts: {
      occupied: rooms.filter((r) => r.status === 'occupied').length,
      vacant: rooms.filter((r) => r.status === 'vacant').length,
      noaccess: rooms.filter((r) => r.status === 'noaccess').length,
    },
  }));
});
const detailRooms = computed(() =>
  currentRooms.value.filter((r) => r.floor === drill.floor)
    .sort((a, b) => a.roomNo.localeCompare(b.roomNo, undefined, { numeric: true })),
);

const drillHint = computed(() => {
  if (drill.floor) return `${drill.building} · ${drill.floor}F 房间明细`;
  if (drill.building) return `${drill.building} · 楼层列表（点楼层展开房间）`;
  if (drill.category) return `${drill.category} · 楼栋列表（点楼栋展开楼层）`;
  return '全部楼栋（点楼栋展开楼层）';
});

function resetDrill() { drill.category = ''; drill.building = ''; drill.floor = 0; }
function onCampusChange() { resetDrill(); tab.value = 'overview'; }
function backToOverview() { resetDrill(); tab.value = 'overview'; }
function clearBelow(level: 'category' | 'building') {
  if (level === 'category') { drill.building = ''; drill.floor = 0; }
  else { drill.floor = 0; }
}
function drillCategory(key: string) {
  resetDrill();
  drill.category = key;
  tab.value = 'detail';
}
function drillBuilding(name: string) {
  const b = campusBuildings.value.find((x) => x.name === name);
  drill.building = name;
  if (!drill.category) drill.category = b ? categoryOf(b) : '';
  drill.floor = 0;
  // 从「校区总览」的楼栋汇总表点进来时必须切到详情 Tab，
  // 否则只改了下钻状态、界面留在总览，看起来像箭头没反应。
  tab.value = 'detail';
}
function drillFloor(floor: number) { drill.floor = floor; }

function fmtArea(n: number | null | undefined): string {
  return n != null ? `${Number(n).toLocaleString()} ㎡` : '—';
}
function statusLabel(s: RoomStatus): string { return ROOM_STATUS_CONFIG[s]?.label ?? s; }
function statusColor(s: RoomStatus): string { return ROOM_STATUS_CONFIG[s]?.deep ?? '#888'; }
</script>

<style scoped>
.csd-mask {
  position: absolute; inset: 0; z-index: 260;
  display: flex; align-items: center; justify-content: center;
  background: rgba(6, 10, 20, 0.6); backdrop-filter: blur(3px);
}
.csd-dialog {
  width: 900px; max-width: 94vw; height: 640px; max-height: 92vh;
  display: flex; flex-direction: column;
  border: 1px solid #e2e8f1; border-radius: 14px; background: #fff;
  box-shadow: 0 24px 70px rgba(10, 22, 40, 0.32);
  overflow: hidden;
}
.csd-head {
  display: flex; align-items: center; gap: 16px;
  padding: 14px 18px; border-bottom: 1px solid #eef1f6; color: #16233a;
}
.csd-head__title { display: flex; align-items: center; gap: 8px; flex: 1; }
.csd-head__title strong { font-size: 16px; font-weight: 700; }
.csd-head__dot { width: 9px; height: 9px; border-radius: 50%; background: #1a8f5a; box-shadow: 0 0 0 4px rgba(26,143,90,.13); }
.csd-head__warn { font-size: 10px; color: #b26a00; background: #fdf1dc; padding: 2px 7px; border-radius: 4px; }
.csd-campus { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #5a6678; }
.csd-campus select {
  height: 30px; padding: 0 26px 0 10px; border: 1px solid #cfd8e5; border-radius: 6px;
  color: #1f2a3a; background: #f7f9fc; font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.csd-close {
  width: 28px; height: 28px; border: 0; border-radius: 6px; color: #7c8798;
  background: transparent; font-size: 21px; line-height: 1; cursor: pointer;
}
.csd-close:hover { color: #c0392b; background: #f2e9e9; }

.csd-tabs { display: flex; gap: 4px; padding: 0 18px; border-bottom: 1px solid #eef1f6; background: #fbfcfe; }
.csd-tab {
  padding: 11px 18px; border: 0; border-bottom: 2px solid transparent;
  color: #6b7789; background: transparent; font-size: 13px; font-weight: 600; cursor: pointer;
}
.csd-tab:hover { color: #1b6fa8; }
.csd-tab.active { color: #0b6fb8; border-bottom-color: #0b6fb8; }

.csd-body { flex: 1; overflow-y: auto; padding: 16px 18px 22px; background: #f4f7fb; }
.csd-hint { margin: 0 0 12px; font-size: 11.5px; color: #7a8698; }
.csd-hint--detail { margin-bottom: 10px; }

.csd-card {
  background: #fff; border: 1px solid #e6ebf2; border-radius: 10px;
  padding: 14px 16px; margin-bottom: 14px;
}
.csd-card h4 { margin: 0 0 12px; font-size: 13px; font-weight: 700; color: #1f2a3a; }
.csd-card h4 small { font-size: 10.5px; font-weight: 400; color: #9aa5b5; margin-left: 6px; }
.csd-overview { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.csd-chart-row { display: flex; align-items: center; gap: 10px; }
.csd-pie { width: 168px; height: 168px; flex-shrink: 0; }
.csd-pie__slice { cursor: pointer; transition: opacity .15s; stroke: #fff; stroke-width: 1.5; }
.csd-pie__slice:hover { opacity: .78; }
.csd-pie__center-num { font-size: 22px; font-weight: 800; fill: #1b4e72; }
.csd-pie__center-lab { font-size: 10px; fill: #93a0b2; }
.csd-legend { list-style: none; margin: 0; padding: 0; flex: 1; }
.csd-legend li { margin-bottom: 6px; }
.csd-legend__btn {
  display: flex; align-items: center; gap: 7px; width: 100%;
  padding: 5px 7px; border: 1px solid transparent; border-radius: 6px;
  background: transparent; font-size: 12px; color: #3a4658; cursor: pointer; text-align: left;
}
.csd-legend__btn:hover { background: #f0f5fa; border-color: #dce7f2; }
.csd-legend__btn i { width: 9px; height: 9px; border-radius: 2px; flex-shrink: 0; }
.csd-legend__btn span { flex: 1; }
.csd-legend__btn b { color: #1f2a3a; font-variant-numeric: tabular-nums; }

.csd-kpi-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.csd-kpi {
  padding: 10px 12px; border-radius: 8px;
  background: linear-gradient(140deg, #f3f7fc, #eaf1f9); border: 1px solid #dfe9f4;
}
.csd-kpi span { display: block; font-size: 10.5px; color: #6c7b90; margin-bottom: 3px; }
.csd-kpi b { font-size: 17px; font-weight: 800; color: #1b4e72; }
.csd-kpi--accent { background: linear-gradient(140deg, #eaf7f1, #ddf0e6); border-color: #cfe9dc; }
.csd-kpi--accent b { color: #1a7a52; }
.csd-status { margin-top: 12px; }
.csd-status__title { font-size: 11px; color: #6c7b90; margin-bottom: 6px; }
.csd-status__bar { display: flex; height: 12px; border-radius: 6px; overflow: hidden; background: #eef1f5; }
.csd-status__bar span { transition: width .2s; }
.csd-status__legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; font-size: 11px; color: #5a6678; }
.csd-status__legend span { display: inline-flex; align-items: center; gap: 5px; }
.csd-status__legend i { width: 8px; height: 8px; border-radius: 2px; }
.csd-status__legend b { color: #1f2a3a; }

.csd-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.csd-table th {
  text-align: left; padding: 8px 10px; color: #7a8698; font-weight: 600; font-size: 11px;
  background: #f7f9fc; border-bottom: 1px solid #e6ebf2;
}
.csd-table td { padding: 9px 10px; color: #3a4658; border-bottom: 1px solid #f0f3f7; }
.csd-card--table tbody tr { cursor: pointer; transition: background .12s; }
.csd-card--table tbody tr:hover { background: #f0f6fc; }
.csd-td-name { font-weight: 700; color: #1f2a3a !important; }
.csd-td-arrow { color: #9aa5b5; font-size: 18px; text-align: right; width: 24px; }
.csd-cat {
  display: inline-block; padding: 2px 8px; border-radius: 10px;
  font-size: 10.5px; color: var(--c); background: color-mix(in srgb, var(--c) 12%, #fff);
  border: 1px solid color-mix(in srgb, var(--c) 30%, #fff);
}
.csd-status-tag {
  display: inline-block; padding: 2px 8px; border-radius: 10px;
  font-size: 10.5px; color: var(--c); background: color-mix(in srgb, var(--c) 12%, #fff);
}
.csd-empty { text-align: center; color: #9aa5b5; font-size: 12px; padding: 18px 0 6px; }

.csd-crumb { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap; }
.csd-crumb button {
  border: 0; background: transparent; color: #0b6fb8; font-size: 12.5px; cursor: pointer; padding: 3px 4px;
}
.csd-crumb button:hover { text-decoration: underline; }
.csd-crumb button.current { color: #1f2a3a; font-weight: 700; cursor: default; text-decoration: none; }
.csd-crumb__sep { color: #b3bdca; }
.csd-crumb__current { color: #1f2a3a; font-weight: 700; font-size: 12.5px; padding: 3px 4px; }
</style>
