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

// 启动流程：仅从本地（IndexedDB）恢复用户已导入的楼层 / 房间 / 楼栋指纹。
// 注意：不再植入任何样例 / 测试楼层数据——所有楼层的房间图形必须来自用户真实上传并
// 解析入库的 DXF（见 src/components/DxfImport.vue → store.importFloor）。
// 在上传 DXF 之前，点击任意楼栋的「查看室内图纸」应显示空状态（「暂无室内图纸，请先导入」）。
async function boot(): Promise<void> {
  const store = useBuildingStore();
  // 一次性清理：历史上演示种子曾把测试楼栋（教学楼 / node_jiaoxueA / node_shixun / node_tushuguan）
  // 写入 IndexedDB，导致「未上传 DXF 却仍显示楼层与色块」。仅清理一次（localStorage 标记），
  // 之后用户若真实导入这些楼栋，数据会正常保留、不会被再次清除。
  const DEMO_CLEARED_KEY = 'hnjcxy-demo-cleared';
  try {
    if (!localStorage.getItem(DEMO_CLEARED_KEY)) {
      for (const b of ['教学楼', 'node_jiaoxueA', 'node_shixun', 'node_tushuguan']) {
        await persistence.clearBuilding(b).catch(() => undefined);
      }
      localStorage.setItem(DEMO_CLEARED_KEY, '1');
    }
    const state = await persistence.loadAll();
    store.applyPersisted(state);
  } catch (e) {
    console.warn('[persist] 读取本地已保存数据失败：', e);
  }
}
void boot();
