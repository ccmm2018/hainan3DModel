<template>
  <div ref="shellRef" class="scene-shell">
    <div ref="mapContainer" class="scene-map"></div>

    <!-- 加载/错误遮罩 -->
    <div v-if="status !== 'ready'" class="scene-overlay">
      <template v-if="status === 'loading-amap'">
        <span class="spinner"></span>
        <strong>正在加载高德地图 JS API…</strong>
      </template>
      <template v-else-if="status === 'loading-model'">
        <span class="spinner"></span>
        <strong>正在加载校园 GLB 模型…</strong>
        <small v-if="modelProgress >= 0">{{ modelProgress }}%</small>
      </template>
      <template v-else-if="status === 'error'">
        <strong class="err">{{ errorMessage }}</strong>
        <div class="err-hint">
          <template v-if="!keyConfigured">
            1. 打开高德开放平台 console.amap.com，创建「Web端(JS API)」应用<br />
            2. 复制 Key 和「安全密钥 securityJsCode」<br />
            3. 填入项目根目录的 <code>.env</code> 文件（已为你生成）<br />
            4. 保存后重启 <code>npm run dev</code>
          </template>
          <template v-else>请检查模型路径、网络连接后刷新重试</template>
        </div>
      </template>
    </div>

    <!-- 标题徽标 -->
    <div class="scene-badge">
      <span class="badge-light"></span>
      海南警察学院 · 3D 可视化场景
    </div>

    <!-- 工具栏 -->
    <div class="toolbar">
      <div class="toolbar__group">
        <span class="toolbar__label">视图</span>
        <button class="toolbar__btn" :class="{ active: currentView === '2d' }" @click="setView('2d')">2D</button>
        <button class="toolbar__btn" :class="{ active: currentView === '2.5d' }" @click="setView('2.5d')">2.5D</button>
        <button class="toolbar__btn" :class="{ active: currentView === '3d' }" @click="setView('3d')">三维</button>
        <button class="toolbar__btn" :class="{ active: isIndoorView }" @click="toggleIndoor">室内</button>
      </div>
      <div class="toolbar__group">
        <span class="toolbar__label">量算</span>
        <button class="toolbar__btn" :class="{ active: measureTool === 'distance' }" @click="startMeasure('distance')">测距</button>
        <button class="toolbar__btn" :class="{ active: measureTool === 'area' }" @click="startMeasure('area')">测面</button>
        <button v-if="measureActive" class="toolbar__btn toolbar__btn--ok" @click="completeMeasure">完成</button>
        <button class="toolbar__btn toolbar__btn--ghost" @click="stopMeasure">清除</button>
      </div>
      <button class="toolbar__btn" @click="exportOpen = true">打印 / 导出</button>
    </div>

    <!-- 量算结果面板 -->
    <div v-if="measureResult" class="measure-panel" :class="measureResult.mode === 'area' ? 'measure-panel--area' : 'measure-panel--distance'">
      <div class="measure-panel__head">
        <strong>{{ measureResult.mode === 'distance' ? '测距结果' : '测面结果' }}</strong>
        <button class="measure-panel__close" aria-label="清除" @click="stopMeasure">×</button>
      </div>
      <div v-if="measureResult.mode === 'distance'" class="measure-panel__body">
        <div class="measure-panel__total">总长度：<b>{{ formatMeters(measureResult.value) }}</b></div>
        <ol v-if="measureResult.segments && measureResult.segments.length" class="measure-panel__segs">
          <li v-for="(s, i) in measureResult.segments" :key="i">
            <span>第 {{ i + 1 }} 段</span><span>{{ formatMeters(s) }}</span>
          </li>
        </ol>
      </div>
      <div v-else class="measure-panel__body">
        <div class="measure-panel__total">总面积：<b>{{ formatArea(measureResult.value) }}</b></div>
        <div class="measure-panel__meta">顶点数：{{ measureResult.points }}</div>
      </div>
      <div class="measure-panel__tip">在地图或模型上连续点击打点 · 双击或点「完成」结束</div>
    </div>

    <!-- 室内视角提示 -->
    <div v-if="isIndoorView" class="indoor-badge">
      <span class="indoor-badge__dot"></span>
      室内视角 · 按 ESC 退出
    </div>

    <!-- 搜索框 -->
    <div class="search-box">
      <input
        v-model="searchQuery"
        type="text"
        placeholder="搜索建筑名称，回车定位…"
        @input="onSearchInput"
        @keydown.enter="onSearchEnter"
        @focus="searchFocused = true"
        @blur="searchFocused = false"
      />
      <ul v-if="searchFocused && filteredObjects.length" class="search-dropdown">
        <li
          v-for="item in filteredObjects"
          :key="item.name"
          @mousedown.prevent="selectByName(item.name)"
        >
          <span class="search-dropdown__name">{{ item.name }}</span>
          <span class="search-dropdown__coord">{{ item.lngLat[0].toFixed(5) }}, {{ item.lngLat[1].toFixed(5) }}</span>
        </li>
      </ul>
    </div>

    <!-- 悬停 tooltip -->
    <div v-if="hovered" class="tooltip" :style="tooltipStyle">
      {{ hovered.name }}
      <span v-if="hovered.isRoom" class="tooltip__status" :style="{ color: roomStatusColor(hovered.room) }">
        {{ roomStatusLabel(hovered.room) }}
      </span>
    </div>

    <!-- 节点锚点标记：指示浮层指向的模型节点 -->
    <div
      v-if="anchorDot"
      class="anchor-dot"
      :style="{ left: `${anchorDot.x}px`, top: `${anchorDot.y}px` }"
    ></div>

    <!-- 属性面板（场景模式）：锚定在被点击的模型节点旁 -->
    <div
      v-if="selected && viewMode === 'scene'"
      ref="panelEl"
      class="property-panel"
      :style="panelPos"
    >
      <div class="property-panel__head">
        <span class="dot"></span>
        <strong>{{ selectedProps.name }}</strong>
        <button class="property-panel__locate" title="定位到该建筑" @click="flyToSelected">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
          </svg>
        </button>
        <button class="property-panel__close" aria-label="关闭" @click="closePanel">×</button>
      </div>

      <!-- 楼宇图片（无图片时显示占位） -->
      <div class="property-panel__image">
        <img
          v-if="selectedProps.image && !imageError"
          :src="selectedProps.image"
          :alt="selectedProps.name"
          @error="imageError = true"
        />
        <div v-else class="property-panel__image-placeholder">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.2">
            <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6"/>
            <path d="M9 10h.01M15 10h.01M9 13h.01M15 13h.01"/>
          </svg>
          <span>{{ selectedProps.name }}</span>
        </div>
      </div>

      <dl>
        <div>
          <dt>所在校区</dt>
          <dd>{{ selectedProps.campus ?? '—' }}</dd>
        </div>
        <div>
          <dt>管理部门</dt>
          <dd>{{ selectedProps.managementDept ?? selectedProps.department ?? '—' }}</dd>
        </div>
        <div>
          <dt>总层数</dt>
          <dd>{{ selectedProps.totalFloors != null ? `${selectedProps.totalFloors} 层` : '—' }}</dd>
        </div>
        <div>
          <dt>房间数</dt>
          <dd>{{ selectedProps.roomCount != null ? `${selectedProps.roomCount} 间` : '—' }}</dd>
        </div>
        <div>
          <dt>建筑面积</dt>
          <dd>{{ selectedProps.buildingArea != null ? `${selectedProps.buildingArea.toLocaleString()} ㎡` : '—' }}</dd>
        </div>
        <div>
          <dt>使用面积</dt>
          <dd>{{ selectedProps.usableArea != null ? `${selectedProps.usableArea.toLocaleString()} ㎡` : '—' }}</dd>
        </div>
      </dl>

      <div class="property-panel__actions">
        <button class="property-panel__btn" @click="openBuildingDetail">楼宇详情</button>
        <button class="property-panel__btn property-panel__btn--primary" @click="openRoomManagement">房间管理</button>
        <button class="property-panel__btn property-panel__btn--primary" @click="openIndoorPlan">查看室内图纸</button>
      </div>
    </div>

    <!-- 楼宇详情弹窗 -->
    <div v-if="detailOpen && selectedProps.name" class="detail-modal" @click.self="detailOpen = false">
      <div class="detail-modal__card">
        <div class="detail-modal__head">
          <strong>{{ selectedProps.name }} · 楼宇详情</strong>
          <button class="property-panel__close" aria-label="关闭" @click="detailOpen = false">×</button>
        </div>

        <!-- Tab 导航 -->
        <div class="detail-modal__tabs">
          <button
            v-for="t in detailTabs"
            :key="t"
            class="detail-tab"
            :class="{ active: detailTab === t }"
            @click="detailTab = t"
          >{{ t }}</button>
        </div>

        <div class="detail-modal__body">
          <!-- 基础信息 -->
          <div v-if="detailTab === '基础信息'" class="detail-tabpane">
            <div v-if="selectedProps.image && !imageError" class="detail-modal__image">
              <img :src="selectedProps.image" :alt="selectedProps.name" @error="imageError = true" />
            </div>
            <dl class="detail-modal__grid">
              <div><dt>所在校区</dt><dd>{{ selectedProps.campus ?? '—' }}</dd></div>
              <div><dt>管理部门</dt><dd>{{ selectedProps.managementDept ?? selectedProps.department ?? '—' }}</dd></div>
              <div><dt>使用部门</dt><dd>{{ selectedProps.department ?? '—' }}</dd></div>
              <div><dt>类型</dt><dd>{{ categoryLabel(selectedProps.category) }}</dd></div>
              <div><dt>总层数</dt><dd>{{ selectedProps.totalFloors != null ? `${selectedProps.totalFloors} 层` : '—' }}</dd></div>
              <div><dt>房间数</dt><dd>{{ selectedProps.roomCount != null ? `${selectedProps.roomCount} 间` : '—' }}</dd></div>
              <div><dt>建筑面积</dt><dd>{{ selectedProps.buildingArea != null ? `${selectedProps.buildingArea.toLocaleString()} ㎡` : '—' }}</dd></div>
              <div><dt>使用面积</dt><dd>{{ selectedProps.usableArea != null ? `${selectedProps.usableArea.toLocaleString()} ㎡` : '—' }}</dd></div>
              <div><dt>建筑高度</dt><dd>{{ selectedProps.height ?? '—' }}</dd></div>
              <div v-if="selected"><dt>经纬度</dt><dd>{{ selected.lngLat[0].toFixed(6) }}, {{ selected.lngLat[1].toFixed(6) }}</dd></div>
            </dl>
            <p v-if="selectedProps.description" class="detail-modal__desc">{{ selectedProps.description }}</p>
          </div>

          <!-- 附件信息 -->
          <div v-else-if="detailTab === '附件信息'" class="detail-tabpane">
            <ul class="attach-list">
              <li v-for="(a, i) in attachmentList" :key="i" class="attach-item">
                <span class="attach-icon" :class="`attach-icon--${a.type}`">{{ a.type === 'img' ? '图' : '档' }}</span>
                <div class="attach-meta">
                  <div class="attach-name">{{ a.name }} <em v-if="a.sample" class="tag-sample">示例</em></div>
                  <div class="attach-sub">{{ a.typeLabel }} · {{ a.size }} · {{ a.time }}</div>
                </div>
                <button class="attach-dl" @click="downloadStub(a)">下载</button>
              </li>
            </ul>
          </div>

          <!-- 资产信息 -->
          <div v-else-if="detailTab === '资产信息'" class="detail-tabpane">
            <div class="asset-summary">
              <div><span>资产编码</span><b>{{ assetSummary.code }}</b></div>
              <div><span>资产类别</span><b>{{ assetSummary.category }}</b></div>
              <div><span>建筑原值</span><b>{{ assetSummary.original.toLocaleString() }} 元</b></div>
              <div><span>当前净值</span><b>{{ assetSummary.net.toLocaleString() }} 元</b></div>
              <div><span>折旧年限</span><b>{{ assetSummary.life }} 年</b></div>
              <div><span>使用状态</span><b>{{ assetSummary.status }}</b></div>
            </div>
            <p class="tab-note">资产台账对接中，金额为按建筑面积测算的示例值。</p>
          </div>

          <!-- 楼栋资产 -->
          <div v-else-if="detailTab === '楼栋资产'" class="detail-tabpane">
            <table class="asset-table">
              <thead><tr><th>资产大类</th><th>金额（元）</th><th>占比</th></tr></thead>
              <tbody>
                <tr v-for="row in buildingAssetRows" :key="row.name">
                  <td>{{ row.name }}</td>
                  <td>{{ row.amount.toLocaleString() }}</td>
                  <td>{{ row.percent }}%</td>
                </tr>
              </tbody>
            </table>
            <p class="tab-note">楼栋资产按大类拆分，金额为示例测算值。</p>
          </div>

          <!-- 楼层信息 -->
          <div v-else-if="detailTab === '楼层信息'" class="detail-tabpane">
            <table class="asset-table">
              <thead><tr><th>楼层</th><th>面积（㎡）</th><th>房间数</th><th>主要用途</th></tr></thead>
              <tbody>
                <tr v-for="f in floorRows" :key="f.floor">
                  <td>{{ f.floor }}F</td>
                  <td>{{ f.area.toLocaleString() }}</td>
                  <td>{{ f.rooms }}</td>
                  <td>{{ f.use }}</td>
                </tr>
              </tbody>
            </table>
            <p v-if="!floorRows.length" class="tab-empty">暂无楼层数据</p>
          </div>

          <!-- 变更记录 -->
          <div v-else-if="detailTab === '变更记录'" class="detail-tabpane">
            <ul class="change-list">
              <li v-for="(c, i) in changeRecords" :key="i" class="change-item">
                <span class="change-dot"></span>
                <div class="change-body">
                  <div class="change-top"><b>{{ c.type }}</b><span>{{ c.date }}</span></div>
                  <div class="change-desc">{{ c.desc }}</div>
                  <div class="change-by">经办：{{ c.by }}</div>
                </div>
              </li>
            </ul>
            <p class="tab-note">变更记录为示例数据，正式数据由资产系统同步。</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 房间管理面板：右侧停靠，宽 20%，无遮罩层 -->
    <div v-if="roomMgmtOpen && selectedProps.name" class="room-mgmt-modal">
      <div class="room-mgmt__card">
        <div class="room-mgmt__head">
          <strong>{{ selectedProps.name }} · 房间管理</strong>
          <button class="property-panel__close" aria-label="关闭" @click="roomMgmtOpen = false">×</button>
        </div>

        <!-- 状态汇总：使用中 / 无权限 / 空置 数量 -->
        <div class="room-mgmt__summary">
          <span
            v-for="s in ROOM_STATUS_ORDER"
            :key="s"
            class="room-mgmt__pill"
            :style="{ '--c': ROOM_STATUS_CONFIG[s].color }"
          >
            <i :style="{ background: ROOM_STATUS_CONFIG[s].color }"></i>
            {{ ROOM_STATUS_CONFIG[s].label }}
            <b>{{ roomMgmtCounts[s] }}</b>
          </span>
        </div>

        <!-- 全部楼层 + 对应房间（按楼层分区，分割线划分，整体可滚动） -->
        <div class="room-mgmt__body">
          <template v-if="roomMgmtByFloor.length">
            <section
              v-for="sec in roomMgmtByFloor"
              :key="sec.floor"
              class="room-mgmt__floor-section"
            >
              <div class="room-mgmt__floor-title">{{ sec.floor }}F</div>
              <div class="room-mgmt__grid">
                <div
                  v-for="room in sec.rooms"
                  :key="room.id"
                  class="room-mgmt__cell"
                  :style="{ '--c': ROOM_STATUS_CONFIG[room.status].color }"
                  :title="`${room.roomNo} · ${ROOM_STATUS_CONFIG[room.status].label}${room.roomName ? ' · ' + room.roomName : ''}`"
                >
                  <span class="room-mgmt__no">{{ room.roomNo }}</span>
                </div>
              </div>
            </section>
          </template>
          <p v-else class="tab-empty">该楼栋暂无房间数据</p>
        </div>
      </div>
    </div>

    <!-- 楼盘表面板（房间模式 / 分配模式共用） -->
    <div v-if="viewMode === 'room' || viewMode === 'allocate'" class="room-panel">
      <div class="room-panel__head">
        <span class="dot"></span>
        <strong>{{ roomBuilding?.name ?? '' }} · {{ viewMode === 'allocate' ? '房屋分配' : '楼盘表' }}</strong>
        <button v-if="viewMode === 'room'" class="room-panel__alloc" @click="enterAllocationMode">分配模式</button>
        <button class="room-panel__exit" @click="viewMode === 'allocate' ? exitAllocationMode() : exitRoomMode()">退出</button>
      </div>
      <div class="floor-switch">
        <button
          v-for="f in roomFloors"
          :key="f"
          class="floor-switch__btn"
          :class="{ active: f === currentFloor }"
          @click="switchFloor(f)"
        >
          {{ f }}F
        </button>
      </div>
      <div class="legend">
        <span v-for="s in ROOM_STATUS_ORDER" :key="s">
          <i :style="{ background: ROOM_STATUS_CONFIG[s].color }"></i>
          {{ ROOM_STATUS_CONFIG[s].label }}
        </span>
      </div>
    </div>

    <!-- 房间详情面板（仅房间模式）：锚定在被点击的房间格子旁 -->
    <div
      v-if="selectedRoom && viewMode === 'room'"
      ref="roomDetailEl"
      class="room-detail"
      :style="roomDetailPos"
    >
      <div class="room-detail__head">
        <strong>房间 {{ selectedRoom.roomNo }}</strong>
        <span class="room-detail__status" :style="{ color: roomStatusColor(selectedRoom) }">
          {{ roomStatusLabel(selectedRoom) }}
        </span>
        <button class="room-detail__close" aria-label="关闭" @click="selectedRoom = null">×</button>
      </div>
      <dl>
        <div><dt>楼层</dt><dd>{{ selectedRoom.floor }}F</dd></div>
        <div><dt>面积</dt><dd>{{ selectedRoom.area }} ㎡</dd></div>
        <div><dt>使用部门</dt><dd>{{ selectedRoom.department ?? '—' }}</dd></div>
        <div><dt>状态</dt><dd>{{ roomStatusLabel(selectedRoom) }}</dd></div>
      </dl>
      <p v-if="selectedRoom.remark" class="room-detail__desc">{{ selectedRoom.remark }}</p>
    </div>

    <!-- 房屋分配侧边栏 -->
    <AllocationPanel
      v-if="viewMode === 'allocate'"
      :rooms="selectedRooms"
      :total-area="totalArea"
      :submitting="allocating"
      :result-message="allocResultMessage"
      :result-type="allocResultType"
      @close="exitAllocationMode"
      @remove="removeSelectedRoom"
      @confirm="confirmAllocation"
    />

    <!-- 操作提示 -->
    <div class="hint-bar">
      <template v-if="viewMode === 'scene'">点击模型拾取建筑 · 双击进入室内视角 · 悬停显示名称 · 输入搜索定位</template>
      <template v-else-if="viewMode === 'room'">点击房间查看详情 · 切换楼层查看不同布局</template>
      <template v-else>点击房间选中（可跨楼层） · 右侧查看已选与总面积</template>
    </div>

    <!-- 打印/导出对话框 -->
    <ExportDialog v-if="exportOpen" :scene="scene" :title="exportTitle" @close="exportOpen = false" />

    <!-- 室内图纸：查看室内图纸的唯一对接点 -->
    <el-dialog v-model="indoorEmptyVisible" title="室内图纸" width="420px">
      <el-empty description="该楼尚未导入楼层平面图（DXF）" />
      <template #footer>
        <el-button type="primary" @click="openImportFromEmpty">导入图纸</el-button>
      </template>
    </el-dialog>

    <FloorPlan2D
      v-model="floorPlan2DVisible"
      :building-name="floorPlanBuilding"
      :fullscreen="true"
      @request-import="dxfImportVisible = true"
    />
    <DxfImport
      v-model="dxfImportVisible"
      :building-names="buildingNames"
      :default-building="floorPlanBuilding"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import * as THREE from 'three';
