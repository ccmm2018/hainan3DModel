# 海南警察学院 3D 可视化场景

基于 **Vue3 + Three.js + 高德地图 JS API 2.0** 的 3D 可视化场景初始化项目。

高德地图作为 3D 底图，通过 `AMap.GLCustomLayer` 将 Three.js 场景叠加到地图上，加载海南警察学院 GLB 三维模型，并完成地理对齐。

## 技术方案

```
┌─────────────────────────────────────────────┐
│  Vue3 + TypeScript + Vite                    │
│  ┌───────────────────────────────────────┐  │
│  │  AMap.Map (viewMode: '3D')  底图      │  │
│  │   └─ AMap.GLCustomLayer              │  │
│  │        └─ Three.js 场景 (共享 GL 上下文) │  │
│  │             └─ GLB 校园模型 (地理对齐)   │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### 核心原理

1. **地图与 3D 融合**：`AMap.GLCustomLayer` 提供 `init(gl)` 回调，把高德地图的
   WebGL 上下文传给 `THREE.WebGLRenderer`，实现共享渲染。
   - `renderer.autoClear = false` 保留底图；
   - 每帧 `renderer.resetState()` 重置 GL 状态，避免图层互相污染。

2. **相机同步**：每帧调用 `map.customCoords.getCameraParams()`，把 `near / far /
   fov / up / lookAt / position` 同步到 Three.js 相机，保证模型与底图严格对齐。

3. **坐标对齐**（关键）：
   - 高德底图使用 **GCJ-02**（火星坐标），而 QGIS 数据是 **WGS84 / EPSG:3857**，
     直接混用会产生偏移；
   - 本项目的坐标管线：`WGS84 → GCJ-02 → customCoords.lngLatToCoord() → 墨卡托世界坐标`。

## 快速开始

### 1. 配置高德地图 Key

复制 `.env.example` 为 `.env`，填入你的 key：

```bash
cp .env.example .env
```

```env
VITE_AMAP_KEY=你的高德JSAPI_key
VITE_AMAP_SECURITY_CODE=你的安全密钥securityJsCode
```

> 在 [高德开放平台控制台](https://console.amap.com/) 创建「Web端(JS API)」应用获取。
> 2021-12-02 之后申请的 key 必须配合安全密钥一起使用。

### 2. 放置 GLB 模型

把校园 GLB 模型放到 `public/models/hnjcxy.glb`（可在 `src/config/mapConfig.ts`
中修改 `modelUrl`）。

**暂无真实模型时**，可先生成一个占位的校园模型（含命名的建筑，用于测试拾取/楼盘表）：

```bash
npm run generate:model
```

如需导出 `hnjcxy.blend` → `hnjcxy.glb`，用 Blender：

```
文件 → 导出 → glTF 2.0 (.glb/.gltf)
格式：glTF Binary (.glb)
```

### 3. 启动

```bash
npm install
npm run dev
```

> **重要**：three.js 固定用 `0.162.0`。高德 `GLCustomLayer` 提供的是 WebGL 1 上下文，
> 而 three r163 起移除了 WebGL 1 支持，更高版本会报
> `THREE.WebGLRenderer: WebGL 1 is not supported since r163` 并卡在加载页。

访问 `http://localhost:5173`。

## 目录结构

```
src/
├── main.ts                  # 入口
├── App.vue                  # 根组件
├── styles.css               # 全局样式
├── env.d.ts                 # 类型声明（AMap、Vite env）
├── config/
│   └── mapConfig.ts         # 场景配置（中心点、缩放、模型路径、微调项等）
├── utils/
│   ├── coordTransform.ts    # 坐标转换（WGS84↔GCJ02、EPSG:3857↔4326）
│   ├── loadAMap.ts          # 高德 JS API 动态加载
│   ├── exportImage.ts       # 打印导出（标注叠加/灰度/旋转/PNG/PDF）
│   └── allocation.ts        # 房屋分配（Turf.js 面积计算 + 提交 API）
├── data/
│   ├── buildingData.ts      # 建筑属性数据层（GeoJSON/API 加载 + 示例数据）
│   └── roomData.ts          # 房间数据层（楼盘表：状态/楼层/面积 + 示例数据）
├── core/
│   └── MapScene.ts          # 融合核心类（地图 + GLCustomLayer + Three.js + 拾取/截图）
└── components/
    ├── SceneView.vue        # Vue 组件（tooltip / 属性面板 / 楼盘表 / 搜索 / 室内视角）
    ├── ExportDialog.vue     # 打印导出对话框
    └── AllocationPanel.vue  # 房屋分配侧边栏
```

## 交互功能

- **点击拾取**：Raycaster 拾取被点击的 Mesh，高亮（选中色）并弹出属性面板，
  显示 name、height、department、经纬度、描述等属性。
- **悬停 tooltip**：鼠标悬停显示对象名称（悬停色高亮）。
- **搜索定位**：输入建筑名称，下拉候选，回车/点击即飞行定位到该建筑并选中。

