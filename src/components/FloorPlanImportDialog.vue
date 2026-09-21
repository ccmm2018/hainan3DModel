<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage, type UploadFile, type UploadRawFile } from 'element-plus';
import { useFloorPlanStore } from '../stores/floorPlanStore';
import { parseDxfToRooms } from '../floorplan/dxfParser';
import type { DxfParseResult, FloorPlan } from '../floorplan/types';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    buildings: string[];
    defaultBuilding?: string;
  }>(),
  { defaultBuilding: '' },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'imported', plan: FloorPlan): void;
}>();

const store = useFloorPlanStore();

const buildingName = ref<string>(props.defaultBuilding || props.buildings[0] || '');
const floor = ref<number>(1);
const selectedFile = ref<File | null>(null);
const preview = ref<DxfParseResult | null>(null);
const submitting = ref<boolean>(false);

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

/** 当前楼栋已导入的楼层清单 */
const importedFloors = computed(() => store.floorsOf(buildingName.value));

watch(
  () => props.modelValue,
  (open) => {
    if (open && props.defaultBuilding) buildingName.value = props.defaultBuilding;
  },
);

function beforeClose() {
  visible.value = false;
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
  // 立即解析用于预览
  raw
    .text()
    .then((text) => {
      preview.value = parseDxfToRooms(text, buildingName.value, floor.value);
    })
    .catch(() => {
      preview.value = null;
      ElMessage.error('文件读取失败，请确认文件未损坏');
    });
}

function clearFile() {
  selectedFile.value = null;
  preview.value = null;
}

async function onConfirm() {
  if (!buildingName.value) {
    ElMessage.warning('请选择楼栋');
    return;
  }
  if (!selectedFile.value) {
    ElMessage.warning('请上传 DXF 图纸');
    return;
  }
  submitting.value = true;
  try {
    const plan = await store.importDxf(selectedFile.value, buildingName.value, floor.value);
    ElMessage.success(`已导入 ${buildingName.value} ${floor.value}F（${plan.rooms.length} 个房间）`);
    emit('imported', plan);
    clearFile();
    visible.value = false;
  } catch (err) {
    ElMessage.error(`导入失败：${(err as Error).message ?? '未知错误'}`);
  } finally {
    submitting.value = false;
  }
}

function onRemoveFloor(f: number) {
  store.removePlan(buildingName.value, f);
  ElMessage.info(`已删除 ${buildingName.value} ${f}F 平面图`);
}
</script>

<template>
  <el-dialog
    v-model="visible"
    title="导入楼层平面图（DXF）"
    width="560px"
    @close="beforeClose"
  >
    <div class="dxf-form">
      <div class="dxf-row">
        <label class="dxf-label">楼栋</label>
        <el-select v-model="buildingName" placeholder="选择楼栋" class="dxf-control">
          <el-option v-for="b in buildings" :key="b" :label="b" :value="b" />
        </el-select>
      </div>

      <div class="dxf-row">
        <label class="dxf-label">楼层</label>
        <el-input-number v-model="floor" :min="1" :max="99" controls-position="right" class="dxf-control" />
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
            <div class="dxf-drop__hint">仅支持 .dxf（含闭合多段线房间轮廓 + 文字标签）</div>
          </div>
          <div v-else class="dxf-file">
            <span>{{ selectedFile.name }}</span>
            <el-button link type="danger" @click.stop="clearFile">移除</el-button>
          </div>
        </el-upload>
      </div>

      <el-alert
        v-if="preview"
        class="dxf-preview"
        type="success"
        :closable="false"
        :title="`解析成功：识别到 ${preview.rooms.length} 个房间`"
      />
      <el-alert
        v-for="(w, i) in (preview?.warnings ?? [])"
        :key="i"
        class="dxf-preview"
        :type="w.level === 'warn' ? 'warning' : 'info'"
        :closable="false"
        :title="w.message"
      />
    </div>

    <div v-if="importedFloors.length" class="dxf-list">
      <div class="dxf-list__title">已导入（{{ buildingName }}）</div>
      <div v-for="f in importedFloors" :key="f" class="dxf-list__item">
        <span>{{ f }}F · {{ store.getPlan(buildingName, f)?.rooms.length ?? 0 }} 间 · {{ store.getPlan(buildingName, f)?.fileName }}</span>
        <el-button link type="danger" size="small" @click="onRemoveFloor(f)">删除</el-button>
      </div>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="onConfirm">导入</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.dxf-form { display: flex; flex-direction: column; gap: 16px; }
.dxf-row { display: flex; align-items: center; gap: 12px; }
.dxf-row--col { flex-direction: column; align-items: stretch; gap: 8px; }
.dxf-label { width: 56px; flex: 0 0 auto; color: #4b5563; font-size: 14px; }
.dxf-control { flex: 1 1 auto; }
.dxf-unit { color: #6b7280; }
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
.dxf-list { margin-top: 16px; border-top: 1px solid #ebeef5; padding-top: 12px; }
.dxf-list__title { font-size: 13px; color: #909399; margin-bottom: 8px; }
.dxf-list__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  color: #303133;
  padding: 6px 0;
}
</style>