import { loadAMap } from '../utils/loadAMap';
import { MapScene, type PickResult, type MeasureResult } from '../core/MapScene';
import { DEFAULT_SCENE_CONFIG, type SceneConfig } from '../config/mapConfig';
import {
  SAMPLE_BUILDING_DATA,
  fetchBuildingData,
  type BuildingDataMap,
  type BuildingProps,
} from '../data/buildingData';
import {
  SAMPLE_ROOM_DATA,
  fetchRoomData,
  ROOM_STATUS_CONFIG,
  ROOM_STATUS_ORDER,
  type Room,
  type RoomDataMap,
} from '../data/roomData';
import ExportDialog from './ExportDialog.vue';
import AllocationPanel from './AllocationPanel.vue';
import DxfImport from './DxfImport.vue';
import FloorPlan2D from './FloorPlan2D.vue';
import { useBuildingStore } from '../stores/building';
import { computeTotalArea, submitAllocation } from '../utils/allocation';

type Status = 'loading-amap' | 'loading-model' | 'ready' | 'error';

const mapContainer = ref<HTMLDivElement | null>(null);
const status = ref<Status>('loading-amap');
const errorMessage = ref('');
const keyConfigured = ref(false);
const modelProgress = ref(-1);

const config: SceneConfig = DEFAULT_SCENE_CONFIG;
// 属性数据源：优先从 GeoJSON / 后端 API 读取，失败则回退到内置示例数据
const buildingData = ref<BuildingDataMap>(SAMPLE_BUILDING_DATA);
const roomData = ref<RoomDataMap>(SAMPLE_ROOM_DATA);

