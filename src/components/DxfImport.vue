<script setup lang="ts">
/**
 * DxfImport：DXF 楼层平面图导入对话框。
 * 流程：选楼栋 / 楼层 → 拖入 .dxf → Web Worker 后台解析（失败回退主线程）→
 * 预览房间（可勾选剔除误识别）→ 确认坐标来源 / 局部变换 → 确认入库。
 * 确认入库那一刻，building store 会把楼栋指纹写回 BuildingProps（索引签名挂载）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ElMessage, type UploadFile, type UploadRawFile } from 'element-plus';
import { useBuildingStore } from '../stores/building';
import AnchorPicker from './AnchorPicker.vue';
import { decodeDxf, fingerprintFromOutline } from '../utils/coordinate';
import type { CoordSource, DxfParseResult, FloorTransform } from '../types/cad';
import type { MatchResult } from '../utils/matcher';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    buildingNames: string[];
    defaultBuilding?: string;
  }>(),
  { defaultBuilding: '' },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'imported', floorId: string): void;
}>();

const store = useBuildingStore();

const buildingName = ref<string>(props.defaultBuilding || props.buildingNames[0] || '');
const floorNo = ref<number>(1);
const selectedFile = ref<File | null>(null);
const preview = ref<DxfParseResult | null>(null);
const parsing = ref<boolean>(false);
const coordSource = ref<CoordSource>('local');
const transform = ref<FloorTransform | undefined>(undefined);
const encoding = ref<string>('auto');
/** 是否展开块参照（INSERT/ATTRIB）。默认 false：整体跳过块参照（家具/洁具/门窗等多为块，是噪音来源） */
const expandBlocks = ref<boolean>(false);

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const importedFloors = computed(() => store.floorsOf(buildingName.value));
const suggestedCenter = computed<[number, number] | null>(() => {
  const fp = store.buildingFingerprint(buildingName.value);
  return fp.centerUtm ?? null;
});

/**
 * 楼栋自动匹配：仅当图纸为 UTM 且已识别到「楼层外轮廓线」时，
 * 用外轮廓指纹（中心 / 面积 / 方位）在楼栋库中比对。
 */
const matchResult = computed<MatchResult | null>(() => {
  const p = preview.value;
  if (!p || !p.floorOutline || coordSource.value !== 'utm') return null;
  const fpRaw = fingerprintFromOutline(p.floorOutline.polygon);
  if (!fpRaw.centerUtm) return null;
  return store.matchByFingerprint({
    centerUtm: fpRaw.centerUtm,
    area: fpRaw.footprintArea ?? 0,
    azimuth: fpRaw.azimuth ?? 0,
  });
});

function applyMatch() {
  const r = matchResult.value;
  if (r && r.candidates.length === 1) {
    buildingName.value = r.candidates[0];
    ElMessage.success(`已采用自动匹配楼栋：${r.candidates[0]}`);
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open && props.defaultBuilding) buildingName.value = props.defaultBuilding;
  },
);

// ---- DXF 解析（Worker 优先，主线程回退） ----
let worker: Worker | null = null;
let reqId = 0;
const pending = new Map<number, (r: DxfParseResult | null, err?: string) => void>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('../workers/dxf.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<{ id: number; result?: DxfParseResult; error?: string }>) => {
      const { id, result, error } = ev.data;
      const cb = pending.get(id);
      if (cb) {
        pending.delete(id);
        cb(result ?? null, error);
      }
    };
  } catch {
    worker = null;
  }
  return worker;
}

async function decodeBuffer(buf: ArrayBuffer, enc: string): Promise<string> {
  if (enc && enc !== 'auto') {
    try {
      return new TextDecoder(enc).decode(buf);
    } catch {
      // 编码不支持，回退自动探测
    }
  }
  return decodeDxf(buf);
}

