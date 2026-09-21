<script setup lang="ts">
/**
 * AnchorPicker：local 图纸的局部坐标 → UTM 相似变换编辑器。
 * 供 DxfImport 在「坐标来源 = 局部」时使用：填入图纸原点对应的 UTM 东侧/北侧坐标、
 * 旋转角与缩放（毫米图纸默认 0.001），即可把房间定位到真实地理位置。
 * 若已有楼栋指纹中心，可一键「用楼栋中心估算」自动填充平移量。
 */
import { ref, watch } from 'vue';
import type { FloorTransform, LengthUnit } from '../types/cad';

const props = withDefaults(
  defineProps<{
    modelValue?: FloorTransform;
    unit: LengthUnit;
    suggestedCenter: [number, number] | null;
  }>(),
  { modelValue: undefined, suggestedCenter: null },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: FloorTransform): void;
}>();

const offsetX = ref<number>(0);
const offsetY = ref<number>(0);
const rotationDeg = ref<number>(0);
const scale = ref<number>(1);

function defaultScale(unit: LengthUnit): number {
  return unit === 'mm' ? 0.001 : unit === 'cm' ? 0.01 : 1;
}

function syncFromModel() {
  if (props.modelValue) {
    offsetX.value = props.modelValue.offset[0];
    offsetY.value = props.modelValue.offset[1];
    rotationDeg.value = (props.modelValue.rotation * 180) / Math.PI;
    scale.value = props.modelValue.scale;
  } else {
    scale.value = defaultScale(props.unit);
  }
}

function emitChange() {
  emit('update:modelValue', {
    offset: [offsetX.value, offsetY.value],
    rotation: (rotationDeg.value * Math.PI) / 180,
    scale: scale.value,
  });
}

watch(() => props.modelValue, syncFromModel, { immediate: true });
watch(() => props.unit, () => {
  if (!props.modelValue) scale.value = defaultScale(props.unit);
});
watch([offsetX, offsetY, rotationDeg, scale], emitChange);

function applySuggested() {
  if (props.suggestedCenter) {
    offsetX.value = props.suggestedCenter[0];
    offsetY.value = props.suggestedCenter[1];
    rotationDeg.value = 0;
    scale.value = defaultScale(props.unit);
  }
}

function reset() {
  offsetX.value = 0;
  offsetY.value = 0;
  rotationDeg.value = 0;
  scale.value = defaultScale(props.unit);
}
</script>

<template>
  <div class="anchor">
    <div class="anchor__title">局部坐标 → UTM 变换</div>
    <div class="anchor__grid">
      <label class="anchor__cell">
        <span>东向偏移 E (m)</span>
        <el-input-number v-model="offsetX" :step="1" :controls="false" size="small" />
      </label>
      <label class="anchor__cell">
        <span>北向偏移 N (m)</span>
        <el-input-number v-model="offsetY" :step="1" :controls="false" size="small" />
      </label>
      <label class="anchor__cell">
        <span>旋转 (°)</span>
        <el-input-number v-model="rotationDeg" :step="1" :controls="false" size="small" />
      </label>
      <label class="anchor__cell">
        <span>缩放 ({{ unit === 'mm' ? '0.001' : unit === 'cm' ? '0.01' : '1' }})</span>
        <el-input-number v-model="scale" :step="0.001" :controls="false" size="small" :min="1e-6" />
      </label>
    </div>
    <div class="anchor__actions">
      <el-button size="small" :disabled="!suggestedCenter" @click="applySuggested">
        用楼栋中心估算
      </el-button>
      <el-button size="small" text @click="reset">重置</el-button>
    </div>
    <p v-if="!suggestedCenter" class="anchor__hint">
      提示：在「楼栋中心 UTM」未测得时，可手动填入图纸原点对应的真实 UTM 坐标。
    </p>
  </div>
</template>

<style scoped>
.anchor {
  border: 1px solid #dcdfe6;
  border-radius: 8px;
  padding: 12px 14px;
  background: #f7f9fc;
}
.anchor__title { font-size: 13px; font-weight: 600; color: #1f2a3a; margin-bottom: 10px; }
.anchor__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 14px;
}
.anchor__cell { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #5a6678; }
.anchor__actions { display: flex; gap: 8px; margin-top: 10px; }
.anchor__hint { font-size: 11px; color: #9ca3af; margin: 8px 0 0; line-height: 1.6; }
</style>