const hovered = ref<PickResult | null>(null);
const selected = ref<PickResult | null>(null);

const viewMode = ref<'scene' | 'room' | 'allocate'>('scene');
const roomBuilding = ref<{ name: string; object: THREE.Object3D } | null>(null);
const roomFloors = ref<number[]>([]);
const currentFloor = ref(1);
const selectedRoom = ref<Room | null>(null);

const isIndoorView = ref(false);
const exportOpen = ref(false);
const detailOpen = ref(false);
const detailTab = ref('基础信息'); // 楼宇详情弹窗当前 Tab（默认「基础信息」）
const imageError = ref(false);

// 房间管理弹窗状态
const roomMgmtOpen = ref(false);

// 楼层平面图（DXF 导入 + 2.5D 查看）——新增 building store（不动原 building store）
const buildingStore = useBuildingStore();
const floorPlan2DVisible = ref(false);
const dxfImportVisible = ref(false);
const indoorEmptyVisible = ref(false);
const floorPlanBuilding = ref('');
const buildingNames = computed(() => Object.keys(buildingData.value));

// 把当前生效的楼栋属性表注入 building store（指纹写回目标）
watch(buildingData, (m) => buildingStore.setBuildingMap(m), { immediate: true });

/** 唯一对接点：点楼弹窗里的【查看室内图纸】
 *  - 已有 Floor 数据 → 打开 2.5D 查看器
 *  - 无数据 → 空态引导，点【导入图纸】打开 DxfImport */
function openIndoorPlan() {
  if (!selected.value?.name) return;
  floorPlanBuilding.value = selected.value.name;
  if (buildingStore.hasFloors(selected.value.name)) {
    floorPlan2DVisible.value = true;
  } else {
    indoorEmptyVisible.value = true;
  }
}

function openImportFromEmpty() {
  if (!selected.value?.name) return;
  floorPlanBuilding.value = selected.value.name;
  indoorEmptyVisible.value = false;
  dxfImportVisible.value = true;
}

// 分配模式状态
const selectedRooms = ref<Room[]>([]);
const allocating = ref(false);
const allocResultMessage = ref<string | null>(null);
const allocResultType = ref<'success' | 'error' | null>(null);

const searchQuery = ref('');
const searchFocused = ref(false);
const objectList = ref<Array<{ name: string; lngLat: [number, number]; object: THREE.Object3D }>>([]);

let scene: MapScene | null = null;

// 视图 / 量算 UI 状态
const currentView = ref<'2d' | '2.5d' | '3d'>('3d');
const measureActive = ref(false); // 是否正在打点测量中（控制「完成」按钮显隐）
const measureTool = ref<'none' | 'distance' | 'area'>('none'); // 已选中的量算工具（高亮，清除前保持）
const measureResult = ref<MeasureResult | null>(null);

// ---------------------------------------------------------------------------
// 浮层锚定：弹窗显示在被点击的「模型节点」位置，而不是固定右下角
// ---------------------------------------------------------------------------
/** 外层容器（计算边界、做边缘夹紧） */
const shellRef = ref<HTMLDivElement | null>(null);
/** 属性面板 / 房间详情 DOM（用于测量真实尺寸，实现边缘自动翻转） */
const panelEl = ref<HTMLElement | null>(null);
const roomDetailEl = ref<HTMLElement | null>(null);

/** 浮层与节点之间的间距（px），保持「紧挨着节点」的观感 */
const ANCHOR_GAP = 14;
/** 浮层与容器边缘的最小留白（px） */
const EDGE_MARGIN = 12;

/** 容器尺寸（窗口 resize 时刷新） */
const containerSize = ref({ w: 0, h: 0 });