### 浮层锚定（弹窗跟随节点）

属性面板、房间详情、tooltip 都**锚定在被点击/悬停的模型节点旁**，而不是固定在屏幕角落：

- 节点位置由 `MapScene.projectToScreen()` 把模型世界坐标投影为容器内像素坐标得到；
- 面板**默认显示在节点左上方**（间距 14px，紧挨着节点），左侧/上方空间不足时
  自动翻到节点右侧/下方，并夹紧在容器内；
- 容器尺寸在 `onMounted` 里读取并监听（窗口 resize + `ResizeObserver`）；
  若容器尺寸意外为 0，会回退用视口尺寸，避免浮层被夹到页面左上角；
- 地图平移、缩放、旋转、飞行时，`MapScene` 会在渲染帧里比对视角签名，
  通过 `onViewChange` 回调让浮层实时跟随节点；
- 浮层锚点处有一个脉冲圆点标记，指示该弹窗对应哪个节点；
- 开发模式下点击节点会输出 `[浮层锚定] 节点屏幕坐标 / 容器尺寸` 到控制台，便于排查定位问题。

相关实现：`src/components/SceneView.vue` 的 `createAnchoredPanel()` / `updateAnchors()`，
以及 `src/core/MapScene.ts` 的 `projectToScreen()` / `getRoomScreenPos()` / `syncViewChange()`。

属性数据来源见 `src/data/buildingData.ts`：
- `loadBuildingDataFromGeoJSON()`：从 GeoJSON 的 `features[].properties` 读取
- `loadBuildingDataFromArray()`：从后端 API 返回的数组读取
- `SAMPLE_BUILDING_DATA`：示例数据（无真实数据时联调用）

> 拾取依赖 GLB 节点的 `name`。请确保模型导出时建筑/道路/水系分组带有语义化名称，
> 否则只能按 mesh 名或显示「未命名」。

## 楼盘表（房间状态）

点击建筑属性面板中的「查看楼盘表」进入该建筑的楼盘表模式：

- 加载该建筑的房间数据（GeoJSON / 后端 API），按楼层分组
- 在 3D 场景中建筑屋顶上方生成房间格子，用颜色表示状态（空闲绿 / 占用蓝 / 维修橙）
- 楼层切换器查看不同楼层；点击房间弹出详情（房间号、面积、使用部门、状态）
- 「退出」按钮返回普通场景模式

房间数据见 `src/data/roomData.ts`（`fetchRoomData` / `SAMPLE_ROOM_DATA`），
状态色定义在 `ROOM_STATUS_CONFIG`，示例文件 `public/data/rooms.geojson`。

## 室内 3D 模型预留接口

- **楼层组结构预留**：`MapScene.reserveFloorGroups(building, floorCount)` 为每栋建筑创建
  `__indoor_floor_N` 空分组，作为将来 CAD 导入室内模型（glTF/GLB）的挂载点。
- **挂载接口**：`MapScene.mountIndoorModel(building, floor, url)` 加载并挂载室内模型到指定楼层。
- **双击进入室内视角**：双击建筑 → 拉近视角 + 建筑半透明 + 预留楼层组；`ESC` 退出并恢复视角。
- 配置：`indoorZoom` / `indoorPitch` / `defaultFloorCount`。

## DXF 解析引擎能力边界

导入向导使用**纯前端解析器**（`src/utils/dxfParser.ts` + `src/workers/dxf.worker.ts`），
在浏览器内完成 DXF → 楼层平面图 的转换。为明确预期，引擎只保证以下能力；其余情形
走**后端解析服务兜底**（预留接口 `POST /api/cad/parse`，客户端封装见 `src/utils/cadParseApi.ts`）。

### MVP 纯前端解析 · 保证支持

| 项 | 说明 |
| --- | --- |
| 标准 DXF | R12~R2018 的组码-值文本格式（ASCII） |
| 直线房间 | `LWPOLYLINE` / `POLYLINE`（VERTEX+SEQEND），不含曲线段 |
| 字段 | `TEXT` / `MTEXT`（MTEXT 自动去格式码、按 `\P` 拆行） |
| 编码 | `GBK` / `UTF-8` / `UTF-16LE`，自动探测 |
| 体积 | 单文件 ≤ **20MB** |

### 不支持 · 走后端解析服务兜底

| 项 | 说明 | 兜底路径 |
| --- | --- | --- |
| 天正私有实体 | 未转 T3 的 `ACAD_XRECORD` / 自定义图元 | `POST /api/cad/parse` |
| 曲线房间 | `SPLINE` / `ELLIPSE`（MVP 仅提取直线段，曲线段计入告警、不静默丢弃） | `POST /api/cad/parse` |
| 深层嵌套块 | `INSERT` 嵌套 `INSERT` | `POST /api/cad/parse` |
| 超大图纸 | 单文件 > 20MB | `POST /api/cad/parse` |
| 带洞多边形 | 柱洞 / 内凹（数据结构已预留 `holes` 字段，后续版本支持） | 前端按外环尽力处理，后续版本接入后端 |

