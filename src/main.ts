import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import App from './App.vue';
import { useBuildingStore } from './stores/building';
import { persistence } from './utils/persist';
import './styles.css';

const app = createApp(App);
app.use(createPinia());
app.use(ElementPlus);
app.mount('#app');

// 启动流程：
// 1) 仅开发态：植入样例楼层数据，便于离线联调 2.5D 查看器与指纹写回；
// 2) 无论开发/生产：从本地（IndexedDB）恢复用户已导入的楼层 / 房间 / 楼栋指纹，
//    且在样例播种之后执行，故持久化数据会覆盖同名样例项。
async function boot(): Promise<void> {
  const store = useBuildingStore();
  if (import.meta.env.DEV) {
    const m = await import('./mock/mockData');
    m.seedMockFloorPlans(store);
  }
  try {
    const state = await persistence.loadAll();
    store.applyPersisted(state);
  } catch (e) {
    console.warn('[persist] 读取本地已保存数据失败：', e);
  }
}
void boot();