function readContainerSize() {
  const el = shellRef.value;
  containerSize.value = {
    w: el?.clientWidth || window.innerWidth,
    h: el?.clientHeight || window.innerHeight,
  };
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const toStyle = (p: { left: number; top: number }) => ({
  left: `${Math.round(p.left)}px`,
  top: `${Math.round(p.top)}px`,
});

/**
 * 创建「贴着节点显示」的面板定位。
 * 默认显示在节点右下方，空间不足时自动翻到左侧 / 上方，并夹紧在容器内。
 */
function createAnchoredPanel(
  elRef: Ref<HTMLElement | null>,
  anchorRef: Ref<{ x: number; y: number } | null>,
) {
  const size = ref({ w: 300, h: 240 });

  /** 面板内容变化后调用：等 DOM 更新完测量真实尺寸 */
  function measure() {
    readContainerSize();
    nextTick(() => {
      const el = elRef.value;
      if (!el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w && h) size.value = { w, h };
    });
  }

  const style = computed(() => {
    // 容器尺寸兜底：读不到时用视口尺寸，避免算出 (0,0) 导致浮层被夹到页面左上角
    const cw = containerSize.value.w || window.innerWidth;
    const ch = containerSize.value.h || window.innerHeight;
    const a = anchorRef.value;
    const m = EDGE_MARGIN;

    // 无锚点时的兜底：贴右侧居中
    if (!a) {
      return toStyle({
        left: Math.max(m, cw - size.value.w - m),
        top: Math.max(m, (ch - size.value.h) / 2),
      });
    }

    // 默认显示在节点「左上方」，紧挨着节点；
    // 左侧/上方空间不足时翻到节点右侧/下方，再夹紧在容器内。
    let left = a.x - ANCHOR_GAP - size.value.w;
    let top = a.y - ANCHOR_GAP - size.value.h;
    if (left < m) left = a.x + ANCHOR_GAP;
    if (top < m) top = a.y + ANCHOR_GAP;

    return toStyle({
      left: clamp(left, m, Math.max(m, cw - size.value.w - m)),
      top: clamp(top, m, Math.max(m, ch - size.value.h - m)),
    });
  });

  return { style, measure };
}

/** 被点击节点在容器内的像素坐标（面板 / 房间详情各一份） */
const panelAnchor = ref<{ x: number; y: number } | null>(null);
const roomAnchor = ref<{ x: number; y: number } | null>(null);

const panel = createAnchoredPanel(panelEl, panelAnchor);
const panelPos = panel.style;
const roomDetail = createAnchoredPanel(roomDetailEl, roomAnchor);
const roomDetailPos = roomDetail.style;

/** 锚点标记：指示浮层指向的模型节点 */
const anchorDot = computed(() => {
  if (selected.value && viewMode.value === 'scene') return panelAnchor.value;
  if (selectedRoom.value && viewMode.value === 'room') return roomAnchor.value;
  return null;
});

/** 悬停 tooltip 位置（贴光标，靠近边缘时自动翻转） */
const tooltipStyle = computed(() => {
  const h = hovered.value;
  if (!h) return {};
  const { w: cw, h: ch } = containerSize.value;
  // 粗略估算气泡尺寸（中文约 13px/字），用于判断是否需要翻转
  const estW = Math.min(280, (h.name.length + 6) * 13);
  const estH = 30;
  const flipX = h.screenX + 14 + estW > cw;
  const flipY = h.screenY + 14 + estH > ch;
  return {
    left: `${h.screenX + (flipX ? -14 : 14)}px`,
    top: `${h.screenY + (flipY ? -14 : 14)}px`,
    transform: `translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})`,
  };
});

/** 视角变化（拖拽/缩放/旋转/飞行）后重新投影锚点，让浮层跟随节点 */
function updateAnchors() {
  if (!scene) return;
  if (selected.value) {
    const pos = scene.projectToScreen(selected.value.point);
    if (pos) panelAnchor.value = pos;
  }
  if (selectedRoom.value) {
    const pos = scene.getRoomScreenPos(selectedRoom.value.id);
    if (pos) roomAnchor.value = pos;
  }
}

function onWindowResize() {
  readContainerSize();
  updateAnchors();
}

/** 开发态诊断：输出锚点与容器尺寸，便于排查浮层定位问题（生产构建不输出） */
function debugAnchor(label: string) {
  if (!import.meta.env.DEV) return;
  console.debug(
    `[浮层锚定] ${label}`,
    '节点屏幕坐标 =',
    panelAnchor.value ?? roomAnchor.value,
    '容器尺寸 =',
    containerSize.value,
  );
}

/** 容器尺寸变化监听（窗口 resize + 布局变化都覆盖） */
let shellObserver: ResizeObserver | null = null;

function observeContainer() {
  readContainerSize();
  window.addEventListener('resize', onWindowResize);
  if (typeof ResizeObserver !== 'undefined' && shellRef.value) {
    shellObserver = new ResizeObserver(() => {
      readContainerSize();
      updateAnchors();
    });
    shellObserver.observe(shellRef.value);
  }
}

function unobserveContainer() {
  window.removeEventListener('resize', onWindowResize);
  shellObserver?.disconnect();
  shellObserver = null;
}

const filteredObjects = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return [];
  return objectList.value.filter((o) => o.name.toLowerCase().includes(q)).slice(0, 10);
});

const selectedProps = computed<BuildingProps>(() => {
  if (!selected.value) return { name: '' };
  const base = buildingData.value[selected.value.name];
  const height = base?.height ?? estimateHeight(selected.value.target);
  // 总层数 / 房间数：优先取属性数据，缺失时从房间数据回推
  const rooms = roomsOf(selected.value.name);
  const totalFloors = base?.totalFloors ?? (rooms.length ? Math.max(...rooms.map((r) => r.floor)) : undefined);
  const roomCount = base?.roomCount ?? (rooms.length ? rooms.length : undefined);
  return { ...(base ?? {}), name: selected.value.name, height, totalFloors, roomCount };
});

const categoryLabel = (c?: string) =>
  ({ building: '建筑', road: '道路', water: '水系', other: '其他' } as Record<string, string>)[c ?? 'other'] ?? '其他';

/**
 * 按建筑名查找房间列表（容错版）。
 * 兼容：精确匹配 → 去空格匹配 → 大小写不敏感匹配 → 包含关系模糊匹配
 * （例如模型节点名 "一号教学楼" / "教学大楼" / "TeachingBuilding" 也能命中数据主键 "教学楼"）。
 */
function roomsOf(name?: string): Room[] {
  if (!name) return [];
  const key = String(name).trim();
  if (roomData.value[key]) return roomData.value[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(roomData.value)) {
    const kl = k.toLowerCase();
    if (kl === lower) return roomData.value[k];
    if (kl.includes(lower) || lower.includes(kl)) return roomData.value[k];
  }
  return [];
}

const roomStatusLabel = (room?: Room): string =>
  room ? (ROOM_STATUS_CONFIG[room.status]?.label ?? '') : '';

const roomStatusColor = (room?: Room): string =>
  room ? (ROOM_STATUS_CONFIG[room.status]?.color ?? '#888') : '#888';

function estimateHeight(obj: THREE.Object3D): string {
  const box = new THREE.Box3().setFromObject(obj);
  // 地图 customCoords 空间为 Z-up，建筑高度取 Z 轴方向跨度
  const h = box.max.z - box.min.z;
  if (h > 0) return `${h.toFixed(1)} m`;
  return '';
}

function closePanel() {
  selected.value = null;
  panelAnchor.value = null;
  detailOpen.value = false;
  imageError.value = false;
  roomMgmtOpen.value = false; // 关闭属性面板时一并关闭房间管理面板
  scene?.clearHighlight();
}

function flyToSelected() {
  if (selected.value) scene?.flyToObject(selected.value.target);
}

function openBuildingDetail() {
  detailTab.value = '基础信息'; // 默认展示「基础信息」
  detailOpen.value = true;
}

// ---------------------------------------------------------------------------
// 房间管理弹窗：按楼层展示房间号与状态（使用中 / 无权限 / 空置）
// ---------------------------------------------------------------------------
/** 当前选中楼栋的全部房间 */
const roomMgmtAllRooms = computed<Room[]>(() => {
  return roomsOf(selectedProps.value.name);
});

/** 该楼栋涉及的所有楼层（升序） */
const roomMgmtFloors = computed<number[]>(() => {
  const set = new Set(roomMgmtAllRooms.value.map((r) => r.floor));
  return [...set].sort((a, b) => a - b);
});

/** 三种状态的数量汇总 */
const roomMgmtCounts = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = { occupied: 0, noaccess: 0, vacant: 0 };
  for (const r of roomMgmtAllRooms.value) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
});

/** 按楼层分组（升序），每层包含按房间号排序的房间，用于一次性展示全部楼层 */
const roomMgmtByFloor = computed<{ floor: number; rooms: Room[] }[]>(() => {
  return roomMgmtFloors.value.map((f) => ({
    floor: f,
    rooms: roomMgmtAllRooms.value
      .filter((r) => r.floor === f)
      .sort((a, b) => a.roomNo.localeCompare(b.roomNo, undefined, { numeric: true })),
  }));
});

function openRoomManagement() {
  roomMgmtOpen.value = true;
}

// ---------------------------------------------------------------------------
// 楼宇详情 Tab：基础信息 / 附件信息 / 资产信息 / 楼栋资产 / 楼层信息 / 变更记录
// ---------------------------------------------------------------------------
const detailTabs = ['基础信息', '附件信息', '资产信息', '楼栋资产', '楼层信息', '变更记录'] as const;

interface AttachmentItem {
  name: string;
  type: 'img' | 'doc';
  typeLabel: string;
  size: string;
  time: string;
  sample: boolean;
}

/** 附件信息：含楼宇实景图（真实）与若干示例文档 */
const attachmentList = computed<AttachmentItem[]>(() => {
  const p = selectedProps.value;
  const list: AttachmentItem[] = [];
  if (p.image) {
    list.push({ name: `${p.name} 实景图.jpg`, type: 'img', typeLabel: '图片', size: '1.2 MB', time: '2025-03-12', sample: false });
  }
  list.push(
    { name: `${p.name} 建筑平面图.dwg`, type: 'doc', typeLabel: 'CAD 图纸', size: '3.4 MB', time: '2024-11-08', sample: true },
    { name: `${p.name} 竣工验收备案表.pdf`, type: 'doc', typeLabel: '文档', size: '860 KB', time: '2024-09-20', sample: true },
    { name: `${p.name} 资产清查表.xlsx`, type: 'doc', typeLabel: '表格', size: '210 KB', time: '2025-06-01', sample: true },
  );
  return list;
});