> 命中「不支持」项时，导入向导应提示用户：转 T3 / 拆图后重试，或等待后端解析服务上线。

### 预留接口：`POST /api/cad/parse`

前端预留的后端兜底契约（当前尚未部署，调用将抛出明确错误）：

- **Request**：`multipart/form-data` 或 `application/json`
  - `file`（DXF 字节，必填）
  - `encoding?`（指定编码，可选，后端自动探测）
  - `buildingName?` / `floorNo?`（批量上传归属，可选）
- **Response**：与前端 `DxfParseResult` 对齐的 `{ result: DxfParseResult, engine?: string }`
- 客户端封装：`src/utils/cadParseApi.ts` 的 `parseCadViaBackend()`

## 打印 / 导出

点击右上角「打印 / 导出」打开对话框，可配置：

- 标注字段（勾选）：房间号、房间名称、管理部门、房间用途、建筑面积、使用面积、使用部门、使用人
- 显示选项：是否叠加显示标注、是否显示颜色（否则灰度）
- 参数：字号、旋转角度、纸张大小（A4/A3）

导出 PNG（截图下载）或 PDF（jsPDF 生成）。截图通过 framebuffer 读取实现，
标注按房间屏幕投影叠加；在楼盘表模式下导出当前楼层平面图，普通模式导出 3D 场景。

## 房屋分配（面积计算）

楼盘表模式点击「分配模式」进入分配工具：

- 在 3D 场景中点击房间多选（可跨楼层切换），选中房间青色高亮
- 侧边栏实时显示已选房间列表与总面积（用 Turf.js 根据房间 GeoJSON geometry 计算实际面积）
- 输入申请面积后自动对比，提示「满足」或「还差 X ㎡」
- 确认分配后调用后端 API（`allocationApiUrl`）更新房间状态，未配置则本地模拟

面积计算见 `src/utils/allocation.ts`（`computeRoomArea` / `computeTotalArea` / `submitAllocation`）。

## 坐标转换说明

| 坐标系 | 用途 |
| --- | --- |
| WGS84 (EPSG:4326) | QGIS / 标准地理数据、GPS 原始经纬度 |
| GCJ-02 | 高德、腾讯地图使用的火星坐标 |
| EPSG:3857 (Web Mercator) | QGIS 常用投影，米制单位 |

转换工具（`src/utils/coordTransform.ts`）：

| 函数 | 说明 |
| --- | --- |
| `wgs84ToGcj02(lng, lat)` | WGS84 → GCJ-02（供高德使用） |
| `gcj02ToWgs84(lng, lat)` | GCJ-02 → WGS84 |
| `epsg4326To3857(lng, lat)` | WGS84 → Web Mercator 米 |
| `epsg3857To4326(x, y)` | Web Mercator 米 → WGS84 |
| `epsg3857ToLocal(x, y, anchor)` | EPSG:3857 绝对坐标 → 相对锚点的 Three.js 局部坐标 |

## 场景配置

`src/config/mapConfig.ts` 中 `DEFAULT_SCENE_CONFIG`：

| 字段 | 说明 |
| --- | --- |
| `center` | 地图中心（WGS84 [lng, lat]） |
| `zoom` / `pitch` | 初始缩放 / 倾斜角 |
| `modelUrl` | GLB 模型路径 |
| `anchor` | 模型锚点（WGS84），模型原点对齐到此经纬度 |
| `anchorOffset` | 锚点微调偏移（米，[东向, 北向]），用于精确对齐 |
| `modelScale` | 模型缩放 |
| `modelElevation` | 模型海拔（米） |
| `recenterModel` | 是否以模型包围盒中心重新居中 |
| `modelRotation` | 模型欧拉旋转（度），如 Y-up→Z-up 设 `[-90, 0, 0]` |
| `highlightColor` / `hoverColor` | 选中 / 悬停高亮色 |
| `focusZoom` | 点击建筑后飞行定位的缩放级别 |

## 真实坐标说明

海南警察学院（海口市秀英区东山镇定海大道 1 号）：

- WGS84：`110.280328, 19.754910`（已写入配置）
- GCJ-02（高德/腾讯）：`110.284593, 19.753006`

两者相差约 494 米。配置中使用 WGS84，代码内部自动转 GCJ-02 对齐高德底图。
若模型与底图仍有偏差，优先调整 `anchorOffset`（米）或 `modelRotation`。

## 注意事项

1. **坐标偏移**：本项目已内置 WGS84→GCJ-02 转换，直接使用 WGS84 经纬度配置即可。
2. **模型尺寸**：GLB 若以米为单位，`modelScale` 保持 1；若偏移较大，先检查
   模型内部坐标系与锚点是否匹配。
3. **模型朝向/轴**：若模型为 Blender 导出的 Y-up，而地图为 Z-up，需设
   `modelRotation: [-90, 0, 0]`（可能还需绕 Z 轴对齐正北）。
4. **生产环境**：安全密钥建议走代理服务转发，避免明文暴露。
