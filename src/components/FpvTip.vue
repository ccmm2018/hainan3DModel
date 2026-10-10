<template>
  <span class="fpv-tip" @mouseenter="show" @mouseleave="hide">
    <slot />
    <Teleport to="body">
      <div v-if="vis" class="fpv-tip__pop" :style="style">{{ text }}</div>
    </Teleport>
  </span>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ text: string }>();

const vis = ref(false);
const style = ref<Record<string, string>>({});

function show(e: MouseEvent): void {
  const t = e.currentTarget as HTMLElement;
  const r = t.getBoundingClientRect();
  // 用 position:fixed + 视口坐标，避开侧栏 overflow 裁剪与 dialog transform 影响
  style.value = {
    left: `${Math.round(r.left + r.width / 2)}px`,
    top: `${Math.round(r.bottom + 6)}px`,
  };
  vis.value = true;
}
function hide(): void {
  vis.value = false;
}
</script>

<style scoped>
.fpv-tip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
</style>

<!-- 非 scoped：Teleport 到 body 后的浮层需要全局样式才能生效 -->
<style>
.fpv-tip__pop {
  position: fixed;
  transform: translateX(-50%);
  background: rgba(17, 24, 39, 0.92);
  color: #fff;
  font-size: 12px;
  line-height: 1.4;
  padding: 4px 8px;
  border-radius: 6px;
  pointer-events: none;
  z-index: 4000;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
}
.fpv-tip__pop::before {
  content: '';
  position: absolute;
  left: 50%;
  top: -4px;
  transform: translateX(-50%);
  border: 4px solid transparent;
  border-bottom-color: rgba(17, 24, 39, 0.92);
  border-top: 0;
}
</style>