/** 资产信息：按建筑面积测算的示例资产卡片 */
const assetSummary = computed(() => {
  const p = selectedProps.value;
  const area = Number(p.buildingArea) || 0;
  const unitPrice = 8000; // 元/㎡（示例）
  const original = area * unitPrice;
  const codeSeed = p.name ? [...p.name].reduce((s, c) => s + c.charCodeAt(0), 0) : 0;
  return {
    code: 'GD-' + String(codeSeed).padStart(6, '0'),
    category: '房屋构筑物',
    original,
    net: Math.round(original * 0.82),
    life: 50,
    status: '在用',
  };
});

/** 楼栋资产：按大类拆分（示例测算） */
const buildingAssetRows = computed(() => {
  const total = assetSummary.value.original || 1;
  const cats = [
    { name: '房屋建筑物', ratio: 0.86 },
    { name: '通用设备', ratio: 0.07 },
    { name: '专用设备', ratio: 0.05 },
    { name: '家具用具', ratio: 0.02 },
  ];
  return cats.map((c) => ({
    name: c.name,
    amount: Math.round(total * c.ratio),
    percent: Math.round(c.ratio * 100),
  }));
});

interface FloorRow {
  floor: number;
  area: number;
  rooms: number;
  use: string;
}

/** 楼层信息：优先聚合房间数据，否则按总层数均匀拆分 */
const floorRows = computed<FloorRow[]>(() => {
  const p = selectedProps.value;
  const rooms = roomsOf(p.name);
  if (rooms.length) {
    const byFloor = new Map<number, Room[]>();
    for (const r of rooms) {
      if (!byFloor.has(r.floor)) byFloor.set(r.floor, []);
      byFloor.get(r.floor)!.push(r);
    }
    return [...byFloor.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([floor, rs]) => ({
        floor,
        area: Math.round(rs.reduce((s, r) => s + (Number(r.area) || 0), 0)),
        rooms: rs.length,
        use: rs[0]?.purpose ?? '—',
      }));
  }
  const total = p.totalFloors;
  if (!total) return [];
  const areaPer = Math.round((Number(p.buildingArea) || 0) / total);
  const roomsPer = Math.round((Number(p.roomCount) || 0) / total);
  return Array.from({ length: total }, (_, i) => ({ floor: i + 1, area: areaPer, rooms: roomsPer, use: '教学/办公' }));
});

/** 变更记录（示例） */
const changeRecords = computed(() => [
  { date: '2024-09-20', type: '竣工验收', desc: `${selectedProps.value.name} 通过竣工验收并交付使用。`, by: '基建处' },
  { date: '2024-11-08', type: '资产入账', desc: '完成固定资产入账，建立楼宇资产卡片。', by: '资产处' },
  { date: '2025-03-12', type: '维修改造', desc: '外立面及屋面防水维修改造。', by: '后勤处' },
  { date: '2025-06-01', type: '用途调整', desc: '部分楼层用途由办公调整为实训教室。', by: '教务处' },
]);

function downloadStub(a: AttachmentItem) {
  if (a.type === 'img') {
    const img = selectedProps.value.image;
    if (img) window.open(img, '_blank');
  }
  // 示例文档暂无真实文件，仅对真实图片开放预览
}

// ---------------------------------------------------------------------------
// 楼盘表模式
// ---------------------------------------------------------------------------
function enterRoomMode() {
  if (!selected.value || selected.value.isRoom) return;
  const { name, target } = selected.value;
  const rooms = roomsOf(name);
  scene?.showRooms(target, rooms);
  roomBuilding.value = { name, object: target };
  roomFloors.value = scene?.getRoomFloors() ?? [];
  currentFloor.value = roomFloors.value[0] ?? 1;
  selectedRoom.value = null;
  selected.value = null;
  scene?.clearHighlight();
  viewMode.value = 'room';
}

function exitRoomMode() {
  scene?.clearRooms();
  scene?.highlightRoom(null, 0);
  viewMode.value = 'scene';
  roomBuilding.value = null;
  roomFloors.value = [];
  selectedRoom.value = null;
}

function switchFloor(floor: number) {
  currentFloor.value = floor;
  scene?.setRoomFloor(floor);
  if (viewMode.value === 'allocate') {
    // 分配模式：保留已选房间的高亮
    scene?.setSelectedRooms(new Set(selectedRooms.value.map((r) => r.id)));
  } else {
    selectedRoom.value = null;
    scene?.highlightRoom(null, 0);
  }
}

// ---------------------------------------------------------------------------
// 室内视角 & 导出
// ---------------------------------------------------------------------------
const exportTitle = computed(() => {
  if (viewMode.value === 'room' && roomBuilding.value) {
    return `${roomBuilding.value.name}-${currentFloor.value}F楼盘表`;
  }
  return '海南警察学院-3D场景';
});

function handleDoubleClick(result: PickResult | null) {
  // 双击建筑进入室内视角（忽略房间格子/空白）
  if (!result || result.isRoom) return;
  selected.value = null;
  scene?.clearHighlight();
  scene?.enterIndoorView(result.target);
  isIndoorView.value = true;
}

function handleEscKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (measureTool.value !== 'none' || measureResult.value) {
      stopMeasure();
      return;
    }
    if (isIndoorView.value) {
      scene?.exitIndoorView();
      isIndoorView.value = false;
    } else if (viewMode.value === 'allocate') {
      exitAllocationMode();
    } else if (exportOpen.value) {
      exportOpen.value = false;
    } else if (detailOpen.value) {
      detailOpen.value = false;
    }
  }
}

// ---------------------------------------------------------------------------
// 视图切换 & 量算
// ---------------------------------------------------------------------------
function setView(mode: '2d' | '2.5d' | '3d') {
  currentView.value = mode;
  isIndoorView.value = false;
  scene?.setMapView(mode); // 内部会处理退出室内；中心/缩放保持不变（定位不丢失）
}

function toggleIndoor() {
  if (isIndoorView.value) {
    scene?.exitIndoorView();
    isIndoorView.value = false;
    currentView.value = '3d';
    return;
  }
  let target: THREE.Object3D | null =
    selected.value && !selected.value.isRoom ? (selected.value.target as THREE.Object3D) : null;
  if (!target && objectList.value.length) target = objectList.value[0].object;
  if (!target) {
    window.alert('请先在场景中点击选中一栋建筑，再进入室内视角');
    return;
  }
  scene?.enterIndoorView(target);
  isIndoorView.value = true;
}

function startMeasure(mode: 'distance' | 'area') {
  measureTool.value = mode; // 高亮保持，直到点击「清除」
  scene?.startMeasure(mode);
}

function completeMeasure() {
  scene?.completeMeasure(); // 结束本次测量，但保持工具高亮（measureTool 不变）
}

function stopMeasure() {
  measureTool.value = 'none';
  scene?.stopMeasure();
}

function formatMeters(m: number): string {
  if (!isFinite(m)) return '0.0 m';
  return `${m.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} m`;
}

function formatArea(s: number): string {
  if (!isFinite(s)) return '0.0 ㎡';
  return `${s.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ㎡`;
}

// ---------------------------------------------------------------------------
// 分配模式
// ---------------------------------------------------------------------------
const totalArea = computed(() => computeTotalArea(selectedRooms.value));

function enterAllocationMode() {
  if (viewMode.value !== 'room' || !roomBuilding.value) return;
  viewMode.value = 'allocate';
  selectedRoom.value = null;
  selectedRooms.value = [];
  allocResultMessage.value = null;
  allocResultType.value = null;
  scene?.setSelectedRooms(new Set());
}

function exitAllocationMode() {
  viewMode.value = 'room';
  selectedRooms.value = [];
  allocResultMessage.value = null;
  allocResultType.value = null;
  scene?.setSelectedRooms(new Set());
}

function toggleRoomSelection(room: Room) {
  const idx = selectedRooms.value.findIndex((r) => r.id === room.id);
  if (idx >= 0) selectedRooms.value.splice(idx, 1);
  else selectedRooms.value.push(room);
  scene?.setSelectedRooms(new Set(selectedRooms.value.map((r) => r.id)));
}

function removeSelectedRoom(roomId: string) {
  selectedRooms.value = selectedRooms.value.filter((r) => r.id !== roomId);
  scene?.setSelectedRooms(new Set(selectedRooms.value.map((r) => r.id)));
}

