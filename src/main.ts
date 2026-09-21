import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import App from './App.vue';
import { useFloorRoomStore } from './stores/floorRoom';
import './styles.css';

const app = createApp(App);
app.use(createPinia());
app.use(ElementPlus);

// 仅开发态：植入样例楼层数据，便于离线联调 2.5D 查看器与指纹写回
if (import.meta.env.DEV) {
  import('./mock/floorPlanMock').then((m) => {
    m.seedMockFloorPlans(useFloorRoomStore());
  });
}

app.mount('#app');