async function parseDxf(
  buffer: ArrayBuffer,
  enc: string,
  bn: string,
  fn: number,
  expand: boolean,
): Promise<DxfParseResult> {
  const w = ensureWorker();
  if (!w) {
    const mod = await import('../utils/dxfParser');
    const text = await decodeBuffer(buffer, enc);
    return mod.parseDxfToResult(text, bn, fn, { expandBlocks: expand });
  }
  return new Promise<DxfParseResult>((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, (r, e) => (r ? resolve(r) : reject(new Error(e ?? '解析失败'))));
    w.postMessage({ id, buffer, encoding: enc, buildingName: bn, floorNo: fn, expandBlocks: expand });
    window.setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        import('../utils/dxfParser')
          .then(async (m) => {
            const text = await decodeBuffer(buffer, enc);
            resolve(m.parseDxfToResult(text, bn, fn, { expandBlocks: expand }));
          })
          .catch(reject);
      }
    }, 8000);
  });
}

function onFileChange(uploadFile: UploadFile) {
  const raw = uploadFile.raw as UploadRawFile | undefined;
  if (!raw) return;
  const name = raw.name.toLowerCase();
  if (!name.endsWith('.dxf')) {
    ElMessage.error('仅支持 .dxf 格式的图纸文件');
    return;
  }
  selectedFile.value = raw;
  parsing.value = true;
  preview.value = null;
  raw
    .arrayBuffer()
    .then((buf) => parseDxf(buf, encoding.value, buildingName.value, floorNo.value, expandBlocks.value))
    .then((res) => {
      preview.value = res;
      coordSource.value = res.coordSource;
      transform.value = undefined;
    })
    .catch((err: Error) => {
      ElMessage.error(`解析失败：${err.message}`);
    })
    .finally(() => {
      parsing.value = false;
    });
}

function clearFile() {
  selectedFile.value = null;
  preview.value = null;
}

const selectedCount = computed(() => preview.value?.rooms.filter((r) => r.selected).length ?? 0);

async function onConfirm() {
  if (!buildingName.value) {
    ElMessage.warning('请选择楼栋');
    return;
  }
  if (!selectedFile.value || !preview.value) {
    ElMessage.warning('请上传 DXF 图纸');
    return;
  }
  const payload = {
    buildingName: buildingName.value,
    floorNo: floorNo.value,
    fileName: selectedFile.value.name,
    parsed: preview.value,
    coordSource: coordSource.value,
    transform: coordSource.value === 'local' ? transform.value : undefined,
  };
  try {
    const fid = store.importFloor(payload);
    const fp = store.buildingFingerprint(buildingName.value);
    if (fp.centerUtm) {
      ElMessage.success(`已导入 ${buildingName.value} ${floorNo.value}F（${selectedCount.value} 间），并写回楼栋指纹`);
    } else {
      ElMessage.success(`已导入 ${buildingName.value} ${floorNo.value}F（${selectedCount.value} 间）`);
    }
    emit('imported', fid);
    clearFile();
    visible.value = false;
  } catch (err) {
    ElMessage.error(`导入失败：${(err as Error).message ?? '未知错误'}`);
  }
}

function onRemoveFloor(f: number) {
  store.removeFloor(buildingName.value, f);
  ElMessage.info(`已删除 ${buildingName.value} ${f}F`);
}

onBeforeUnmount(() => {
  worker?.terminate();
  worker = null;
});
</script>