async function confirmAllocation(payload: { requestedArea: number; applicant: string }) {
  allocating.value = true;
  allocResultMessage.value = null;
  try {
    const result = await submitAllocation(
      {
        roomIds: selectedRooms.value.map((r) => r.id),
        roomNos: selectedRooms.value.map((r) => r.roomNo),
        totalArea: totalArea.value,
        requestedArea: payload.requestedArea,
        applicant: payload.applicant || undefined,
      },
      config.allocationApiUrl,
    );
    allocResultType.value = result.success ? 'success' : 'error';
    allocResultMessage.value = result.message;

    if (result.success) {
      // 本地更新房间状态为「占用」并刷新格子颜色
      for (const room of selectedRooms.value) {
        room.status = 'occupied';
        scene?.updateRoomStatus(room.id, 'occupied');
      }
      selectedRooms.value = [];
      scene?.setSelectedRooms(new Set());
    }
  } finally {
    allocating.value = false;
  }
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------
function selectByName(name: string) {
  if (viewMode.value === 'allocate') exitAllocationMode();
  if (viewMode.value === 'room') exitRoomMode();
  const found = objectList.value.find((o) => o.name === name);
  if (!found) return;
  searchQuery.value = name;
  searchFocused.value = false;
  scene?.flyToObject(found.object);
  const wp = new THREE.Vector3();
  found.object.getWorldPosition(wp);
  const result: PickResult = {
    object: found.object,
    target: found.object,
    name: found.name,
    point: wp,
    lngLat: found.lngLat,
    screenX: 0,
    screenY: 0,
    isRoom: false,
  };
  selected.value = result;
  detailOpen.value = false;
  imageError.value = false;
  panelAnchor.value =
    scene?.projectToScreen(wp) ?? {
      x: containerSize.value.w / 2,
      y: containerSize.value.h / 2,
    };
  panel.measure();
  debugAnchor(`搜索定位「${found.name}」`);
  scene?.highlight(found.object, config.highlightColor);
}

function onSearchInput() {
  // 由 computed 自动过滤
}

function onSearchEnter() {
  if (filteredObjects.value.length) selectByName(filteredObjects.value[0].name);
}

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------
async function loadBuildingData(): Promise<void> {
  const url = config.dataUrl;
  if (!url) return;
  try {
    buildingData.value = await fetchBuildingData(url);
  } catch (err) {
    console.warn('[建筑数据] 加载失败，回退示例数据：', err);
  }
}

async function loadRoomData(): Promise<void> {
  const url = config.roomDataUrl;
  if (!url) return;
  try {
    const fetched = await fetchRoomData(url);
    // 以示例数据为兜底底座，再叠加真实数据：保证任何楼栋都不会因单条数据缺失而空白
    roomData.value = { ...SAMPLE_ROOM_DATA, ...fetched };
  } catch (err) {
    console.warn('[房间数据] 加载失败，回退示例数据：', err);
    roomData.value = SAMPLE_ROOM_DATA;
  }
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
onMounted(async () => {
  // 浮层定位依赖容器尺寸，必须尽早读取（否则尺寸为 0 会把弹窗夹到页面左上角）
  observeContainer();

  // 并行加载建筑/房间属性数据（不阻塞地图初始化）
  loadBuildingData();
  loadRoomData();

  window.addEventListener('keydown', handleEscKey);

  const key = import.meta.env.VITE_AMAP_KEY;
  const securityCode = import.meta.env.VITE_AMAP_SECURITY_CODE;

  if (!key || key.includes('填写')) {
    status.value = 'error';
    keyConfigured.value = false;
    errorMessage.value = '未配置高德地图 key';
    return;
  }
  keyConfigured.value = true;

  try {
    status.value = 'loading-amap';
    const AMap = await loadAMap({ key, securityJsCode: securityCode });

    if (!mapContainer.value) return;
    scene = new MapScene(mapContainer.value, config, {
      onModelProgress: (p) => (modelProgress.value = p),
      onModelReady: () => {
        status.value = 'ready';
        objectList.value = scene?.listObjects() ?? [];
      },
      onModelError: () => {
        status.value = 'error';
        errorMessage.value = `GLB 模型加载失败：${config.modelUrl}`;
      },
      onMapError: (err) => {
        status.value = 'error';
        errorMessage.value = `地图初始化失败：${String(err)}`;
      },
      onHover: (result) => {
        hovered.value = result;
        if (viewMode.value === 'allocate') return; // 分配模式仅显示 tooltip
        if (viewMode.value === 'room') {
          // 房间模式：悬停房间格子
          if (result?.isRoom && result.room) scene?.highlightRoom(result.room.id, 0.5);
          else scene?.highlightRoom(null, 0);
          return;
        }
        // 场景模式：悬停建筑（未选中时才应用）
        if (!selected.value) {
          if (result && !result.isRoom) scene?.highlight(result.target, config.hoverColor);
          else scene?.clearHighlight();
        }
      },
      onSelect: (result) => {
        if (viewMode.value === 'allocate') {
          // 分配模式：点击房间切换选中（跨楼层）
          if (result?.isRoom && result.room) toggleRoomSelection(result.room);
          return;
        }
        if (viewMode.value === 'room') {
          // 房间模式：点击房间 → 详情（浮层锚定到该房间格子）
          if (result?.isRoom && result.room) {
            selectedRoom.value = result.room;
            roomAnchor.value =
              scene?.getRoomScreenPos(result.room.id) ?? { x: result.screenX, y: result.screenY };
            roomDetail.measure();
            scene?.highlightRoom(result.room.id, 0.7);
          } else {
            selectedRoom.value = null;
            roomAnchor.value = null;
            scene?.highlightRoom(null, 0);
          }
          return;
        }
        // 场景模式：点击建筑 → 属性面板（浮层锚定到点击的节点位置）
        if (result && !result.isRoom) {
          selected.value = result;
          detailOpen.value = false;
          imageError.value = false;
          // 切换/点击建筑时，关闭可能残留的房间管理面板（避免与属性面板同时出现）
          roomMgmtOpen.value = false;
          panelAnchor.value =
            scene?.projectToScreen(result.point) ?? { x: result.screenX, y: result.screenY };
          panel.measure();
          debugAnchor(`点击「${result.name}」`);
          scene?.highlight(result.target, config.highlightColor);
        } else {
          selected.value = null;
          panelAnchor.value = null;
          scene?.clearHighlight();
        }
      },
      onDoubleClick: (result) => handleDoubleClick(result),
      // 量算结果回调：null 表示清除；finished（measuringMode==='none'）时仅保留结果、取消按钮高亮
      onMeasureUpdate: (data) => {
        measureResult.value = data;
      },
      onMeasureActive: (active: boolean) => {
        measureActive.value = active;
      },
      // 地图平移/缩放/旋转/飞行时，让锚定浮层跟随节点
      onViewChange: () => updateAnchors(),
    });

    status.value = 'loading-model';
    scene.init(AMap);
  } catch (err) {
    status.value = 'error';
    errorMessage.value = `初始化失败：${(err as Error).message}`;
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleEscKey);
  unobserveContainer();
  scene?.destroy();
  scene = null;
});
</script>

<style scoped>
.scene-shell {
  position: relative;
  width: 100%;
  height: 100dvh;
  min-height: 480px;
  overflow: hidden;
  background: #0e1420;
}

.scene-map { position: absolute; inset: 0; }

.scene-overlay {
  position: absolute;
  z-index: 300;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #dce6f5;
  background: rgba(14, 20, 32, 0.82);
  backdrop-filter: blur(6px);
}
.scene-overlay strong { font-size: 15px; font-weight: 500; }
.scene-overlay .err { color: #f87171; }
.scene-overlay small { color: #8a97ad; font-size: 12px; }

.err-hint {
  max-width: 420px;
  padding: 12px 16px;
  border: 1px solid #33415c;
  border-radius: 6px;
  color: #a7b4c8;
  background: rgba(20, 27, 43, 0.6);
  font-size: 12px;
  line-height: 1.9;
  text-align: left;
}
.err-hint code {
  padding: 1px 6px;
  border-radius: 3px;
  color: #eaf2ff;
  background: #1a2335;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.spinner {
  width: 30px;
  height: 30px;
  border: 2px solid #24324a;
  border-top-color: #38bdf8;
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.scene-badge {
  position: absolute;
  z-index: 120;
  top: 16px;
  left: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid #24324a;
  border-radius: 4px;
  color: #c3d0e5;
  background: rgba(20, 27, 43, 0.88);
  font-size: 12px;
  backdrop-filter: blur(8px);
  pointer-events: none;
}

.badge-light, .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #34d399;
  box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.15);
}

/* 工具栏 */
.toolbar {
  position: absolute;
  z-index: 120;
  top: 16px;
  right: 16px;
}
.toolbar__btn {
  height: 34px;
  padding: 0 14px;
  border: 1px solid #33415c;
  border-radius: 6px;
  color: #c3d0e5;
  background: rgba(20, 27, 43, 0.9);
  font-size: 13px;
  cursor: pointer;
  backdrop-filter: blur(8px);
}
.toolbar__btn:hover { border-color: #38bdf8; color: #eaf2ff; }

/* 室内视角提示 */
.indoor-badge {
  position: absolute;
  z-index: 120;
  top: 60px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 14px;
  border: 1px solid #f59e0b;
  border-radius: 20px;
  color: #ffe7c2;
  background: rgba(20, 27, 43, 0.9);
  font-size: 12px;
  pointer-events: none;
  backdrop-filter: blur(8px);
}
.indoor-badge__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #f59e0b;
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.15);
}

/* 搜索框 */
.search-box {
  position: absolute;
  z-index: 140;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  width: 320px;
  max-width: calc(100% - 200px);
}
.search-box input {
  width: 100%;
  height: 38px;
  padding: 0 14px;
  border: 1px solid #24324a;
  border-radius: 6px;
  color: #dce6f5;
  background: rgba(20, 27, 43, 0.92);
  font-size: 13px;
  outline: none;
  backdrop-filter: blur(8px);
  transition: border-color 0.15s ease;
}
.search-box input:focus { border-color: #38bdf8; }
.search-box input::placeholder { color: #6b7890; }

.search-dropdown {
  position: absolute;
  top: 44px;
  left: 0;
  right: 0;
  margin: 0;
  padding: 4px;
  list-style: none;
  border: 1px solid #24324a;
  border-radius: 6px;
  background: rgba(20, 27, 43, 0.97);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(10px);
  max-height: 280px;
  overflow-y: auto;
}
.search-dropdown li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  color: #dce6f5;
}
.search-dropdown li:hover { background: #22314a; }
.search-dropdown__coord { color: #6b7890; font-size: 11px; font-family: ui-monospace, monospace; }

/* tooltip */
.tooltip {
  position: absolute;
  z-index: 150;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid #38bdf8;
  border-radius: 4px;
  color: #e6f4ff;
  background: rgba(13, 22, 38, 0.94);
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
}
.tooltip__status { font-size: 11px; }

/* 节点锚点标记：指示浮层指向的模型节点 */
.anchor-dot {
  position: absolute;
  z-index: 125;
  width: 10px;
  height: 10px;
  margin: -5px 0 0 -5px;
  border: 2px solid #38bdf8;
  border-radius: 50%;
  background: rgba(56, 189, 248, 0.28);
  pointer-events: none;
  animation: anchor-pulse 1.8s ease-out infinite;
}
@keyframes anchor-pulse {
  0% { box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.3); }
  70% { box-shadow: 0 0 0 11px rgba(56, 189, 248, 0); }
  100% { box-shadow: 0 0 0 11px rgba(56, 189, 248, 0); }
}

/* 属性面板（位置由 JS 按被点击节点动态计算） */
.property-panel {
  position: absolute;
  z-index: 130;
  width: 300px;
  max-width: calc(100% - 24px);
  border: 1px solid #d8dee8;
  border-radius: 8px;
  background: #f6f8fb;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}
.property-panel__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid #e1e6ee;
  color: #1f2a3a;
}
.property-panel__head strong { flex: 1; font-size: 15px; font-weight: 600; }
.property-panel__close {
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 4px;
  color: #8a97ad;
  background: transparent;
  font-size: 18px;
  cursor: pointer;
}
.property-panel__close:hover { color: #f87171; background: #22314a; }
/* 浅色面板内的关闭按钮（深色，保证在浅底上可见） */
.property-panel .property-panel__close { color: #5a6678; }
.property-panel .property-panel__close:hover { color: #c0392b; background: #e9edf3; }

.property-panel dl { margin: 0; padding: 6px 14px 12px; }
.property-panel dl div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  font-size: 13px;
  border-bottom: 1px dashed #e6eaf0;
}
.property-panel dl div:last-child { border-bottom: 0; }
.property-panel dt { color: #5a6678; }
.property-panel dd {
  margin: 0;
  color: #1f2a3a;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  text-align: right;
}
.property-panel__desc {
  margin: 0;
  padding: 0 14px 14px;
  color: #3a4456;
  font-size: 12px;
  line-height: 1.7;
}
.property-panel__locate {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 4px;
  color: #0b6fb8;
  background: transparent;
  cursor: pointer;
}
.property-panel__locate:hover { background: rgba(11, 111, 184, 0.12); }

/* 楼宇图片 */
.property-panel__image {
  position: relative;
  height: 140px;
  border-bottom: 1px solid #e1e6ee;
  background: #eef1f5;
  overflow: hidden;
}
.property-panel__image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.property-panel__image-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 100%;
  color: #8a93a3;
  background: linear-gradient(135deg, #f0f3f7 0%, #e6eaf0 100%);
}
.property-panel__image-placeholder span { font-size: 13px; color: #9aa3b2; }

.property-panel__actions {
  display: flex;
  gap: 8px;
  padding: 12px 14px 14px;
  border-top: 1px solid #e1e6ee;
}
.property-panel__btn {
  flex: 1;
  height: 32px;
  border: 1px solid #c3ccda;
  border-radius: 6px;
  color: #2a3445;
  background: rgba(0, 0, 0, 0.03);
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
}
.property-panel__btn:hover { border-color: #0b6fb8; color: #0b4f8a; background: rgba(11, 111, 184, 0.08); }
.property-panel__btn--primary {
  border-color: #0b6fb8;
  color: #0b4f8a;
  background: rgba(11, 111, 184, 0.12);
}
.property-panel__btn--primary:hover { background: rgba(11, 111, 184, 0.2); }

/* 楼宇详情弹窗 */
.detail-modal {
  position: absolute;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(6, 10, 20, 0.55);
  backdrop-filter: blur(3px);
}
.detail-modal__card {
  width: 50vw;
  max-width: 50vw;
  height: 80vh;
  max-height: 80vh;
  overflow-y: auto;
  border: 1px solid #24324a;
  border-radius: 10px;
  background: rgba(20, 27, 43, 0.98);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
}
.detail-modal__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid #24324a;
  color: #eaf2ff;
}
.detail-modal__head strong { flex: 1; font-size: 15px; font-weight: 600; }
.detail-modal__image {
  height: 200px;
  border-bottom: 1px solid #24324a;
  background: #141c2e;
  overflow: hidden;
}
.detail-modal__image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.detail-modal__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 20px;
  margin: 0;
  padding: 10px 16px 12px;
}
.detail-modal__grid div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 0;
  font-size: 13px;
  border-bottom: 1px dashed #1e2a40;
}
.detail-modal__grid dt { color: #8a97ad; white-space: nowrap; }
.detail-modal__grid dd {
  margin: 0;
  color: #eaf2ff;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-modal__desc {
  margin: 0;
  padding: 4px 16px 16px;
  color: #a7b4c8;
  font-size: 12px;
  line-height: 1.7;
}

/* 楼宇详情 Tab */
.detail-modal__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px 12px 0;
  border-bottom: 1px solid #24324a;
  position: sticky;
  top: 0;
  background: rgba(20, 27, 43, 0.98);
  z-index: 2;
}
.detail-tab {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: #9fb0c9;
  font-size: 12.5px;
  padding: 7px 11px;
  border-radius: 7px 7px 0 0;
  cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}
.detail-tab:hover { color: #eaf2ff; background: rgba(56, 189, 248, 0.08); }
.detail-tab.active {
  color: #eaf2ff;
  background: rgba(56, 189, 248, 0.14);
  border-color: #24324a;
  border-bottom-color: transparent;
  font-weight: 600;
}
.detail-modal__body { padding: 0 0 8px; }
.detail-tabpane { padding-top: 4px; }

/* 房间管理面板：右侧停靠，宽 20%，无遮罩层 */
.room-mgmt-modal {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 30vw;
  z-index: 210;
  display: block;
}
.room-mgmt__card {
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  display: flex;
  flex-direction: column;
  border: 1px solid #e3d9c4;
  border-right: none;
  border-radius: 0;
  background: #f7f2e7;
  box-shadow: -8px 0 30px rgba(0, 0, 0, 0.18);
}
.room-mgmt__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid #e3d9c4;
  color: #2a241a;
  position: sticky;
  top: 0;
  background: #f7f2e7;
  z-index: 2;
}
.room-mgmt__head strong { flex: 1; font-size: 15px; font-weight: 600; }
/* 米色面板内的关闭按钮（深色，保证在米底上可见） */
.room-mgmt__head .property-panel__close { color: #6b5d44; }
.room-mgmt__head .property-panel__close:hover { color: #c0392b; background: #ece2cf; }
.room-mgmt__summary {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid #e3d9c4;
}
.room-mgmt__pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid #e3d9c4;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.03);
  color: #4a4436;
  font-size: 13px;
}
.room-mgmt__pill i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.room-mgmt__pill b { color: var(--c); font-size: 14px; }
.room-mgmt__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 0 18px;
}
.room-mgmt__floor-section {
  border-bottom: 1px dashed #a8714a;
  padding: 12px 16px 14px;
}
.room-mgmt__floor-section:last-child { border-bottom: none; }
.room-mgmt__floor-title {
  font-size: 14px;
  font-weight: 700;
  color: #8b5a2b;
  margin-bottom: 10px;
  letter-spacing: 0.5px;
}
.room-mgmt__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 10px;
  align-content: start;
}
.room-mgmt__cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 14px 6px;
  border: 1px solid #e3d9c4;
  border-left: 5px solid var(--c);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.03);
  background: color-mix(in srgb, var(--c) 18%, #f3ecdb);
  cursor: default;
  transition: transform 0.12s, background 0.12s, border-color 0.12s;
}
.room-mgmt__cell:hover {
  transform: translateY(-2px);
  background: color-mix(in srgb, var(--c) 28%, #f3ecdb);
}
.room-mgmt__no { font-size: 16px; font-weight: 700; color: #2a241a; letter-spacing: 0.5px; }


/* 附件信息 */
.attach-list { list-style: none; margin: 0; padding: 8px 12px; display: flex; flex-direction: column; gap: 8px; }
.attach-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid #24324a;
  border-radius: 8px;
  background: rgba(14, 20, 34, 0.5);
}
.attach-icon {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  background: #3a4a66;
}
.attach-icon--img { background: #1d7a5a; }
.attach-meta { flex: 1; min-width: 0; }
.attach-name { color: #eaf2ff; font-size: 13px; display: flex; align-items: center; gap: 6px; }
.attach-sub { color: #8a97ad; font-size: 11px; margin-top: 2px; }
.tag-sample {
  font-style: normal;
  font-size: 10px;
  color: #f0b429;
  border: 1px solid #5a4a1e;
  background: rgba(240, 180, 41, 0.12);
  border-radius: 4px;
  padding: 0 5px;
}
.attach-dl {
  flex: none;
  appearance: none;
  border: 1px solid #2c3c58;
  background: transparent;
  color: #9fc6ff;
  font-size: 12px;
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.attach-dl:hover { border-color: #38bdf8; color: #38bdf8; }

/* 资产信息卡片 */
.asset-summary {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 16px;
  padding: 12px 16px;
}
.asset-summary > div {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 0;
  font-size: 13px;
  border-bottom: 1px dashed #1e2a40;
}
.asset-summary span { color: #8a97ad; white-space: nowrap; }
.asset-summary b { color: #eaf2ff; text-align: right; }

/* 资产 / 楼层表格 */
.asset-table {
  width: calc(100% - 24px);
  margin: 10px 12px;
  border-collapse: collapse;
  font-size: 12.5px;
}
.asset-table th, .asset-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid #1e2a40;
}
.asset-table th { color: #8a97ad; font-weight: 600; }
.asset-table td { color: #eaf2ff; }
.asset-table tbody tr:hover { background: rgba(56, 189, 248, 0.06); }

.tab-note { margin: 4px 16px 14px; color: #7d8aa3; font-size: 11px; line-height: 1.6; }
.tab-empty { margin: 18px 16px; color: #7d8aa3; font-size: 13px; text-align: center; }

/* 变更记录时间线 */
.change-list { list-style: none; margin: 0; padding: 12px 16px; }
.change-item { display: flex; gap: 12px; padding-bottom: 16px; position: relative; }
.change-item:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 14px;
  bottom: 0;
  width: 1px;
  background: #24324a;
}
.change-dot {
  flex: none;
  width: 11px;
  height: 11px;
  margin-top: 3px;
  border-radius: 50%;
  background: #38bdf8;
  box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.18);
  z-index: 1;
}
.change-body { flex: 1; min-width: 0; }
.change-top { display: flex; justify-content: space-between; align-items: baseline; }
.change-top b { color: #eaf2ff; font-size: 13px; }
.change-top span { color: #8a97ad; font-size: 11px; }
.change-desc { color: #a7b4c8; font-size: 12px; line-height: 1.6; margin-top: 3px; }
.change-by { color: #7d8aa3; font-size: 11px; margin-top: 3px; }


/* 楼盘表面板 */
.room-panel {
  position: absolute;
  z-index: 130;
  left: 16px;
  top: 64px;
  width: 220px;
  border: 1px solid #24324a;
  border-radius: 8px;
  background: rgba(20, 27, 43, 0.95);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(12px);
  overflow: hidden;
}
.room-panel__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border-bottom: 1px solid #24324a;
  color: #eaf2ff;
}
.room-panel__head strong { flex: 1; font-size: 14px; font-weight: 600; }
.room-panel__exit {
  height: 26px;
  padding: 0 10px;
  border: 1px solid #f87171;
  border-radius: 4px;
  color: #fca5a5;
  background: transparent;
  font-size: 12px;
  cursor: pointer;
}
.room-panel__exit:hover { background: rgba(248, 113, 113, 0.15); }

.room-panel__alloc {
  height: 26px;
  padding: 0 10px;
  margin-right: 6px;
  border: 1px solid #22d3ee;
  border-radius: 4px;
  color: #a5f3fc;
  background: rgba(34, 211, 238, 0.12);
  font-size: 12px;
  cursor: pointer;
}
.room-panel__alloc:hover { background: rgba(34, 211, 238, 0.24); }

.floor-switch {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 12px 14px 8px;
}
.floor-switch__btn {
  min-width: 40px;
  height: 30px;
  border: 1px solid #33415c;
  border-radius: 4px;
  color: #a7b4c8;
  background: #1a2335;
  font-size: 12px;
  cursor: pointer;
}
.floor-switch__btn:hover { border-color: #38bdf8; color: #eaf2ff; }
.floor-switch__btn.active {
  border-color: #38bdf8;
  color: #0b1220;
  background: #38bdf8;
  font-weight: 600;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 6px 14px 12px;
}
.legend span {
  display: flex;
  align-items: center;
  gap: 5px;
  color: #a7b4c8;
  font-size: 11px;
}
.legend i {
  width: 10px;
  height: 10px;
  border-radius: 2px;
}

/* 房间详情（位置由 JS 按被点击的房间格子动态计算） */
.room-detail {
  position: absolute;
  z-index: 130;
  width: 280px;
  max-width: calc(100% - 24px);
  border: 1px solid #24324a;
  border-radius: 8px;
  background: rgba(20, 27, 43, 0.95);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(12px);
  overflow: hidden;
}
.room-detail__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid #24324a;
  color: #eaf2ff;
}
.room-detail__head strong { flex: 1; font-size: 15px; font-weight: 600; }
.room-detail__status { font-size: 12px; }
.room-detail__close {
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 4px;
  color: #8a97ad;
  background: transparent;
  font-size: 18px;
  cursor: pointer;
}
.room-detail__close:hover { color: #f87171; background: #22314a; }

.room-detail dl { margin: 0; padding: 6px 14px 12px; }
.room-detail dl div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  font-size: 13px;
  border-bottom: 1px dashed #1e2a40;
}
.room-detail dl div:last-child { border-bottom: 0; }
.room-detail dt { color: #8a97ad; }
.room-detail dd {
  margin: 0;
  color: #eaf2ff;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  text-align: right;
}
.room-detail__desc {
  margin: 0;
  padding: 0 14px 14px;
  color: #a7b4c8;
  font-size: 12px;
  line-height: 1.7;
}

.hint-bar {
  position: absolute;
  z-index: 120;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 14px;
  border: 1px solid #24324a;
  border-radius: 20px;
  color: #7d8aa3;
  background: rgba(20, 27, 43, 0.82);
  font-size: 11px;
  pointer-events: none;
  backdrop-filter: blur(8px);
}

/* 工具栏分组 */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  max-width: calc(100% - 32px);
  justify-content: flex-end;
}
.toolbar__group {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border: 1px solid #24324a;
  border-radius: 8px;
  background: rgba(20, 27, 43, 0.9);
  backdrop-filter: blur(8px);
}
.toolbar__label {
  padding: 0 6px 0 4px;
  color: #6b7890;
  font-size: 11px;
  white-space: nowrap;
}
.toolbar__btn {
  height: 30px;
  padding: 0 12px;
  border: 1px solid #33415c;
  border-radius: 6px;
  color: #c3d0e5;
  background: transparent;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.toolbar__btn:hover { border-color: #38bdf8; color: #eaf2ff; }
.toolbar__btn.active {
  border-color: #38bdf8;
  color: #06121f;
  background: #38bdf8;
  font-weight: 600;
}
.toolbar__btn--ghost { border-style: dashed; color: #f87171; }
.toolbar__btn--ghost:hover { border-color: #f87171; background: rgba(248, 113, 113, 0.12); color: #fca5a5; }

/* 量算结果面板 */
.measure-panel {
  position: absolute;
  z-index: 150;
  bottom: 16px;
  right: 16px;
  width: 252px;
  max-width: calc(100% - 32px);
  border: 1px solid #24324a;
  border-radius: 10px;
  background: rgba(20, 27, 43, 0.96);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(12px);
  overflow: hidden;
}
.measure-panel__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid #24324a;
  color: #eaf2ff;
}
.measure-panel__head strong { flex: 1; font-size: 13px; font-weight: 600; }
.measure-panel__close {
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 4px;
  color: #8a97ad;
  background: transparent;
  font-size: 17px;
  cursor: pointer;
}
.measure-panel__close:hover { color: #f87171; background: #22314a; }
.measure-panel__body { padding: 10px 12px; }
.measure-panel__total { font-size: 13px; color: #a7b4c8; }
.measure-panel__total b {
  color: #38bdf8;
  font-size: 16px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.measure-panel--area .measure-panel__total b { color: #f59e0b; }
.measure-panel__segs {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  max-height: 180px;
  overflow-y: auto;
}
.measure-panel__segs li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 5px 8px;
  border-radius: 4px;
  margin-bottom: 4px;
  font-size: 12px;
  color: #c3d0e5;
  background: rgba(56, 189, 248, 0.08);
}
.measure-panel--area .measure-panel__segs li { background: rgba(245, 158, 11, 0.1); }
.measure-panel__segs li span:last-child { font-family: ui-monospace, monospace; color: #eaf2ff; }
.measure-panel__meta { margin-top: 6px; font-size: 12px; color: #8a97ad; }
.measure-panel__tip {
  padding: 8px 12px;
  border-top: 1px solid #24324a;
  color: #6b7890;
  font-size: 11px;
}
</style>
