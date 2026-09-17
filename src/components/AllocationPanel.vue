<template>
  <div class="alloc-panel">
    <div class="alloc-panel__head">
      <span class="alloc-panel__dot"></span>
      <strong>房屋分配</strong>
      <button class="alloc-panel__close" aria-label="关闭" @click="$emit('close')">×</button>
    </div>

    <!-- 已选房间列表 -->
    <div class="alloc-list">
      <div v-if="!rooms.length" class="alloc-empty">
        点击 3D 场景中的房间进行选择（可跨楼层）
      </div>
      <div v-for="room in rooms" :key="room.id" class="alloc-item">
        <div class="alloc-item__main">
          <span class="alloc-item__no">{{ room.roomNo }}</span>
          <span class="alloc-item__meta">{{ room.building }} · {{ room.floor }}F</span>
        </div>
        <div class="alloc-item__area">{{ formatArea(room.area) }} ㎡</div>
        <button class="alloc-item__remove" @click="$emit('remove', room.id)">×</button>
      </div>
    </div>

    <!-- 面积汇总 -->
    <div class="alloc-summary">
      <div class="alloc-summary__row">
        <span>已选房间</span>
        <strong>{{ rooms.length }} 间</strong>
      </div>
      <div class="alloc-summary__row total">
        <span>总面积</span>
        <strong>{{ totalArea.toFixed(1) }} ㎡</strong>
      </div>
    </div>

    <!-- 申请面积 -->
    <div class="alloc-form">
      <label class="alloc-field">
        <span>申请面积（㎡）</span>
        <input v-model.number="requestedArea" type="number" min="0" placeholder="请输入申请面积" />
      </label>
      <label class="alloc-field">
        <span>申请人</span>
        <input v-model="applicant" type="text" placeholder="选填" />
      </label>

      <!-- 对比结果 -->
      <div v-if="requestedArea > 0" class="alloc-compare" :class="satisfied ? 'ok' : 'short'">
        <template v-if="satisfied">
          满足申请：已选面积 {{ totalArea.toFixed(1) }} ㎡ ≥ {{ requestedArea }} ㎡
        </template>
        <template v-else>
          面积不足：还差 {{ (requestedArea - totalArea).toFixed(1) }} ㎡
        </template>
      </div>
      <div v-else class="alloc-compare muted">
        输入申请面积后自动对比是否满足
      </div>

      <div v-if="resultMessage" class="alloc-result" :class="resultType">
        {{ resultMessage }}
      </div>
    </div>

    <!-- 操作 -->
    <div class="alloc-panel__foot">
      <button
        class="alloc-btn alloc-btn--primary"
        :disabled="!rooms.length || requestedArea <= 0 || submitting"
        @click="$emit('confirm', { requestedArea, applicant })"
      >
        {{ submitting ? '提交中…' : '确认分配' }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Room } from '../data/roomData';

const props = defineProps<{
  rooms: Room[];
  totalArea: number;
  submitting: boolean;
  resultMessage: string | null;
  resultType: 'success' | 'error' | null;
}>();

defineEmits<{
  (e: 'close'): void;
  (e: 'remove', roomId: string): void;
  (e: 'confirm', payload: { requestedArea: number; applicant: string }): void;
}>();

const requestedArea = ref(0);
const applicant = ref('');

const satisfied = computed(
  () => props.totalArea >= requestedArea.value && requestedArea.value > 0,
);

function formatArea(v: number): string {
  return Number(v ?? 0).toFixed(1);
}
</script>

<style scoped>
.alloc-panel {
  position: absolute;
  z-index: 130;
  right: 16px;
  bottom: 16px;
  width: 320px;
  max-width: calc(100% - 32px);
  max-height: calc(100% - 120px);
  display: flex;
  flex-direction: column;
  border: 1px solid #24324a;
  border-radius: 8px;
  background: rgba(20, 27, 43, 0.95);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(12px);
  overflow: hidden;
}

.alloc-panel__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid #24324a;
  color: #eaf2ff;
}
.alloc-panel__head strong { flex: 1; font-size: 15px; font-weight: 600; }
.alloc-panel__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #22d3ee;
  box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.15);
}
.alloc-panel__close {
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 4px;
  color: #8a97ad;
  background: transparent;
  font-size: 18px;
  cursor: pointer;
}
.alloc-panel__close:hover { color: #f87171; background: #22314a; }

.alloc-list {
  flex: 1;
  min-height: 80px;
  max-height: 220px;
  overflow-y: auto;
  padding: 8px 14px;
}
.alloc-empty {
  padding: 18px 0;
  color: #6b7890;
  font-size: 12px;
  text-align: center;
}
.alloc-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px dashed #1e2a40;
}
.alloc-item__main { flex: 1; min-width: 0; }
.alloc-item__no {
  display: block;
  color: #eaf2ff;
  font-size: 13px;
  font-weight: 600;
}
.alloc-item__meta {
  display: block;
  margin-top: 2px;
  color: #7d8aa3;
  font-size: 11px;
}
.alloc-item__area {
  color: #a7b4c8;
  font-size: 12px;
  font-family: ui-monospace, monospace;
}
.alloc-item__remove {
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 4px;
  color: #8a97ad;
  background: transparent;
  font-size: 14px;
  cursor: pointer;
}
.alloc-item__remove:hover { color: #f87171; background: #22314a; }

.alloc-summary {
  padding: 10px 14px;
  border-top: 1px solid #24324a;
  border-bottom: 1px solid #24324a;
  background: #162033;
}
.alloc-summary__row {
  display: flex;
  justify-content: space-between;
  padding: 3px 0;
  color: #a7b4c8;
  font-size: 13px;
}
.alloc-summary__row strong { color: #eaf2ff; font-family: ui-monospace, monospace; }
.alloc-summary__row.total strong { color: #22d3ee; font-size: 16px; }

.alloc-form { padding: 12px 14px 14px; }
.alloc-field {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  color: #c3d0e5;
  font-size: 13px;
}
.alloc-field span { width: 88px; color: #8a97ad; flex-shrink: 0; }
.alloc-field input {
  flex: 1;
  height: 32px;
  padding: 0 10px;
  border: 1px solid #33415c;
  border-radius: 4px;
  color: #eaf2ff;
  background: #1a2335;
  font-size: 13px;
  outline: none;
}
.alloc-field input:focus { border-color: #22d3ee; }

.alloc-compare {
  padding: 8px 10px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
}
.alloc-compare.ok { color: #34d399; background: rgba(52, 211, 153, 0.1); }
.alloc-compare.short { color: #f87171; background: rgba(248, 113, 113, 0.1); }
.alloc-compare.muted { color: #6b7890; background: rgba(107, 120, 144, 0.1); }

.alloc-result {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 4px;
  font-size: 12px;
}
.alloc-result.success { color: #34d399; background: rgba(52, 211, 153, 0.1); }
.alloc-result.error { color: #f87171; background: rgba(248, 113, 113, 0.1); }

.alloc-panel__foot {
  padding: 12px 14px;
  border-top: 1px solid #24324a;
}
.alloc-btn {
  width: 100%;
  height: 36px;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
}
.alloc-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.alloc-btn--primary {
  border: 1px solid #22d3ee;
  color: #d6fbff;
  background: rgba(34, 211, 238, 0.16);
}
.alloc-btn--primary:hover:not(:disabled) { background: rgba(34, 211, 238, 0.28); }
</style>