<template>
  <el-dialog
    v-model="visible"
    title="导入楼层平面图（DXF）"
    width="620px"
    @close="clearFile"
  >
    <div class="dxf-form">
      <div class="dxf-row">
        <label class="dxf-label">楼栋</label>
        <el-select v-model="buildingName" placeholder="选择楼栋" class="dxf-control">
          <el-option v-for="b in buildingNames" :key="b" :label="b" :value="b" />
        </el-select>
      </div>

      <div class="dxf-row">
        <label class="dxf-label">楼层</label>
        <el-input-number v-model="floorNo" :min="1" :max="99" controls-position="right" class="dxf-control" />
        <span class="dxf-unit">F</span>
      </div>

      <div class="dxf-row dxf-row--col">
        <label class="dxf-label">DXF 图纸</label>
        <el-upload
          class="dxf-uploader"
          drag
          accept=".dxf"
          :auto-upload="false"
          :show-file-list="false"
          :on-change="onFileChange"
        >
          <div v-if="!selectedFile" class="dxf-drop">
            <div class="dxf-drop__icon">⤓</div>
            <div>将 DXF 文件拖到此处，或<em>点击上传</em></div>
            <div class="dxf-drop__hint">支持含 4 图层的 .dxf：楼层外轮廓线 / 内部结构外墙线 / 内部结构内墙线（房间轮廓+文字）/ 柱子及窗户线</div>
          </div>
          <div v-else class="dxf-file">
            <span>{{ selectedFile.name }}</span>
            <el-button link type="danger" @click.stop="clearFile">移除</el-button>
          </div>
        </el-upload>
      </div>

      <el-alert
        v-if="parsing"
        class="dxf-preview"
        type="info"
        :closable="false"
        title="正在解析 DXF…"
      />

      <template v-if="preview">
        <div class="dxf-row dxf-row--wrap">
          <label class="dxf-label">坐标来源</label>
          <el-radio-group v-model="coordSource">
            <el-radio value="local">局部坐标</el-radio>
            <el-radio value="utm">UTM 49N</el-radio>
          </el-radio-group>
          <span class="dxf-tip">识别单位：{{ preview.unit === 'mm' ? '毫米' : preview.unit === 'm' ? '米' : '未知' }}</span>
        </div>

        <div class="dxf-row dxf-row--wrap">
          <label class="dxf-label">编码</label>
          <el-select v-model="encoding" class="dxf-enc" placeholder="文本编码">
            <el-option label="自动（UTF-8 / GBK）" value="auto" />
            <el-option label="UTF-8" value="utf-8" />
            <el-option label="GBK" value="gbk" />
            <el-option label="GB2312" value="gb2312" />
          </el-select>
          <span class="dxf-tip">非 UTF-8 图纸（如 AutoCAD 中文环境导出）请手动指定</span>
        </div>

        <div class="dxf-row dxf-row--wrap">
          <label class="dxf-label">块参照</label>
          <el-checkbox v-model="expandBlocks">展开块参照（INSERT/ATTRIB）</el-checkbox>
          <span class="dxf-tip">默认跳过块参照（家具/洁具/门窗等多为块，是噪音来源）；勾选后保留块属性文字</span>
        </div>

        <AnchorPicker
          v-if="coordSource === 'local'"
          v-model="transform"
          :unit="preview.unit"
          :suggested-center="suggestedCenter"
        />

        <el-alert
          class="dxf-preview"
          type="success"
          :closable="false"
          :title="`解析成功：识别到 ${preview.rooms.length} 个房间，已选 ${selectedCount} 个`"
        />

        <el-alert
          v-if="preview.floorOutline"
          class="dxf-preview"
          type="info"
          :closable="false"
          :title="`已识别「楼层外轮廓线」图层（${preview.floorOutline.layer}），将作为楼栋指纹（中心 / 轮廓 / 方位 / 占地面积）的唯一来源`"
        />
        <el-alert
          v-else
          class="dxf-preview"
          type="warning"
          :closable="false"
          title="未识别到「楼层外轮廓线」图层，将改用房间外包络估算楼栋指纹（精度有限）"
        />

        <el-alert
          v-if="matchResult"
          class="dxf-preview"
          :type="matchResult.status === 'strong' ? 'success' : matchResult.status === 'weak' ? 'warning' : 'error'"
          :closable="false"
        >
          <template #title>
            <span>楼栋自动匹配（{{ matchResult.status === 'strong' ? '强匹配' : matchResult.status === 'weak' ? '弱匹配' : '未匹配' }}）：</span>
            <span v-if="matchResult.candidates.length">{{ matchResult.candidates.join('、') }}</span>
            <span v-else>无</span>
            <el-button
              v-if="matchResult.candidates.length === 1"
              link
              type="primary"
              size="small"
              style="margin-left: 8px"
              @click="applyMatch"
            >采用</el-button>
          </template>
          <template v-if="matchResult.reasons.length" #default>
            <div v-for="(rs, i) in matchResult.reasons" :key="i" class="dxf-match__reason">{{ rs }}</div>
          </template>
        </el-alert>

        <div class="dxf-roomlist">
          <div
            v-for="(room, idx) in preview.rooms"
            :key="room.id"
            class="dxf-room"
            :class="{ 'dxf-room--off': !room.selected }"
          >
            <el-checkbox v-model="room.selected" />
            <span class="dxf-room__no">{{ room.code || `房间${idx + 1}` }}</span>
            <span class="dxf-room__name">{{ room.name }}</span>
            <span
              class="dxf-room__tag"
              :class="room.inspectStatus === 'highlight' ? 'is-warn' : ''"
            >{{ room.inspectStatus === 'highlight' ? '需复核' : '正常' }}</span>
            <span class="dxf-room__area">{{ room.area.toFixed(1) }}</span>
          </div>
        </div>

        <el-alert
          v-for="(w, i) in preview.warnings"
          :key="i"
          class="dxf-preview"
          :type="w.level === 'warn' ? 'warning' : 'error'"
          :closable="false"
          :title="`[${w.code}] ${w.message}`"
        />
      </template>
    </div>

    <div v-if="importedFloors.length" class="dxf-list">
      <div class="dxf-list__title">已导入（{{ buildingName }}）</div>
      <div v-for="f in importedFloors" :key="f" class="dxf-list__item">
        <span>
          {{ f }}F · {{ store.roomsOfFloor(store.getFloor(buildingName, f)?.id ?? '').length }} 间
          · {{ store.getFloor(buildingName, f)?.status }}
          <em v-if="store.getFloor(buildingName, f)?.errorReason" class="dxf-list__err">
            {{ store.getFloor(buildingName, f)?.errorReason }}
          </em>
        </span>
        <el-button link type="danger" size="small" @click="onRemoveFloor(f)">删除</el-button>
      </div>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="parsing" @click="onConfirm">确认入库</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.dxf-form { display: flex; flex-direction: column; gap: 14px; }
