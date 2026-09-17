<template>
  <div class="export-mask" @click.self="$emit('close')">
    <div class="export-dialog">
      <div class="export-dialog__head">
        <strong>打印 / 导出</strong>
        <button class="export-dialog__close" aria-label="关闭" @click="$emit('close')">×</button>
      </div>

      <div class="export-dialog__body">
        <!-- 标注字段 -->
        <section class="export-section">
          <h4>标注字段</h4>
          <div class="label-fields">
            <label v-for="f in ROOM_LABEL_FIELDS" :key="f.key" class="checkbox">
              <input v-model="opts.checkedFields" type="checkbox" :value="f.key" />
              <span>{{ f.label }}</span>
            </label>
          </div>
        </section>

        <!-- 显示选项 -->
        <section class="export-section">
          <h4>显示选项</h4>
          <div class="toggle-row">
            <label class="switch">
              <input v-model="opts.overlay" type="checkbox" />
              <span class="slider"></span>
            </label>
            <span>叠加显示标注</span>
          </div>
          <div class="toggle-row">
            <label class="switch">
              <input v-model="opts.showColors" type="checkbox" />
              <span class="slider"></span>
            </label>
            <span>显示颜色</span>
          </div>
        </section>

        <!-- 参数 -->
        <section class="export-section">
          <h4>参数</h4>
          <div class="param-grid">
            <label class="param">
              <span>字号</span>
              <input v-model.number="opts.fontSize" type="number" min="8" max="48" /> px
            </label>
            <label class="param">
              <span>旋转角度</span>
              <input v-model.number="opts.rotation" type="number" step="15" /> °
            </label>
            <label class="param">
              <span>纸张大小</span>
              <select v-model="opts.paperSize">
                <option value="A4">A4</option>
                <option value="A3">A3</option>
              </select>
            </label>
          </div>
        </section>
      </div>

      <div class="export-dialog__foot">
        <button class="btn btn-ghost" @click="$emit('close')">取消</button>
        <button class="btn btn-primary" :disabled="exporting" @click="doExport('png')">
          {{ exporting ? '导出中…' : '导出 PNG' }}
        </button>
        <button class="btn btn-accent" :disabled="exporting" @click="doExport('pdf')">
          导出 PDF
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import type { MapScene } from '../core/MapScene';
import { ROOM_LABEL_FIELDS, type Room } from '../data/roomData';
import {
  composeExport,
  downloadCanvasAsPng,
  downloadCanvasAsPdf,
} from '../utils/exportImage';

const props = defineProps<{
  scene: MapScene | null;
  title: string;
}>();

defineEmits<{ (e: 'close'): void }>();

const exporting = ref(false);

const opts = reactive({
  checkedFields: ['roomNo', 'roomName', 'purpose'] as string[],
  overlay: true,
  showColors: true,
  fontSize: 14,
  rotation: 0,
  paperSize: 'A4' as 'A4' | 'A3',
});

function composeLabel(room: Room, fieldKeys: string[]): string {
  const lines: string[] = [];
  for (const field of ROOM_LABEL_FIELDS) {
    if (!fieldKeys.includes(field.key as string)) continue;
    const val = room[field.key];
    if (val === undefined || val === null || val === '') continue;
    lines.push(`${field.label}: ${String(val)}`);
  }
  return lines.join('\n');
}

async function doExport(format: 'png' | 'pdf'): Promise<void> {
  if (!props.scene) return;
  exporting.value = true;
  try {
    const dataUrl = await props.scene.requestSnapshot();
    const positions = props.scene.getCurrentFloorRoomPositions();
    const labels = positions
      .map(({ room, screen }) => ({
        text: composeLabel(room, opts.checkedFields),
        x: screen.x,
        y: screen.y,
      }))
      .filter((l) => l.text !== '');

    const canvas = await composeExport(
      dataUrl,
      labels,
      {
        overlay: opts.overlay,
        showColors: opts.showColors,
        fontSize: opts.fontSize,
        rotation: opts.rotation,
      },
      props.scene.containerSize,
    );

    if (format === 'png') downloadCanvasAsPng(canvas, props.title);
    else downloadCanvasAsPdf(canvas, props.title, opts.paperSize);
  } catch (err) {
    console.error('[导出] 失败：', err);
    alert('导出失败：' + (err as Error).message);
  } finally {
    exporting.value = false;
  }
}
</script>

<style scoped>
.export-mask {
  position: absolute;
  z-index: 400;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 12, 20, 0.6);
  backdrop-filter: blur(4px);
}

.export-dialog {
  width: 420px;
  max-width: calc(100% - 32px);
  max-height: calc(100% - 40px);
  display: flex;
  flex-direction: column;
  border: 1px solid #2b3a56;
  border-radius: 10px;
  background: #141b2b;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.export-dialog__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid #24324a;
  color: #eaf2ff;
}
.export-dialog__head strong { font-size: 15px; }
.export-dialog__close {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 4px;
  color: #8a97ad;
  background: transparent;
  font-size: 18px;
  cursor: pointer;
}
.export-dialog__close:hover { color: #f87171; background: #22314a; }

.export-dialog__body {
  flex: 1;
  overflow-y: auto;
  padding: 6px 18px 10px;
}

.export-section { padding: 10px 0; border-bottom: 1px solid #1e2a40; }
.export-section:last-child { border-bottom: 0; }
.export-section h4 {
  margin: 0 0 8px;
  color: #7d8aa3;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.label-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #c3d0e5;
  font-size: 13px;
  cursor: pointer;
}
.checkbox input { accent-color: #38bdf8; }

.toggle-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
  color: #c3d0e5;
  font-size: 13px;
}

.switch { position: relative; display: inline-block; width: 36px; height: 20px; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider {
  position: absolute;
  inset: 0;
  border-radius: 20px;
  background: #2a3a55;
  transition: 0.2s;
  cursor: pointer;
}
.slider::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #a7b4c8;
  transition: 0.2s;
}
.switch input:checked + .slider { background: #38bdf8; }
.switch input:checked + .slider::before { transform: translateX(16px); background: #fff; }

.param-grid { display: flex; flex-direction: column; gap: 10px; }
.param {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #c3d0e5;
  font-size: 13px;
}
.param span { width: 64px; color: #8a97ad; }
.param input,
.param select {
  height: 30px;
  padding: 0 8px;
  border: 1px solid #33415c;
  border-radius: 4px;
  color: #eaf2ff;
  background: #1a2335;
  font-size: 13px;
  outline: none;
}
.param input { width: 70px; }
.param select { width: 90px; }

.export-dialog__foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 18px;
  border-top: 1px solid #24324a;
}
.btn {
  height: 34px;
  padding: 0 16px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-ghost { border: 1px solid #33415c; color: #a7b4c8; background: transparent; }
.btn-primary { border: 1px solid #38bdf8; color: #d6f0ff; background: rgba(56, 189, 248, 0.16); }
.btn-accent { border: 1px solid #34d399; color: #d6ffe9; background: rgba(52, 211, 153, 0.16); }
.btn-primary:hover { background: rgba(56, 189, 248, 0.28); }
.btn-accent:hover { background: rgba(52, 211, 153, 0.28); }
</style>