.dxf-row { display: flex; align-items: center; gap: 12px; }
.dxf-row--col { flex-direction: column; align-items: stretch; gap: 8px; }
.dxf-row--wrap { flex-wrap: wrap; gap: 10px; }
.dxf-label { width: 56px; flex: 0 0 auto; color: #4b5563; font-size: 14px; }
.dxf-control { flex: 1 1 auto; }
.dxf-enc { width: 200px; }
.dxf-unit { color: #6b7280; }
.dxf-tip { font-size: 12px; color: #9ca3af; }
.dxf-uploader { width: 100%; }
.dxf-drop {
  padding: 22px 12px;
  text-align: center;
  color: #6b7280;
  border: 1px dashed #c0c4cc;
  border-radius: 8px;
  background: #fafafa;
}
.dxf-drop__icon { font-size: 26px; color: #409eff; }
.dxf-drop em { color: #409eff; font-style: normal; }
.dxf-drop__hint { font-size: 12px; color: #9ca3af; margin-top: 4px; }
.dxf-file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border: 1px solid #dcdfe6;
  border-radius: 8px;
  background: #f5f7fa;
  color: #303133;
}
.dxf-preview { margin-top: 0; }
.dxf-roomlist {
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 6px;
}
.dxf-room {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  font-size: 13px;
  color: #303133;
  border-bottom: 1px dashed #f0f2f5;
}
.dxf-room--off { opacity: 0.45; }
.dxf-room__no { font-weight: 600; min-width: 56px; }
.dxf-room__name { flex: 1; color: #4b5563; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dxf-room__tag {
  font-size: 11px;
  color: #16a34a;
  border: 1px solid #bbf7d0;
  background: #f0fdf4;
  border-radius: 4px;
  padding: 1px 6px;
}
.dxf-room__tag.is-warn { color: #d97706; border-color: #fde68a; background: #fffbeb; }
.dxf-room__area { color: #9ca3af; min-width: 64px; text-align: right; }
.dxf-list { margin-top: 14px; border-top: 1px solid #ebeef5; padding-top: 10px; }
.dxf-list__title { font-size: 13px; color: #909399; margin-bottom: 6px; }
.dxf-list__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  color: #303133;
  padding: 5px 0;
}
.dxf-list__err { color: #d97706; font-style: normal; margin-left: 6px; }
</style>
