<template>
  <div ref="shellRef" class="scene-shell">
    <div ref="mapContainer" class="scene-map"></div>

    <!-- 加载/错误遮罩 -->
    <div v-if="status !== 'ready'" class="scene-overlay">
      <template v-if="status === 'loading-amap'">
        <span class="spinner"></span>
        <strong>正在加载高德地图 JS API…</strong>
      </template>
      <template v-else-if="status === 'loading-model'">
        <span class="spinner"></span>
        <strong>正在加载校园 GLB 模型…</strong>
        <small v-if="modelProgress >= 0 && modelProgress < 100">{{ modelProgress }}%</small>
        <small v-if="modelStageText">{{ modelStageText }}</small>
      </template>
      <template v-else-if="status === 'error'">
        <strong class="err">{{ errorMessage }}</strong>
        <div class="err-hint">
          <template v-if="!keyConfigured">
            1. 打开高德开放平台 console.amap.com，创建「Web端(JS API)」应用<br />
            2. 复制 Key 和「安全密钥 securityJsCode」<br />
            3. 填入项目根目录的 <code>.env</code> 文件（已为你生成）<br />
            4. 保存后重启 <code>npm run dev</code>
          </template>
          <template v-else>请检查模型路径、网络连接后刷新重试</template>
        </div>
      </template>
    </div>

    <!-- 标题徽标 -->
    <div class="scene-badge">
      <span class="badge-light"></span>
      海南警察学院 · 3D 可视化场景
    </div>

    <!-- 统计概览触发按钮：点击后在弹窗中校区下钻（总览 → 详情 → 楼栋 → 楼层 → 房间） -->
    <button
      v-if="modelStats || buildingOverview.modelBuildings"
      class="stats-trigger"
      type="button"
      title="打开校区数据统计（楼栋数按模型上的全部建筑统计）"
      @click="statsDialogOpen = true"
    >
      <span class="stats-trigger__dot"></span>
      <strong>统计概览</strong>
      <!-- s489: 楼栋数回到模型口径 modelBuildings（36 栋全部可点击建筑）。
           统计弹窗也以这 36 栋为唯一主体（全部主校区），首页与弹窗数字天然一致。 -->
      <span class="stats-trigger__brief">{{ buildingOverview.modelBuildings }} 栋 · {{ buildingOverview.roomTotal }} 间房</span>
      <span class="stats-trigger__arrow">↗</span>
    </button>

    <CampusStatsDialog
      v-if="statsDialogOpen"
      :buildings="buildingData"
      :rooms="roomData"
      :model-buildings="buildingOverview.modelBuildings"
      :business-ready="businessReady"
      @close="statsDialogOpen = false"
    />

    <!-- 工具栏 -->
    <div class="toolbar">
      <div class="toolbar__group">
        <span class="toolbar__label">视图</span>
        <!-- 2.5D / 室内暂未开发：按钮不放在本行（会加宽工具栏压住搜索框），
             改由下方 .toolbar-pending 占位展示；此处只保留默认三维。
             恢复方法见下方待开发占位条的注释与 setView() / toggleIndoor()。 -->
        <button class="toolbar__btn" :class="{ active: currentView === '3d' }" @click="setView('3d')">三维</button>
        <button
          class="toolbar__btn"
          :class="{ active: rotateMode }"
          title="旋转视角：开启后按住鼠标左键左右拖动即可旋转（无需 Ctrl），按 Esc 或再点一次退出"
          @click="toggleRotate"
        >旋转</button>
      </div>
      <div class="toolbar__group">
        <span class="toolbar__label">量算</span>
        <button class="toolbar__btn" :class="{ active: measureTool === 'distance' }" @click="startMeasure('distance')">测距</button>
        <button class="toolbar__btn" :class="{ active: measureTool === 'area' }" @click="startMeasure('area')">测面</button>
        <button v-if="measureActive" class="toolbar__btn toolbar__btn--ok" title="结束本次测量并保留结果（也可双击地图或按 Enter）" @click="completeMeasure">完成</button>
        <button class="toolbar__btn toolbar__btn--ghost" @click="stopMeasure">清除</button>
      </div>
      <!-- 工具按钮：底图为浅色（白/淡蓝）时，透明底 + 浅色字会糊成一片。
           这里直接给按钮实底 + 高对比文字；不套外层容器，避免工具栏变宽挤到搜索框。 -->
      <button class="toolbar__btn toolbar__btn--standalone toolbar__btn--primary" @click="exportOpen = true">打印 / 导出</button>
    </div>

    <!-- 待开发功能占位：让用户知道规划里有 2.5D / 室内，但明确不可点（置灰）。
         单独占右上角第二行，不塞进主工具栏——主工具栏右移会压住居中的搜索框。
         恢复 2.5D：去掉 disabled 与 --pending 样式，把按钮移回「视图」组并绑回 setView('2.5d')，
                    再删除 setView() 中的 2.5D 禁用判断（MapScene.setMapView 的 35° 分支一直保留）。
         恢复室内：去掉 disabled 与 --pending 样式，把按钮移回「视图」组并绑回 toggleIndoor，
                   再取消 toggleIndoor() / handleDoubleClick() / onDoubleClick 注册 / ESC 分支 /
                   室内视角提示 badge 的注释（MapScene.enterIndoorView 等底层实现一直保留）。 -->
    <div class="toolbar-pending">
      <button class="toolbar__btn toolbar__btn--pending" disabled aria-disabled="true" title="2.5D 视图待开发">
        2.5D<span class="toolbar__btn__tag">（待开发）</span>
      </button>
      <button class="toolbar__btn toolbar__btn--pending" disabled aria-disabled="true" title="室内视角待开发">
        室内<span class="toolbar__btn__tag">（待开发）</span>
      </button>
    </div>

    <!-- 旋转操作引导条：旋转模式时常驻，明确告知「怎么操作/怎么退出」 -->
    <div v-if="rotateMode" class="rotate-guide">
      <span class="rotate-guide__dot"></span>
      <div class="rotate-guide__text">
        <strong>旋转视角</strong>
        <span>按住鼠标左键左右拖动即可旋转，滚轮仍可缩放</span>
      </div>
      <button class="rotate-guide__exit" @click="toggleRotate">退出 <kbd>Esc</kbd></button>
    </div>

    <!-- 右下角罗盘：N 始终指向正北，拖动罗盘旋转视角，单击回到初始朝向 -->
    <div
      class="compass"
      :class="{ 'compass--dragging': compassDragging }"
      title="拖动罗盘旋转视角 · 单击回到初始朝向"
      @pointerdown="onCompassDown"
      @pointermove="onCompassMove"
      @pointerup="onCompassUp"
      @pointercancel="onCompassUp"
      @click="onCompassClick"
    >
      <div class="compass__face">
        <span class="compass__n">N</span>
        <div class="compass__needle" :style="{ transform: `translate(-50%, -50%) rotate(${compassRotation}deg)` }">
          <span class="compass__tip compass__tip--n"></span>
          <span class="compass__tip compass__tip--s"></span>
        </div>
        <span class="compass__center"></span>
      </div>
    </div>

    <!-- 量算操作引导条：测量进行时常驻，明确告知「怎么结束」，避免只靠隐蔽的双击提示 -->
    <div v-if="measureActive" class="measure-guide" :class="measureTool === 'area' ? 'measure-guide--area' : ''">
      <span class="measure-guide__dot"></span>
      <div class="measure-guide__text">
        <strong>{{ measureTool === 'area' ? '测面中' : '测距中' }}</strong>
        <span>{{ measureGuideText }}</span>
      </div>
      <button class="measure-guide__finish" @click="completeMeasure">✓ 完成测量 <kbd>Enter</kbd></button>
      <button class="measure-guide__cancel" @click="stopMeasure">清除 <kbd>Esc</kbd></button>
      <div class="measure-guide__sub">已临时切到俯视便于准确测量，点「清除」后自动恢复原视角。结束方式：点「完成测量」、双击地图空白处，或按 Enter；按 Esc 清除本次测量</div>
    </div>

    <!-- 量算结果：锚定在测绘范围内（图形质心 / 折线中点），随视角变化跟随图形 -->
    <div
      v-if="measureResult && measureAnchor"
      class="measure-anchor"
      :class="measureResult.mode === 'area' ? 'measure-anchor--area' : ''"
      :style="measureAnchorStyle"
    ></div>
    <div
      v-if="measureResult"
      ref="measurePanelEl"
      class="measure-panel"
      :class="measureResult.mode === 'area' ? 'measure-panel--area' : 'measure-panel--distance'"
      :style="measurePanelStyle"
    >
      <div class="measure-panel__head">
        <strong>{{ measureResult.mode === 'distance' ? '测距结果' : '测面结果' }}</strong>
        <span v-if="measureActive" class="measure-panel__state measure-panel__state--live">测量中</span>
        <span v-else class="measure-panel__state">已完成</span>
        <button class="measure-panel__close" aria-label="清除" @click="stopMeasure">×</button>
      </div>
      <div v-if="measureResult.mode === 'distance'" class="measure-panel__body">
        <div class="measure-panel__total">总长度：<b>{{ formatMeters(measureResult.value) }}</b></div>
        <ol v-if="measureResult.segments && measureResult.segments.length" class="measure-panel__segs">
          <li v-for="(s, i) in measureResult.segments" :key="i">
            <span>第 {{ i + 1 }} 段</span><span>{{ formatMeters(s) }}</span>
          </li>
        </ol>
      </div>
      <div v-else class="measure-panel__body">
        <div class="measure-panel__total">总面积：<b>{{ formatArea(measureResult.value) }}</b></div>
        <div class="measure-panel__meta">顶点数：{{ measureResult.points }}</div>
      </div>
      <!-- 测量中由上方引导条负责说明操作，这里不再重复占高度；结束后给一句简短提示 -->
      <div v-if="!measureActive" class="measure-panel__tip">
        已结束 · 再点地图可开始新一次测量，点「清除」退出量算
      </div>
    </div>

    <!-- 【待开发·已注释】室内视角提示：恢复室内功能时取消本注释包裹即可。
    <div v-if="isIndoorView" class="indoor-badge">
      <span class="indoor-badge__dot"></span>
      室内视角 · 按 ESC 退出
    </div>
    -->

    <!-- 搜索框 -->
    <div class="search-box" :class="{ 'search-box--error': !!searchError }">
      <input
        ref="searchInputRef"
        v-model="searchQuery"
        type="text"
        autocomplete="off"
        placeholder="搜索建筑名称，回车定位…"
        :class="{ 'is-error': !!searchError }"
        @input="onSearchInput"
        @keydown.enter="onSearchEnter"
        @focus="searchFocused = true"
        @blur="searchFocused = false"
      />
      <ul
        v-if="searchFocused && filteredObjects.length"
        class="search-dropdown"
        :class="{ 'search-dropdown--below-guide': measureActive }"
      >
        <li
          v-for="item in filteredObjects"
          :key="item.name"
          @mousedown.prevent="selectByName(item.name)"
        >
          <span class="search-dropdown__name">{{ displayName(item.name) }}</span>
          <span class="search-dropdown__coord">{{ item.lngLat[0].toFixed(5) }}, {{ item.lngLat[1].toFixed(5) }}</span>
        </li>
      </ul>
      <!-- 无结果提示：紧贴搜索框、红色实底常驻，替代原来 3 秒即消失的轻提示。
           输入过程中给中性提示；回车确认找不到时升级为错误态并播放一次入场动画。
           测量引导条出现时整块下移（--below-guide），避免与顶部引导条叠在一起。 -->
      <div
        v-if="searchError || showNoResult"
        :key="searchAlertKey"
        class="search-alert"
        :class="{
          'search-alert--error': !!searchError,
          'search-alert--below-guide': measureActive,
        }"
        role="alert"
      >
        <span class="search-alert__icon">{{ searchError ? '!' : '?' }}</span>
        <div class="search-alert__body">
          <strong>{{ searchError ? `未找到「${searchError}」` : '没有匹配的楼栋' }}</strong>
          <span>{{ searchError ? '请检查名称或编号后重试，也可直接点下面的楼名定位' : '换个关键词试试，或点下面的楼名直接定位' }}</span>
          <div v-if="searchSuggestions.length" class="search-alert__suggest">
            <span>试试：</span>
            <button
              v-for="s in searchSuggestions"
              :key="s.name"
              type="button"
              @mousedown.prevent="selectByName(s.name)"
            >{{ s.label }}</button>
          </div>
          <button class="search-alert__reset" type="button" @mousedown.prevent="resetSearch">清空重输</button>
        </div>
        <button
          v-if="searchError"
          class="search-alert__close"
          type="button"
          aria-label="关闭提示"
          @mousedown.prevent="dismissSearchAlert"
        >×</button>
      </div>
    </div>

    <!-- 悬停 tooltip：场景模式下楼栋名称已由常驻标签展示，不再重复弹名称；房间状态 / 分配 / 室内模式仍按需显示 -->
    <div
      v-if="hovered && (hovered.isRoom || viewMode !== 'scene')"
      class="tooltip"
      :style="tooltipStyle"
    >
      <template v-if="viewMode !== 'scene'">{{ displayName(hovered.name) }}</template>
      <span v-if="hovered.isRoom" class="tooltip__status" :style="{ color: roomStatusColor(hovered.room) }">
        {{ roomStatusLabel(hovered.room) }}
      </span>
    </div>

    <!-- 节点锚点标记：指示浮层指向的模型节点 -->
    <div
      v-if="anchorDot"
      class="anchor-dot"
      :style="{ left: `${anchorDot.x}px`, top: `${anchorDot.y}px` }"
    ></div>

    <!-- 属性面板（场景模式）：锚定在被点击的模型节点旁 -->
    <div
      v-if="selected && viewMode === 'scene'"
      ref="panelEl"
      class="property-panel"
      :style="panelPos"
    >
      <div class="property-panel__head property-panel__head--movable" @pointerdown="onPanelDragStart" title="按住标题栏可拖动面板">
        <span class="dot"></span>
        <strong>{{ selectedProps.name }}</strong>
        <span class="property-panel__badge">{{ categoryLabel(selectedProps.category) }}</span>
        <button class="property-panel__locate" title="定位到该建筑" @click="flyToSelected">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
          </svg>
        </button>
        <button class="property-panel__close" aria-label="关闭" @click="closePanel">×</button>
      </div>

      <!-- 基本属性：图标 + 标签 + 数值，两列网格 -->
      <div class="property-panel__section">
        <div class="property-panel__section-title">基本信息</div>
        <div class="pp-facts">
          <div class="pp-fact">
            <span class="pp-fact__ico pp-fact__ico--campus">校</span>
            <span class="pp-fact__body"><label>所在校区</label><b>{{ selectedProps.campus ?? '—' }}</b></span>
          </div>
          <div class="pp-fact">
            <span class="pp-fact__ico pp-fact__ico--dept">部</span>
            <span class="pp-fact__body"><label>管理部门</label><b>{{ selectedProps.managementDept ?? selectedProps.department ?? '—' }}</b></span>
          </div>
          <div class="pp-fact">
            <span class="pp-fact__ico pp-fact__ico--floor">层</span>
            <span class="pp-fact__body"><label>总层数</label><b>{{ selectedProps.totalFloors != null ? `${selectedProps.totalFloors} 层` : '—' }}</b></span>
          </div>
          <div class="pp-fact">
            <span class="pp-fact__ico pp-fact__ico--room">间</span>
            <span class="pp-fact__body"><label>房间数</label><b>{{ selectedProps.roomCount != null ? `${selectedProps.roomCount} 间` : '—' }}</b></span>
          </div>
        </div>
      </div>

      <!-- 面积：两个大数字卡片 -->
      <div class="property-panel__section">
        <div class="property-panel__section-title">面积概况 <small>单位 ㎡</small></div>
        <div class="pp-area">
          <div class="pp-area__card">
            <label>建筑面积</label>
            <b>{{ selectedProps.buildingArea != null ? selectedProps.buildingArea.toLocaleString() : '—' }}</b>
            <span>㎡</span>
          </div>
          <div class="pp-area__card pp-area__card--use">
            <label>使用面积</label>
            <b>{{ selectedProps.usableArea != null ? selectedProps.usableArea.toLocaleString() : '—' }}</b>
            <span>㎡</span>
          </div>
        </div>
      </div>

      <div class="property-panel__actions">
        <button class="property-panel__btn" @click="openBuildingDetail">楼宇详情</button>
        <button class="property-panel__btn" @click="openRoomManagement">房间管理</button>
        <button class="property-panel__btn property-panel__btn--primary" @click="openIndoorPlan">查看室内图纸</button>
      </div>
    </div>

    <!-- 楼宇详情弹窗 -->
    <div v-if="detailOpen && selectedProps.name" class="detail-modal" @click.self="detailOpen = false">
      <div
        class="detail-modal__card"
        :class="{ 'detail-modal__card--max': detailMaximized }"
        :style="{ transform: detailMaximized ? 'none' : `translate(${detailPos.x}px, ${detailPos.y}px)` }"
      >
        <div class="detail-modal__head" @mousedown="onDetailDragStart" title="按住头部可拖动窗口">
          <strong>{{ shownBuildingName() }} · 楼宇详情</strong>
          <button class="detail-modal__maxbtn" :title="detailMaximized ? '还原窗口' : '最大化窗口'" @click.stop="toggleDetailMax">
            {{ detailMaximized ? '❐' : '⛶' }}
          </button>
          <button class="property-panel__close" aria-label="关闭" @click="detailOpen = false">×</button>
        </div>

        <!-- Tab 导航 -->
        <div class="detail-modal__tabs">
          <button
            v-for="t in detailTabs"
            :key="t"
            class="detail-tab"
            :class="{ active: detailTab === t }"
            @click="onDetailTabClick(t)"
          >{{ t }}</button>
        </div>

        <div class="detail-modal__body">
          <!-- 基础信息：分块展示（基础信息 / 建筑信息 / 建造信息） -->
          <div v-if="detailTab === '基础信息'" class="detail-tabpane">
            <div v-if="selectedProps.image && !imageError" class="detail-modal__image">
              <img :src="selectedProps.image" :alt="selectedProps.name" @error="imageError = true" />
            </div>

            <section v-for="sec in detailSections" :key="sec.title" class="detail-block">
              <h4 class="detail-block__title"><span class="detail-block__bar"></span>{{ sec.title }}</h4>
              <dl class="detail-modal__grid" :class="{ 'detail-modal__grid--edit': detailEditing }">
                <div
                  v-for="f in sec.fields"
                  :key="f.key"
                  v-show="!(detailEditing && f.hideInEdit)"
                  class="detail-field"
                  :class="{ 'detail-field--wide': f.kind === 'textarea' }"
                >
                  <dt>
                    {{ f.label }}<em v-if="detailEditing && f.required" class="detail-req" title="必填">*</em>
                  </dt>
                  <dd>
                    <!-- 浏览态：统一只读展示 -->
                    <template v-if="!detailEditing">
                      <span class="detail-value">{{ detailFieldDisplay(f) }}</span>
                    </template>
                    <!-- 编辑态：固定（不可改，带标记） / 只读（不可改，无标记） -->
                    <template v-else-if="f.kind === 'fixed' || f.kind === 'readonly'">
                      <span class="detail-value detail-value--locked">{{ detailFieldDisplay(f) }}</span>
                      <span v-if="f.kind === 'fixed'" class="detail-field-tag">固定</span>
                    </template>
                    <!-- 编辑态：下拉（当前值不在预设里时补一项，避免回显空白） -->
                    <select
                      v-else-if="f.kind === 'select'"
                      v-model="detailDraft[f.key]"
                      class="detail-input"
                      :class="{ 'detail-input--error': detailErrorField === f.key }"
                    >
                      <option v-for="opt in detailSelectOptions(f)" :key="opt" :value="opt">{{ opt }}</option>
                    </select>
                    <!-- 编辑态：多行文本 -->
                    <textarea
                      v-else-if="f.kind === 'textarea'"
                      v-model="detailDraft[f.key]"
                      class="detail-input detail-textarea"
                      rows="2"
                      :class="{ 'detail-input--error': detailErrorField === f.key }"
                    ></textarea>
                    <!-- 编辑态：日期 -->
                    <input
                      v-else-if="f.kind === 'date'"
                      v-model="detailDraft[f.key]"
                      class="detail-input detail-input--date"
                      type="date"
                      placeholder="点击选择竣工日期"
                      @click="onDateInputClick"
                      :class="{ 'detail-input--error': detailErrorField === f.key }"
                    />
                    <!-- 编辑态：数字 / 文本 -->
                    <input
                      v-else
                      v-model="detailDraft[f.key]"
                      class="detail-input"
                      :type="f.kind === 'number' ? 'number' : 'text'"
                      :min="f.min"
                      :class="{ 'detail-input--error': detailErrorField === f.key }"
                    />
                  </dd>
                </div>
              </dl>
            </section>
          </div>

          <!-- 附件信息 -->
          <div v-else-if="detailTab === '附件信息'" class="detail-tabpane">
            <!-- 查询区：文件名搜索 + 类型筛选 + 导出清单 -->
            <div class="attach-toolbar">
              <input v-model="attachKeyword" class="attach-search" placeholder="搜索文件名…" />
              <select v-model="attachTypeFilter" class="attach-filter">
                <option value="">全部类型</option>
                <option v-for="t in attachTypeOptions" :key="t" :value="t">{{ t }}</option>
              </select>
              <button class="attach-reset" @click="resetAttachQuery">重置</button>
              <button class="attach-export" @click="exportAttachmentsExcel">导出清单</button>
            </div>
            <!-- 统计条 -->
            <div class="attach-stats">
              共 <b>{{ filteredAttachments.length }}</b> 个附件
              <template v-if="attachKeyword || attachTypeFilter">（从 {{ attachmentList.length }} 个中筛选）</template>
              <span class="attach-stats__sep">·</span>
              图片 {{ attachStats.img }} / 文档 {{ attachStats.doc }}
            </div>
            <!-- 字段列表格 -->
            <table class="attach-table">
              <thead>
                <tr>
                  <th class="attach-col-idx">序号</th>
                  <th>文件名称</th>
                  <th class="attach-col-type">附件分类</th>
                  <th class="attach-col-fmt">格式</th>
                  <th class="attach-col-size">大小</th>
                  <th class="attach-col-time">上传时间</th>
                  <th class="attach-col-op">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(a, i) in filteredAttachments" :key="a.name">
                  <td class="attach-idx">{{ i + 1 }}</td>
                  <td class="attach-name-cell">
                    <span class="attach-icon" :class="`attach-icon--${a.type}`">{{ a.type === 'img' ? '图' : '档' }}</span>
                    <span class="attach-name">{{ a.name }}</span>
                    <em v-if="a.sample" class="tag-sample">示例</em>
                  </td>
                  <td>{{ a.typeLabel }}</td>
                  <td>{{ a.format }}</td>
                  <td>{{ a.size }}</td>
                  <td>{{ a.time }}</td>
                  <td class="attach-ops">
                    <button class="attach-op" @click="previewAttachment(a)">预览</button>
                    <button class="attach-op attach-op--primary" @click="downloadAttachment(a)">下载</button>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-if="!filteredAttachments.length" class="tab-empty">没有匹配的附件</p>
            <!-- <p class="tab-note">示例附件为演示数据，正式文件由业务系统同步。</p> -->
          </div>

          <!-- 资产信息 -->
          <div v-else-if="detailTab === '资产信息'" class="detail-tabpane">
            <div class="asset-summary">
              <div><span>资产编码</span><b>{{ assetSummary.code }}</b></div>
              <div><span>资产类别</span><b>{{ assetSummary.category }}</b></div>
              <div><span>建筑原值</span><b>{{ assetSummary.original.toLocaleString() }} 元</b></div>
              <div><span>当前净值</span><b>{{ assetSummary.net.toLocaleString() }} 元</b></div>
              <div><span>折旧年限</span><b>{{ assetSummary.life }} 年</b></div>
              <div><span>使用状态</span><b>{{ assetSummary.status }}</b></div>
            </div>
            <p class="tab-note">资产台账对接中，金额为按建筑面积测算的示例值。</p>
          </div>

          <!-- 楼栋资产 -->
          <div v-else-if="detailTab === '楼栋资产'" class="detail-tabpane">
            <table class="asset-table">
              <thead><tr><th>资产大类</th><th>金额（元）</th><th>占比</th></tr></thead>
              <tbody>
                <tr v-for="row in buildingAssetRows" :key="row.name">
                  <td>{{ row.name }}</td>
                  <td>{{ row.amount.toLocaleString() }}</td>
                  <td>{{ row.percent }}%</td>
                </tr>
              </tbody>
            </table>
            <p class="tab-note">楼栋资产按大类拆分，金额为示例测算值。</p>
          </div>

          <!-- 楼层信息 -->
          <div v-else-if="detailTab === '楼层信息'" class="detail-tabpane">
            <table class="asset-table">
              <thead><tr><th>楼层</th><th>面积（㎡）</th><th>房间数</th><th>主要用途</th></tr></thead>
              <tbody>
                <tr v-for="f in floorRows" :key="f.floor">
                  <td>{{ f.floor }}F</td>
                  <td>{{ f.area.toLocaleString() }}</td>
                  <td>{{ f.rooms }}</td>
                  <td>{{ f.use }}</td>
                </tr>
              </tbody>
            </table>
            <p v-if="!floorRows.length" class="tab-empty">暂无楼层数据</p>
          </div>

          <!-- 变更记录 -->
          <div v-else-if="detailTab === '变更记录'" class="detail-tabpane">
            <ul class="change-list">
              <li v-for="(c, i) in changeRecords" :key="i" class="change-item">
                <span class="change-dot"></span>
                <div class="change-body">
                  <div class="change-top"><b>{{ c.type }}</b><span>{{ c.date }}</span></div>
                  <div class="change-desc">{{ c.desc }}</div>
                  <div class="change-by">经办：{{ c.by }}</div>
                </div>
              </li>
            </ul>
            <p class="tab-note">变更记录为示例数据，正式数据由资产系统同步。</p>
          </div>
        </div>

        <!-- 导出 Excel：固定在底部横线上方（不随内容滚动），仅基础信息页显示 -->
        <div v-if="detailTab === '基础信息'" class="detail-export-row">
          <button class="detail-footer-btn detail-footer-btn--export" @click="exportDetailExcel" title="导出当前楼宇基础信息为 Excel">导出 Excel</button>
        </div>

        <!-- 底部操作栏：关闭 / 修改居中排列，按钮之间留间隔 -->
        <div class="detail-modal__footer">
          <div class="detail-footer-actions">
            <button class="detail-footer-btn detail-footer-btn--close" @click="detailOpen = false">关闭</button>
            <template v-if="detailTab === '基础信息'">
              <button v-if="!detailEditing" class="detail-footer-btn detail-footer-btn--primary" @click="startDetailEdit">修改</button>
              <template v-else>
                <span v-if="detailError" class="detail-error">{{ detailError }}</span>
                <button class="detail-footer-btn" @click="cancelDetailEdit">取消</button>
                <button class="detail-footer-btn detail-footer-btn--primary" @click="saveDetailEdit">保存</button>
              </template>
            </template>
            <span v-else class="detail-footer-hint">该页数据由业务系统同步，仅供查看</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 房间管理面板：右侧停靠，宽 20%，无遮罩层 -->
    <div v-if="roomMgmtOpen && selectedProps.name" class="room-mgmt-modal">
      <div class="room-mgmt__card">
        <div class="room-mgmt__head">
          <strong>{{ selectedProps.name }} · 房间管理</strong>
          <button class="property-panel__close" aria-label="关闭" @click="roomMgmtOpen = false">×</button>
        </div>

        <!-- 状态汇总：使用中 / 无权限 / 空置 数量 -->
        <div class="room-mgmt__summary">
          <span
            v-for="s in ROOM_STATUS_ORDER"
            :key="s"
            class="room-mgmt__pill"
            :style="{ '--c': ROOM_STATUS_CONFIG[s].color, '--cd': ROOM_STATUS_CONFIG[s].deep }"
          >
            <i :style="{ background: ROOM_STATUS_CONFIG[s].color, borderColor: ROOM_STATUS_CONFIG[s].deep }"></i>
            {{ ROOM_STATUS_CONFIG[s].label }}
            <b>{{ roomMgmtCounts[s] }}</b>
          </span>
        </div>

        <!-- 全部楼层 + 对应房间（按楼层分区，分割线划分，整体可滚动） -->
        <div class="room-mgmt__body">
          <template v-if="roomMgmtByFloor.length">
            <section
              v-for="sec in roomMgmtByFloor"
              :key="sec.floor"
              class="room-mgmt__floor-section"
            >
              <div class="room-mgmt__floor-title">{{ sec.floor }}F</div>
              <div class="room-mgmt__grid">
                <div
                  v-for="room in sec.rooms"
                  :key="room.id"
                  class="room-mgmt__cell"
                  :style="{ '--c': ROOM_STATUS_CONFIG[room.status].color, '--cd': ROOM_STATUS_CONFIG[room.status].deep }"
                  :title="`${room.roomNo} · ${ROOM_STATUS_CONFIG[room.status].label}${room.roomName ? ' · ' + room.roomName : ''}`"
                >
                  <span class="room-mgmt__no">{{ room.roomNo }}</span>
                </div>
              </div>
            </section>
          </template>
          <p v-else class="tab-empty">该楼栋暂无房间数据</p>
        </div>
      </div>
    </div>

    <!-- 楼盘表面板（房间模式 / 分配模式共用） -->
    <div v-if="viewMode === 'room' || viewMode === 'allocate'" class="room-panel">
      <div class="room-panel__head">
        <span class="dot"></span>
        <strong>{{ roomBuilding?.name ?? '' }} · {{ viewMode === 'allocate' ? '房屋分配' : '楼盘表' }}</strong>
        <button v-if="viewMode === 'room'" class="room-panel__alloc" @click="enterAllocationMode">分配模式</button>
        <button class="room-panel__exit" @click="viewMode === 'allocate' ? exitAllocationMode() : exitRoomMode()">退出</button>
      </div>
      <div class="floor-switch">
        <button
          v-for="f in roomFloors"
          :key="f"
          class="floor-switch__btn"
          :class="{ active: f === currentFloor }"
          @click="switchFloor(f)"
        >
          {{ f }}F
        </button>
      </div>
      <div class="legend">
        <span v-for="s in ROOM_STATUS_ORDER" :key="s">
          <i :style="{ background: ROOM_STATUS_CONFIG[s].color, borderColor: ROOM_STATUS_CONFIG[s].deep }"></i>
          {{ ROOM_STATUS_CONFIG[s].label }}
        </span>
      </div>
    </div>

    <!-- 房间详情面板（仅房间模式）：锚定在被点击的房间格子旁 -->
    <div
      v-if="selectedRoom && viewMode === 'room'"
      ref="roomDetailEl"
      class="room-detail"
      :style="roomDetailPos"
    >
      <div class="room-detail__head">
        <strong>房间 {{ selectedRoom.roomNo }}</strong>
        <span class="room-detail__status" :style="{ color: roomStatusColor(selectedRoom) }">
          {{ roomStatusLabel(selectedRoom) }}
        </span>
        <button class="room-detail__close" aria-label="关闭" @click="selectedRoom = null">×</button>
      </div>
      <dl>
        <div><dt>楼层</dt><dd>{{ selectedRoom.floor }}F</dd></div>
        <div><dt>面积</dt><dd>{{ selectedRoom.area }} ㎡</dd></div>
        <div><dt>使用部门</dt><dd>{{ selectedRoom.department ?? '—' }}</dd></div>
        <div><dt>状态</dt><dd>{{ roomStatusLabel(selectedRoom) }}</dd></div>
      </dl>
      <p v-if="selectedRoom.remark" class="room-detail__desc">{{ selectedRoom.remark }}</p>
    </div>

    <!-- 房屋分配侧边栏 -->
    <AllocationPanel
      v-if="viewMode === 'allocate'"
      :rooms="selectedRooms"
      :total-area="totalArea"
      :submitting="allocating"
      :result-message="allocResultMessage"
      :result-type="allocResultType"
      @close="exitAllocationMode"
      @remove="removeSelectedRoom"
      @confirm="confirmAllocation"
    />

    <!-- 操作提示 -->
    <div class="hint-bar">
      <!-- 【待开发】原提示含「双击进入室内视角」，室内功能注释后已去掉；恢复时加回该短语 -->
      <template v-if="viewMode === 'scene'">点击模型拾取建筑 · 楼栋名称常驻显示 · 输入搜索定位</template>
      <template v-else-if="viewMode === 'room'">点击房间查看详情 · 切换楼层查看不同布局</template>
      <template v-else>点击房间选中（可跨楼层） · 右侧查看已选与总面积</template>
    </div>

    <!-- 打印/导出对话框 -->
    <ExportDialog v-if="exportOpen" :scene="scene" :title="exportTitle" @close="exportOpen = false" />

    <!-- 室内图纸：查看室内图纸的唯一对接点 -->
    <el-dialog v-model="indoorEmptyVisible" title="室内图纸" width="420px">
      <el-empty description="该楼尚未导入楼层平面图（DXF）" />
      <template #footer>
        <el-button type="primary" @click="openImportFromEmpty">导入图纸</el-button>
      </template>
    </el-dialog>

    <FloorPlan2D
      v-model="floorPlan2DVisible"
      :building-name="floorPlanBuilding"
      :fullscreen="true"
      @request-import="dxfImportVisible = true"
    />
    <DxfImport
      v-model="dxfImportVisible"
      :building-names="buildingNames"
      :default-building="floorPlanBuilding"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type Ref } from 'vue';
import * as THREE from 'three';
import { ElMessage } from 'element-plus';
import { loadAMap } from '../utils/loadAMap';
import { MapScene, type PickResult, type MeasureResult, type ModelStats } from '../core/MapScene';
import { DEFAULT_SCENE_CONFIG, type SceneConfig } from '../config/mapConfig';
import {
  SAMPLE_BUILDING_DATA,
  fetchBuildingData,
  BUILDING_CATEGORIES,
  OTHER_CATEGORY,
  resolveBizCategory,
  type BuildingDataMap,
  type BuildingProps,
} from '../data/buildingData';
import {
  SAMPLE_ROOM_DATA,
  fetchRoomData,
  ROOM_STATUS_CONFIG,
  ROOM_STATUS_ORDER,
  type Room,
  type RoomDataMap,
} from '../data/roomData';
import ExportDialog from './ExportDialog.vue';
import AllocationPanel from './AllocationPanel.vue';
import DxfImport from './DxfImport.vue';
import FloorPlan2D from './FloorPlan2D.vue';
import CampusStatsDialog from './CampusStatsDialog.vue';
import { useBuildingStore } from '../stores/building';
import { computeTotalArea, submitAllocation } from '../utils/allocation';

type Status = 'loading-amap' | 'loading-model' | 'ready' | 'error';

const mapContainer = ref<HTMLDivElement | null>(null);
const status = ref<Status>('loading-amap');
const errorMessage = ref('');
const keyConfigured = ref(false);
const modelProgress = ref(-1);
// 模型加载后处理阶段（解码贴图 / 优化贴图 / 检测损坏贴图…）：进度到 100% 后仍有
// 解析 + 贴图后处理 + 首帧准备等重活，低配机器上可达数十秒，必须显示当前步骤
// 避免「卡在 100%」的观感
const modelStage = ref('');
const modelStageDone = ref(0);
const modelStageTotal = ref(0);
const modelStageText = computed(() => {
  if (modelStage.value) {
    return modelStageTotal.value > 0
      ? `${modelStage.value} ${modelStageDone.value}/${modelStageTotal.value}`
      : modelStage.value;
  }
  // 下载完成后、首个阶段回调前的窗口期是 GLB 同步解析（含贴图解码）
  if (modelProgress.value >= 100) return '解析模型数据…';
  return '';
});

// 模型统计：onModelReady 后由 MapScene.getModelStats() 从当前 GLB 实时统计（用于触发按钮 v-if）。
// 详细统计已移到 CampusStatsDialog 弹窗，首页只保留一个触发按钮。
const modelStats = ref<ModelStats | null>(null);
const statsDialogOpen = ref(false);
const businessReady = ref(false); // buildings.geojson / rooms.geojson 是否都加载成功（防止把示例数据当真实数据展示）

const config: SceneConfig = DEFAULT_SCENE_CONFIG;
// 属性数据源：优先从 GeoJSON / 后端 API 读取，失败则回退到内置示例数据
// 楼宇详情「修改」的本地持久化：本地项目无后端，编辑结果存 localStorage，刷新后仍生效
const DETAIL_EDITS_KEY = 'hnjcxy_building_detail_edits';
type DetailEdits = Record<string, Record<string, unknown>>;
function loadStoredDetailEdits(): DetailEdits {
  try {
    const raw = localStorage.getItem(DETAIL_EDITS_KEY);
    return raw ? (JSON.parse(raw) as DetailEdits) : {};
  } catch {
    return {};
  }
}
function applyStoredDetailEdits(map: BuildingDataMap): BuildingDataMap {
  const edits = loadStoredDetailEdits();
  const out: BuildingDataMap = { ...map };
  for (const key of Object.keys(edits)) {
    if (out[key]) out[key] = { ...out[key], ...edits[key] };
  }
  return out;
}
const buildingData = ref<BuildingDataMap>(applyStoredDetailEdits(SAMPLE_BUILDING_DATA));
const roomData = ref<RoomDataMap>(SAMPLE_ROOM_DATA);

const hovered = ref<PickResult | null>(null);
const selected = ref<PickResult | null>(null);

const viewMode = ref<'scene' | 'room' | 'allocate'>('scene');
const roomBuilding = ref<{ name: string; object: THREE.Object3D } | null>(null);
const roomFloors = ref<number[]>([]);
const currentFloor = ref(1);
const selectedRoom = ref<Room | null>(null);

const isIndoorView = ref(false);
const exportOpen = ref(false);
const detailOpen = ref(false);
const detailMaximized = ref(false); // 楼宇详情弹窗最大化状态
function toggleDetailMax(): void {
  detailMaximized.value = !detailMaximized.value;
  if (detailMaximized.value) detailDragReset(); // 最大化时回到居中，避免带着旧偏移
}

// ---- 楼宇详情弹窗拖拽（仅拖动头部，整卡位移）----
const detailPos = reactive({ x: 0, y: 0 }); // 相对居中位置的偏移量（px）
let detailDrag: { startX: number; startY: number; originX: number; originY: number } | null = null;
function detailDragReset(): void {
  detailPos.x = 0;
  detailPos.y = 0;
}
function onDetailDragStart(e: MouseEvent): void {
  // 忽略关闭按钮等交互元素；最大化状态下不允许拖动
  if (detailMaximized.value || (e.target as HTMLElement)?.closest('button')) return;
  detailDrag = { startX: e.clientX, startY: e.clientY, originX: detailPos.x, originY: detailPos.y };
  window.addEventListener('mousemove', onDetailDragMove);
  window.addEventListener('mouseup', onDetailDragEnd);
}
function onDetailDragMove(e: MouseEvent): void {
  if (!detailDrag) return;
  detailPos.x = detailDrag.originX + (e.clientX - detailDrag.startX);
  detailPos.y = detailDrag.originY + (e.clientY - detailDrag.startY);
}
function onDetailDragEnd(): void {
  detailDrag = null;
  window.removeEventListener('mousemove', onDetailDragMove);
  window.removeEventListener('mouseup', onDetailDragEnd);
}

const detailTab = ref('基础信息'); // 楼宇详情弹窗当前 Tab（默认「基础信息」）
const imageError = ref(false);

// 房间管理弹窗状态
const roomMgmtOpen = ref(false);

// 楼层平面图（DXF 导入 + 2.5D 查看）——新增 building store（不动原 building store）
const buildingStore = useBuildingStore();
const floorPlan2DVisible = ref(false);
const dxfImportVisible = ref(false);
const indoorEmptyVisible = ref(false);
const floorPlanBuilding = ref('');
const buildingNames = computed(() => Object.keys(buildingData.value));

// 把当前生效的楼栋属性表注入 building store（指纹写回目标）
watch(buildingData, (m) => buildingStore.setBuildingMap(m), { immediate: true });

/** 真实楼栋主键（用于查楼层图 / 取属性数据）：把模型数字节点经别名 / 经纬度归并到 buildingData 里的楼栋名。
 * 显示名仍用 selected.value.name（数字节点，如 15），本值仅作数据查找键——两者解耦，
 * 既满足「点击建筑显示数字节点」，又不破坏「查看图纸 / 属性数据」的匹配。 */
const selectedKey = computed(() =>
  selected.value ? resolveBuildingName(selected.value.name, selected.value.lngLat) : '',
);

/** 唯一对接点：点楼弹窗里的【查看室内图纸】
 *  - 已有 Floor 数据 → 打开 2.5D 查看器
 *  - 无数据 → 空态引导，点【导入图纸】打开 DxfImport */
function openIndoorPlan() {
  if (!selected.value?.name) return;
  floorPlanBuilding.value = selectedKey.value;
  if (buildingStore.hasFloors(selectedKey.value)) {
    floorPlan2DVisible.value = true;
  } else {
    indoorEmptyVisible.value = true;
  }
}

function openImportFromEmpty() {
  if (!selected.value?.name) return;
  floorPlanBuilding.value = selectedKey.value;
  indoorEmptyVisible.value = false;
  dxfImportVisible.value = true;
}

/**
 * 把模型/搜索返回的「节点名」反查成 buildingData 里的真实楼栋名。
 * 替换后的真实 GLB 节点命名（RoofShed_Rig / 63 / Parapet_Obj5…）并不等于楼栋名，
 * 直接拿它去 floorsOf / 属性面板查找必然落空，这就是「上传 DXF 后查不到楼层图」的根因。
 * 反查优先级：① 已是 buildingData 键 → 直接用；② 命中手动别名表；③ 有经纬度 → 取已导入楼栋
 * 指纹中心（centerGcj02）最近者（导入 DXF 后才有指纹，故仅对已导入楼栋生效）。
 */
function resolveBuildingName(raw: string, lngLat?: [number, number]): string {
  if (!raw) return raw;
  const names = buildingStore.buildingNames;
  if (names.includes(raw)) return raw;
  const alias = DEFAULT_SCENE_CONFIG.buildingNameAliases[raw];
  if (alias && names.includes(alias)) return alias;
  if (lngLat) {
    let best = raw;
    let bestD = Infinity;
    for (const bn of names) {
      const c = buildingStore.buildingFingerprint(bn).centerGcj02;
      if (!c) continue;
      const d = Math.hypot(lngLat[0] - c[0], lngLat[1] - c[1]); // 度，仅做相对比较
      if (d < bestD) {
        bestD = d;
        best = bn;
      }
    }
    if (bestD < 0.015) return best; // 约 1.5km 内视为同一楼栋
  }
  return raw;
}

/** 楼栋显示名：GLB 节点数字(0–25) → 真实楼名（取 buildingNameAliases），未配置则原样返回数字。
 * 仅用于「界面展示」（搜索下拉 / 悬停 / 属性面板标题），与数据查找键(selectedKey)解耦，可安全替换。 */
function displayName(raw: string): string {
  if (!raw) return raw;
  return DEFAULT_SCENE_CONFIG.buildingNameAliases[raw] ?? raw;
}

// 分配模式状态
const selectedRooms = ref<Room[]>([]);
const allocating = ref(false);
const allocResultMessage = ref<string | null>(null);
const allocResultType = ref<'success' | 'error' | null>(null);

const searchQuery = ref('');
const searchFocused = ref(false);
// 「未找到楼栋」提示状态：searchError 为回车确认后仍未匹配到的关键词。
// 与一次性 toast 不同，它会一直留在搜索框下方，直到输入变化 / 选中楼栋 / 手动清除。
const searchError = ref<string | null>(null);
const searchAlertDismissed = ref(false); // 手动关闭后不再反复弹出中性提示，直到关键词变化
const searchAlertKey = ref(0); // 每次回车重挂载提示，重新播放一次入场动画
const searchInputRef = ref<HTMLInputElement | null>(null);
const objectList = ref<Array<{ name: string; lngLat: [number, number]; object: THREE.Object3D }>>([]);

let scene: MapScene | null = null;

// 视图 / 量算 UI 状态
// 2D 入口已按需求移除。
// 2.5D / 室内：功能暂未开发，入口全部禁用/注释，只在工具栏下方保留「（待开发）」置灰占位按钮，
// 让用户知道有此规划。类型与 MapScene.setMapView() 的 35° 分支、enterIndoorView() 等底层实现均保留，便于恢复。
// 恢复 2.5D：删除 setView() 中的 `if (mode === '2.5d') return;`，并按模板占位条注释把按钮接回「视图」组。
// 恢复室内：取消 toggleIndoor() / handleDoubleClick() / onDoubleClick 注册 / ESC 分支 / badge 的注释。
// 恢复 2D：在工具栏加回 `setView('2d')` 按钮、把此处类型加回 '2d'，
// 并在 MapScene.setMapView() 里加回 pitch=0 / rotation=0 的分支。
const currentView = ref<'2.5d' | '3d'>('3d');
const rotateMode = ref(false); // 工具栏「旋转」模式：左键拖动直接旋转视角
const compassRotation = ref(0); // 罗盘指针角度（=地图 bearing），随 onViewChange 实时刷新
const compassDragging = ref(false); // 正在拖动罗盘（用于指针样式）
const measureActive = ref(false); // 是否正在打点测量中（控制「完成」按钮显隐）
const measureTool = ref<'none' | 'distance' | 'area'>('none'); // 已选中的量算工具（高亮，清除前保持）
const measureResult = ref<MeasureResult | null>(null);

/** 测量引导条主文案：随已打点数变化，始终说明「下一步做什么 / 何时可以结束」，
 *  避免用户只看到隐蔽的双击提示而不知道如何收尾。 */
const measureGuideText = computed(() => {
  const pts = measureResult.value?.points ?? 0;
  const isArea = measureTool.value === 'area';
  if (pts === 0) {
    return isArea ? '在地图上连续点击打点，至少 3 个点围成面' : '在地图上连续点击打点，至少 2 个点连成线';
  }
  if (isArea && pts < 3) return `已打 ${pts} 个点，还需 ${3 - pts} 个点才能围成面`;
  if (!isArea && pts < 2) return `已打 ${pts} 个点，再点 1 个点即可连成线`;
  return `已打 ${pts} 个点，现在可以点「完成测量」结束`;
});

// ---------------------------------------------------------------------------
// 浮层锚定：弹窗显示在被点击的「模型节点」位置，而不是固定右下角
// ---------------------------------------------------------------------------
/** 外层容器（计算边界、做边缘夹紧） */
const shellRef = ref<HTMLDivElement | null>(null);
/** 属性面板 / 房间详情 DOM（用于测量真实尺寸，实现边缘自动翻转） */
const panelEl = ref<HTMLElement | null>(null);
const roomDetailEl = ref<HTMLElement | null>(null);

/** 浮层与节点之间的间距（px），保持「紧挨着节点」的观感 */
const ANCHOR_GAP = 14;
/** 浮层与容器边缘的最小留白（px） */
const EDGE_MARGIN = 12;

/** 容器尺寸（窗口 resize 时刷新） */
const containerSize = ref({ w: 0, h: 0 });

function readContainerSize() {
  const el = shellRef.value;
  containerSize.value = {
    w: el?.clientWidth || window.innerWidth,
    h: el?.clientHeight || window.innerHeight,
  };
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const toStyle = (p: { left: number; top: number }) => ({
  left: `${Math.round(p.left)}px`,
  top: `${Math.round(p.top)}px`,
});

/**
 * 创建「贴着节点显示」的面板定位。
 * 默认显示在节点右下方，空间不足时自动翻到左侧 / 上方，并夹紧在容器内。
 */
function createAnchoredPanel(
  elRef: Ref<HTMLElement | null>,
  anchorRef: Ref<{ x: number; y: number } | null>,
) {
  const size = ref({ w: 300, h: 240 });

  /** 面板内容变化后调用：等 DOM 更新完测量真实尺寸 */
  function measure() {
    readContainerSize();
    nextTick(() => {
      const el = elRef.value;
      if (!el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w && h) size.value = { w, h };
    });
  }

  const style = computed(() => {
    // 容器尺寸兜底：读不到时用视口尺寸，避免算出 (0,0) 导致浮层被夹到页面左上角
    const cw = containerSize.value.w || window.innerWidth;
    const ch = containerSize.value.h || window.innerHeight;
    const a = anchorRef.value;
    const m = EDGE_MARGIN;

    // 无锚点时的兜底：贴右侧居中
    if (!a) {
      return toStyle({
        left: Math.max(m, cw - size.value.w - m),
        top: Math.max(m, (ch - size.value.h) / 2),
      });
    }

    // 默认显示在节点「左上方」，紧挨着节点；
    // 左侧/上方空间不足时翻到节点右侧/下方，再夹紧在容器内。
    let left = a.x - ANCHOR_GAP - size.value.w;
    let top = a.y - ANCHOR_GAP - size.value.h;
    if (left < m) left = a.x + ANCHOR_GAP;
    if (top < m) top = a.y + ANCHOR_GAP;

    return toStyle({
      left: clamp(left, m, Math.max(m, cw - size.value.w - m)),
      top: clamp(top, m, Math.max(m, ch - size.value.h - m)),
    });
  });

  return { style, measure };
}

// ---------------------------------------------------------------------------
// 量算结果：锚定到「测绘范围」内（图形质心 / 折线中点），而不是固定右下角
// ---------------------------------------------------------------------------
type MeasureAnchor = {
  x: number; y: number;
  minX: number; minY: number; maxX: number; maxY: number;
};
const measureAnchor = ref<MeasureAnchor | null>(null);
const measurePanelEl = ref<HTMLElement | null>(null);
const measurePanelSize = ref({ w: 236, h: 150 });

/** 卡片内容变化（点数 / 分段 / 状态）后重测真实尺寸，定位才算得准 */
watch([measureResult, measureActive], () => {
  nextTick(() => {
    const el = measurePanelEl.value;
    if (el && el.offsetWidth && el.offsetHeight) {
      measurePanelSize.value = { w: el.offsetWidth, h: el.offsetHeight };
    }
  });
}, { flush: 'post' });

/** 锚点小圆点：明确指示这张卡片对应哪一处测绘图形 */
const measureAnchorStyle = computed(() => {
  const a = measureAnchor.value;
  return a ? { left: `${Math.round(a.x)}px`, top: `${Math.round(a.y)}px` } : {};
});

/** 卡片定位：测面尽量夹在图形包围盒内；测距放到折线中点上方、横向仍贴着测绘范围 */
const measurePanelStyle = computed(() => {
  const cw = containerSize.value.w || window.innerWidth;
  const ch = containerSize.value.h || window.innerHeight;
  const m = EDGE_MARGIN;
  const { w, h } = measurePanelSize.value;
  const a = measureAnchor.value;
  // 拿不到锚点时兜底回右下角，避免卡片消失
  if (!a) return toStyle({ left: Math.max(m, cw - w - m), top: Math.max(m, ch - h - m) });

  const isArea = measureResult.value?.mode === 'area';
  const pad = 24;
  const minL = Math.max(m, a.minX - pad);
  const maxL = Math.min(cw - w - m, a.maxX + pad - w);
  const minT = Math.max(m, a.minY - pad);
  const maxT = Math.min(ch - h - m, a.maxY + pad - h);
  let left = a.x - w / 2;
  if (maxL >= minL) left = clamp(left, minL, maxL);
  else left = clamp(left, m, Math.max(m, cw - w - m));

  let top: number;
  if (isArea) {
    // 测面：卡片中心对准质心，并尽量夹在图形包围盒内
    top = a.y - h / 2;
    if (maxT >= minT) top = clamp(top, minT, maxT);
    else top = clamp(top, m, Math.max(m, ch - h - m));
  } else {
    // 测距：整块卡片放到折线包围盒上方，避免压住量出来的线；
    // 上方空间不够时改放下方，最后统一夹紧到容器内
    const above = a.minY - h - 16;
    top = above >= m ? above : a.maxY + 16;
    top = clamp(top, m, Math.max(m, ch - h - m));
  }
  return toStyle({ left, top });
});

/** 被点击节点在容器内的像素坐标（面板 / 房间详情各一份） */
const panelAnchor = ref<{ x: number; y: number } | null>(null);
const roomAnchor = ref<{ x: number; y: number } | null>(null);

const panel = createAnchoredPanel(panelEl, panelAnchor);
/**
 * 属性面板拖拽后的自由位置（相对容器像素）。非空时覆盖锚点定位、面板固定在屏幕上，
 * 不再随地图移动而跟随节点；切换楼栋 / 关闭面板时清空，恢复自动锚定。
 */
const panelFreePos = ref<{ left: number; top: number } | null>(null);
const panelPos = computed(() =>
  panelFreePos.value ? toStyle(panelFreePos.value) : panel.style.value,
);
watch(selected, () => { panelFreePos.value = null; }); // 点新楼：回到锚定位置

// 属性面板标题栏拖拽：以面板当前的真实位置为起点，拖到哪固定在哪，并夹取在容器内。
// 用 window 级指针事件，鼠标移出标题栏也能继续拖；控件（定位/关闭按钮）上不触发。
let panelDrag: { sx: number; sy: number; left: number; top: number } | null = null;
function onPanelDragStart(e: PointerEvent): void {
  if ((e.target as HTMLElement)?.closest('button')) return;
  const el = panelEl.value;
  if (!el) return;
  panelDrag = { sx: e.clientX, sy: e.clientY, left: el.offsetLeft, top: el.offsetTop };
  window.addEventListener('pointermove', onPanelDragMove);
  window.addEventListener('pointerup', onPanelDragEnd);
  window.addEventListener('pointercancel', onPanelDragEnd);
  e.preventDefault(); // 拖动时不要选中标题文字
}
function onPanelDragMove(e: PointerEvent): void {
  if (!panelDrag) return;
  const cw = containerSize.value.w || window.innerWidth;
  const ch = containerSize.value.h || window.innerHeight;
  const el = panelEl.value;
  const w = el?.offsetWidth ?? 322;
  const h = el?.offsetHeight ?? 240;
  const m = EDGE_MARGIN;
  panelFreePos.value = {
    left: clamp(panelDrag.left + e.clientX - panelDrag.sx, m, Math.max(m, cw - w - m)),
    top: clamp(panelDrag.top + e.clientY - panelDrag.sy, m, Math.max(m, ch - h - m)),
  };
}
function onPanelDragEnd(): void {
  panelDrag = null;
  window.removeEventListener('pointermove', onPanelDragMove);
  window.removeEventListener('pointerup', onPanelDragEnd);
  window.removeEventListener('pointercancel', onPanelDragEnd);
}

const roomDetail = createAnchoredPanel(roomDetailEl, roomAnchor);
const roomDetailPos = roomDetail.style;

/** 锚点标记：指示浮层指向的模型节点 */
const anchorDot = computed(() => {
  if (selected.value && viewMode.value === 'scene') return panelAnchor.value;
  if (selectedRoom.value && viewMode.value === 'room') return roomAnchor.value;
  return null;
});

/** 悬停 tooltip 位置（贴光标，靠近边缘时自动翻转） */
const tooltipStyle = computed(() => {
  const h = hovered.value;
  if (!h) return {};
  const { w: cw, h: ch } = containerSize.value;
  // 粗略估算气泡尺寸（中文约 13px/字），用于判断是否需要翻转
  const estW = Math.min(280, (h.name.length + 6) * 13);
  const estH = 30;
  const flipX = h.screenX + 14 + estW > cw;
  const flipY = h.screenY + 14 + estH > ch;
  return {
    left: `${h.screenX + (flipX ? -14 : 14)}px`,
    top: `${h.screenY + (flipY ? -14 : 14)}px`,
    transform: `translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})`,
  };
});

/** 视角变化（拖拽/缩放/旋转/飞行）后重新投影锚点，让浮层跟随节点 */
function updateAnchors() {
  if (!scene) return;
  // 防抖：仅当投影位置实际移动超过 0.5px 才写入响应式 ref，
  // 避免视角静止时（onViewChange 仍可能偶发触发）每帧无谓地引发 Vue 重渲染。
  if (selected.value) {
    const pos = scene.projectToScreen(selected.value.point);
    if (pos && (!panelAnchor.value ||
      Math.abs(panelAnchor.value.x - pos.x) > 0.5 ||
      Math.abs(panelAnchor.value.y - pos.y) > 0.5)) {
      panelAnchor.value = pos;
    }
  }
  if (selectedRoom.value) {
    const pos = scene.getRoomScreenPos(selectedRoom.value.id);
    if (pos && (!roomAnchor.value ||
      Math.abs(roomAnchor.value.x - pos.x) > 0.5 ||
      Math.abs(roomAnchor.value.y - pos.y) > 0.5)) {
      roomAnchor.value = pos;
    }
  }
  // 量算结果卡片：图形变了或视角变了都重新投影，保证卡片一直跟着测绘范围
  if (measureResult.value) {
    const a = scene.getMeasureAnchor();
    const p = measureAnchor.value;
    if (!a) {
      // 图形整体跑出视野时退回右下角兜底位置，不留一个飘在旧位置的卡片
      if (p) measureAnchor.value = null;
    } else if (!p ||
      Math.abs(p.x - a.x) > 0.5 || Math.abs(p.y - a.y) > 0.5 ||
      Math.abs(p.minX - a.minX) > 0.5 || Math.abs(p.maxX - a.maxX) > 0.5 ||
      Math.abs(p.minY - a.minY) > 0.5 || Math.abs(p.maxY - a.maxY) > 0.5) {
      measureAnchor.value = a;
    }
  } else if (measureAnchor.value) {
    measureAnchor.value = null;
  }
}

function onWindowResize() {
  readContainerSize();
  updateAnchors();
  scene?.onResize();
}

/** 开发态诊断：输出锚点与容器尺寸，便于排查浮层定位问题（生产构建不输出） */
function debugAnchor(label: string) {
  if (!import.meta.env.DEV) return;
  console.debug(
    `[浮层锚定] ${label}`,
    '节点屏幕坐标 =',
    panelAnchor.value ?? roomAnchor.value,
    '容器尺寸 =',
    containerSize.value,
  );
}

/** 容器尺寸变化监听（窗口 resize + 布局变化都覆盖） */
let shellObserver: ResizeObserver | null = null;

function observeContainer() {
  readContainerSize();
  window.addEventListener('resize', onWindowResize);
  if (typeof ResizeObserver !== 'undefined' && shellRef.value) {
    shellObserver = new ResizeObserver(() => {
      readContainerSize();
      updateAnchors();
    });
    shellObserver.observe(shellRef.value);
  }
}

function unobserveContainer() {
  window.removeEventListener('resize', onWindowResize);
  shellObserver?.disconnect();
  shellObserver = null;
}

const filteredObjects = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return [];
  const list = objectList.value.filter(
    (o) => o.name.toLowerCase().includes(q) || displayName(o.name).toLowerCase().includes(q),
  );
  // 精确匹配 / 前缀匹配优先排在前面，避免输入「0」时回车误选「10」「20」等楼栋
  list.sort((a, b) => {
    const rank = (s: string): number => {
      const n = s.toLowerCase();
      if (n === q) return 0;
      if (n.startsWith(q)) return 1;
      return 2;
    };
    // 节点号与显示名都参与排序，直接用楼名搜索时精确命中项才会排第一
    const rankOf = (o: { name: string }) => Math.min(rank(o.name), rank(displayName(o.name)));
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  return list.slice(0, 10);
});

/** 聚焦输入但零匹配：即时给反馈，避免下拉列表「凭空消失」让人以为搜索没反应 */
const showNoResult = computed(() =>
  !searchError.value &&
  !searchAlertDismissed.value &&
  searchFocused.value &&
  searchQuery.value.trim().length > 0 &&
  filteredObjects.value.length === 0,
);

/** 无结果时给 3 个真实存在、可直接点选的楼名（取自当前 GLB 楼栋列表，不使用示例数据） */
const searchSuggestions = computed(() => {
  const all = objectList.value.map((o) => ({ name: o.name, label: displayName(o.name) }));
  const picks: Array<{ name: string; label: string }> = [];
  const push = (x: { name: string; label: string }) => {
    if (picks.length < 3 && !picks.some((p) => p.label === x.label)) picks.push(x);
  };
  for (const key of ['教学楼', '图书馆', '搏击馆', '食堂', '宿舍楼']) {
    const hit = all.find((x) => x.label.includes(key));
    if (hit) push(hit);
  }
  for (const x of all) {
    if (picks.length >= 3) break;
    if (!/^\d+(?:\.\d+)?$/.test(x.label)) push(x);
  }
  return picks;
});

/**
 * 模型节点名 → 业务楼栋名（buildings.geojson 里的 6 个中文名）。
 * 点模型时 selectedKey 是数字节点名（如 "0"/"18"），而六项业务属性挂在中文名下，
 * 直接 buildingData[selectedKey] 必然落空、弹窗六个字段全是「—」。
 * 这里按「别名表 → 类别归并」把节点名映射到业务楼栋名，让点击任意一栋都能对上数据。
 * geojson 未录入的楼（模拟法庭/办公楼等）返回原 key，保持显示「—」而不误挂别栋数据。
 */
function toBusinessBuildingName(nodeName?: string): string {
  if (!nodeName) return '';
  const displayed = displayName(nodeName); // '教学楼 (18)' / '图书馆' / '18'
  // 只认「带业务字段」的记录：registerBuildings 会把数字节点登记成 {name:'0'} 空记录，
  // 若仅按 key 存在判断会命中空记录而错失真正的中文楼栋数据。
  const hasBiz = (name: string): boolean => {
    const p = buildingData.value[name];
    return !!p && (p.campus != null || p.managementDept != null || p.totalFloors != null ||
      p.buildingArea != null || p.usableArea != null || p.roomCount != null);
  };
  // ① 直接命中带业务字段的名字（点的是中文名时）
  if (hasBiz(nodeName)) return nodeName;
  if (hasBiz(displayed)) return displayed;
  // ② 去掉「 (节点号)」后缀后命中，如 '教学楼 (18)' → '教学楼'
  const noSuffix = displayed.replace(/\s*\(\d+\)\s*$/, '').trim();
  if (hasBiz(noSuffix)) return noSuffix;
  // ③ 类别归并到 geojson 的楼栋名（别名不含编号，按关键字兜底）
  const RULES: Array<[RegExp, string]> = [
    [/教学楼/, '教学楼'],
    [/图书/, '图书馆'],
    [/食堂/, '食堂'],
    [/宿舍|学生公寓/, '学生公寓'],
    [/体育馆|游泳|射击|搏击|警体|训练馆/, '警体综合训练馆'],
    [/实验|实训/, '实验楼'],
  ];
  for (const [re, target] of RULES) {
    if (re.test(displayed) && hasBiz(target)) return target;
  }
  return nodeName;
}

const selectedProps = computed<BuildingProps>(() => {
  if (!selected.value) return { name: '' };
  // 业务字段按归并楼栋名取（教学楼(18) → '教学楼'），命中 geojson 六项真实数据
  const bizName = toBusinessBuildingName(selectedKey.value);
  const base = buildingData.value[bizName] ?? buildingData.value[selectedKey.value];
  const height = base?.height ?? estimateHeight(selected.value.target);
  // 总层数 / 房间数：优先取属性数据，缺失时从房间数据回推（房间也按归并名查，口径一致）
  const rooms = roomsOf(bizName);
  const totalFloors = base?.totalFloors ?? (rooms.length ? Math.max(...rooms.map((r) => r.floor)) : undefined);
  const roomCount = base?.roomCount ?? (rooms.length ? rooms.length : undefined);
  return { ...(base ?? {}), name: displayName(selected.value.name), height, totalFloors, roomCount };
});

const categoryLabel = (c?: string) =>
  ({ building: '建筑', road: '道路', water: '水系', other: '其他' } as Record<string, string>)[c ?? 'other'] ?? '其他';

// ---------------------------------------------------------------------------
// 首页「校园建筑概览」：业务口径（楼栋 / 楼层 / 房间 / 面积），
// 全部由 buildingData、roomData、objectList 实时聚合，不写死任何数值。
// 注意：模型楼栋数（GLB 真实节点）与已录入业务楼栋数是两个不同口径，界面分别标注，
// 不把 6 栋的面积说成全校 26 栋的面积。
// ---------------------------------------------------------------------------
function classifyBuilding(raw: string): string {
  const n = displayName(raw);
  if (n.includes('教学楼')) return '教学楼';
  if (n.includes('宿舍')) return '宿舍楼';
  if (n.includes('模拟街区')) return '模拟街区';
  if (n.includes('食堂')) return '食堂';
  if (/体育馆|游泳馆|射击馆|搏击馆|琴剑楼/.test(n)) return '场馆';
  return '其他';
}

const buildingOverview = computed(() => {
  // buildingStore.registerBuildings() 会把 GLB 的 26 个数字节点作为「空属性记录」
  // 登记进 buildingData（供 DXF 归属候选使用），它们不是业务楼栋，必须排除：
  // 只统计带有层数 / 面积 / 房间数等真实业务字段的记录。
  const props = Object.values(buildingData.value).filter(
    (p) => (p.category ?? 'building') === 'building' &&
      (p.totalFloors != null || p.buildingArea != null || p.roomCount != null || p.usableArea != null),
  );
  const rooms = Object.values(roomData.value).flat();

  const floorMap = new Map<number, number>();
  const roomByBuilding = new Map<string, number>();
  const statusMap = new Map<string, number>();
  for (const r of rooms) {
    floorMap.set(r.floor, (floorMap.get(r.floor) ?? 0) + 1);
    roomByBuilding.set(r.building, (roomByBuilding.get(r.building) ?? 0) + 1);
    statusMap.set(r.status, (statusMap.get(r.status) ?? 0) + 1);
  }
  const floors = [...floorMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([floor, count]) => ({ floor, count }));

  const status = ROOM_STATUS_ORDER.filter((k) => (statusMap.get(k) ?? 0) > 0).map((k) => ({
    key: k,
    label: ROOM_STATUS_CONFIG[k].label,
    color: ROOM_STATUS_CONFIG[k].deep,
    count: statusMap.get(k) ?? 0,
  }));

  const details = props.map((p) => ({
    name: p.name,
    floors: p.totalFloors ?? null,
    area: p.buildingArea ?? null,
    rooms: roomByBuilding.get(p.name) ?? p.roomCount ?? 0,
    dept: (p.department as string) ?? '',
  }));

  const typeMap = new Map<string, number>();
  for (const o of objectList.value) {
    const t = classifyBuilding(o.name);
    typeMap.set(t, (typeMap.get(t) ?? 0) + 1);
  }
  const typesText = [...typeMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${t} ${n}`)
    .join(' · ');

  return {
    modelBuildings: objectList.value.length,
    recordedBuildings: props.length,
    totalFloors: props.reduce((s, p) => s + (Number(p.totalFloors) || 0), 0),
    buildingArea: props.reduce((s, p) => s + (Number(p.buildingArea) || 0), 0),
    usableArea: props.reduce((s, p) => s + (Number(p.usableArea) || 0), 0),
    roomTotal: rooms.length,
    roomArea: rooms.reduce((s, r) => s + (Number(r.area) || 0), 0),
    floors,
    maxFloorCount: Math.max(1, ...floors.map((f) => f.count)),
    status,
    details,
    typesText,
  };
});

/**
 * 按建筑名查找房间列表（容错版）。
 * 兼容：精确匹配 → 去空格匹配 → 大小写不敏感匹配 → 包含关系模糊匹配
 * （例如模型节点名 "一号教学楼" / "教学大楼" / "TeachingBuilding" 也能命中数据主键 "教学楼"）。
 */
function roomsOf(name?: string): Room[] {
  if (!name) return [];
  const key = String(name).trim();
  if (roomData.value[key]) return roomData.value[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(roomData.value)) {
    const kl = k.toLowerCase();
    if (kl === lower) return roomData.value[k];
    if (kl.includes(lower) || lower.includes(kl)) return roomData.value[k];
  }
  return [];
}

const roomStatusLabel = (room?: Room): string =>
  room ? (ROOM_STATUS_CONFIG[room.status]?.label ?? '') : '';

const roomStatusColor = (room?: Room): string =>
  room ? (ROOM_STATUS_CONFIG[room.status]?.deep ?? '#888') : '#888';

function estimateHeight(obj: THREE.Object3D): string {
  const box = new THREE.Box3().setFromObject(obj);
  // 地图 customCoords 空间为 Z-up，建筑高度取 Z 轴方向跨度
  const h = box.max.z - box.min.z;
  if (h > 0) return `${h.toFixed(1)} m`;
  return '';
}

function closePanel() {
  selected.value = null;
  panelAnchor.value = null;
  detailOpen.value = false;
  cancelDetailEdit();
  imageError.value = false;
  roomMgmtOpen.value = false; // 关闭属性面板时一并关闭房间管理面板
  scene?.clearHighlight();
}

function flyToSelected() {
  if (selected.value) scene?.flyToObjectCenter(selected.value.target);
}

function openBuildingDetail() {
  detailTab.value = '基础信息'; // 默认展示「基础信息」
  detailMaximized.value = false; // 每次打开恢复默认窗口大小
  cancelDetailEdit(); // 每次打开均回到浏览态
  imageError.value = false;
  roomMgmtOpen.value = false; // 与房间管理抽屉互斥，避免两个大面板同时铺满屏幕
  detailDragReset(); // 每次打开恢复初始居中位置
  detailOpen.value = true;
}

// ---------------------------------------------------------------------------
// 房间管理弹窗：按楼层展示房间号与状态（使用中 / 无权限 / 空置）
// ---------------------------------------------------------------------------
/** 当前选中楼栋的全部房间 */
const roomMgmtAllRooms = computed<Room[]>(() => {
  return roomsOf(selectedProps.value.name);
});

/** 该楼栋涉及的所有楼层（升序） */
const roomMgmtFloors = computed<number[]>(() => {
  const set = new Set(roomMgmtAllRooms.value.map((r) => r.floor));
  return [...set].sort((a, b) => a - b);
});

/** 三种状态的数量汇总 */
const roomMgmtCounts = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = { occupied: 0, noaccess: 0, vacant: 0 };
  for (const r of roomMgmtAllRooms.value) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return counts;
});

/** 按楼层分组（升序），每层包含按房间号排序的房间，用于一次性展示全部楼层 */
const roomMgmtByFloor = computed<{ floor: number; rooms: Room[] }[]>(() => {
  return roomMgmtFloors.value.map((f) => ({
    floor: f,
    rooms: roomMgmtAllRooms.value
      .filter((r) => r.floor === f)
      .sort((a, b) => a.roomNo.localeCompare(b.roomNo, undefined, { numeric: true })),
  }));
});

function openRoomManagement() {
  detailOpen.value = false; // 与楼宇详情弹窗互斥
  roomMgmtOpen.value = true;
}

// ---------------------------------------------------------------------------
// 楼宇详情 Tab：基础信息 / 附件信息 / 资产信息 / 楼栋资产 / 楼层信息 / 变更记录
// ---------------------------------------------------------------------------
const detailTabs = ['基础信息', '附件信息', '资产信息', '楼栋资产', '楼层信息', '变更记录'] as const;

// ---------------------------------------------------------------------------
// 基础信息分块字段定义 + 修改模式
// 字段类型：fixed 固定（主键）/ readonly 只读 / select 下拉 / text|number|textarea 可编辑
// required 必填保存时校验；编辑结果写回 buildingData 并同步 localStorage
// ---------------------------------------------------------------------------
type DetailFieldKind = 'fixed' | 'readonly' | 'select' | 'text' | 'number' | 'date' | 'textarea';
interface DetailFieldDef {
  key: string;
  label: string;
  kind: DetailFieldKind;
  required?: boolean;
  options?: string[];
  unit?: string;
  min?: number;
  /** 编辑态隐藏（浏览态仍展示），用于无业务意义的字段 */
  hideInEdit?: boolean;
}
interface DetailSectionDef { title: string; fields: DetailFieldDef[] }

/** 管理部门 / 使用部门下拉选项：内置常见部门 + 数据中已有部门 */
const DEPARTMENT_OPTIONS = [
  '教务处', '实验实训中心', '图书馆', '警体部', '后勤保障', '后勤保障处', '学生工作处', '基建处', '资产管理处',
];

const detailSections: DetailSectionDef[] = [
  {
    title: '基础信息',
    fields: [
      { key: 'name', label: '楼宇名称', kind: 'text', required: true },
      { key: 'campus', label: '所在校区', kind: 'select', options: ['主校区', '东校区', '西校区'], required: true },
      { key: 'bizCategoryLabel', label: '楼宇类型', kind: 'select', options: [...BUILDING_CATEGORIES, OTHER_CATEGORY].map((c) => c.label), required: true },
      { key: 'managementDept', label: '管理部门', kind: 'select', options: DEPARTMENT_OPTIONS, required: true },
      { key: 'department', label: '使用部门', kind: 'select', options: DEPARTMENT_OPTIONS },
      { key: 'lngLat', label: '经纬度', kind: 'readonly' },
      { key: 'description', label: '备注', kind: 'textarea' },
    ],
  },
  {
    title: '建筑信息',
    fields: [
      { key: 'totalFloors', label: '总层数', kind: 'number', required: true, unit: '层', min: 1 },
      { key: 'buildingArea', label: '建筑面积', kind: 'number', required: true, unit: '㎡', min: 0 },
      { key: 'usableArea', label: '使用面积', kind: 'number', unit: '㎡', min: 0 },
      { key: 'height', label: '建筑高度', kind: 'readonly', unit: 'm' },
    ],
  },
  {
    title: '建造信息',
    fields: [
      { key: 'buildYear', label: '建造年代', kind: 'select', options: ['1950 年前', '1950-1979', '1980-1999', '2000-2010', '2011 年以后'], hideInEdit: true },
      { key: 'structureType', label: '结构类型', kind: 'select', options: ['框架结构', '砖混结构', '剪力墙结构', '钢结构', '其他'] },
      { key: 'completionDate', label: '竣工日期', kind: 'date' },
      { key: 'designUnit', label: '设计单位', kind: 'text' },
      { key: 'builder', label: '施工单位', kind: 'text' },
      { key: 'propertyOwner', label: '产权单位', kind: 'fixed' },
    ],
  },
];

const detailEditing = ref(false);
const detailDraft = reactive<Record<string, string>>({});
const detailError = ref('');
const detailErrorField = ref('');

/** 当前楼栋在 buildingData 中的真实主键（与 selectedProps 查数口径一致） */
const selectedDataKey = computed(() => {
  if (!selected.value) return '';
  const bizName = toBusinessBuildingName(selectedKey.value);
  return buildingData.value[bizName] ? bizName : selectedKey.value;
});

/** 楼宇名称：优先取本地编辑覆盖值（改名后即时显示），否则用模型节点显示名 */
function shownBuildingName(): string {
  const key = selectedDataKey.value;
  const edits = loadStoredDetailEdits();
  const edited = key && typeof edits[key]?.name === 'string' ? String(edits[key].name) : '';
  return edited || (selected.value ? displayName(selected.value.name) : '');
}

/** 下拉字段选项：当前值不在预设列表里时补到最前，保证回显不空白 */
function detailSelectOptions(f: DetailFieldDef): string[] {
  const opts = f.options ?? [];
  const cur = String(detailDraft[f.key] ?? '');
  return cur && !opts.includes(cur) ? [cur, ...opts] : opts;
}

/** 字段展示值（浏览态 / 浏览态与锁定态共用） */
function detailFieldDisplay(f: DetailFieldDef): string {
  const p = selectedProps.value;
  if (f.key === 'name') {
    return shownBuildingName();
  }
  if (f.key === 'lngLat') {
    return selected.value ? `${selected.value.lngLat[0].toFixed(6)}, ${selected.value.lngLat[1].toFixed(6)}` : '—';
  }
  if (f.key === 'bizCategoryLabel') {
    return resolveBizCategory(p).label;
  }
  if (f.key === 'propertyOwner') {
    return String((p as Record<string, unknown>).propertyOwner ?? '学校自有');
  }
  const v = (p as Record<string, unknown>)[f.key];
  if (v == null || v === '') return '—';
  const s = typeof v === 'number' ? v.toLocaleString() : String(v);
  return f.unit ? `${s} ${f.unit}` : s;
}

/** 字段进入编辑态时的初值（不带单位 / 不带后缀） */
function detailFieldDraft(f: DetailFieldDef): string {
  if (f.key === 'name') return shownBuildingName();
  if (f.key === 'lngLat') return detailFieldDisplay(f);
  if (f.key === 'bizCategoryLabel') return resolveBizCategory(selectedProps.value).label;
  const v = (selectedProps.value as Record<string, unknown>)[f.key];
  return v == null ? '' : String(v);
}

/** 日期框：点击任意位置都主动弹出原生日历面板（Chrome 点文本区默认只进分段输入，不弹面板） */
function onDateInputClick(e: MouseEvent): void {
  const el = e.currentTarget as HTMLInputElement | null;
  if (!el || typeof el.showPicker !== 'function') return;
  try {
    el.showPicker();
  } catch {
    // 浏览器不支持或面板已打开时忽略，保持原生行为
  }
}

function startDetailEdit(): void {
  for (const sec of detailSections) {
    for (const f of sec.fields) detailDraft[f.key] = detailFieldDraft(f);
  }
  detailError.value = '';
  detailErrorField.value = '';
  detailEditing.value = true;
}

function cancelDetailEdit(): void {
  detailEditing.value = false;
  detailError.value = '';
  detailErrorField.value = '';
}

function saveDetailEdit(): void {
  const fields = detailSections.flatMap((s) => s.fields);
  // 必填校验
  for (const f of fields) {
    if (f.required && !String(detailDraft[f.key] ?? '').trim()) {
      detailError.value = `「${f.label}」为必填项，请填写后再保存`;
      detailErrorField.value = f.key;
      return;
    }
  }
  // 数字校验
  for (const f of fields) {
    if (f.kind !== 'number') continue;
    const raw = String(detailDraft[f.key] ?? '').trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || (f.min != null && n < f.min)) {
      detailError.value = `「${f.label}」请输入有效数字${f.min != null ? `（不小于 ${f.min}）` : ''}`;
      detailErrorField.value = f.key;
      return;
    }
  }
  const key = selectedDataKey.value;
  const target = key ? buildingData.value[key] : undefined;
  if (!target) {
    detailError.value = '当前楼栋暂无可编辑的属性记录';
    return;
  }
  const patch: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.kind === 'fixed' || f.kind === 'readonly' || f.hideInEdit) continue; // 固定 / 只读 / 编辑态隐藏字段不写回
    const raw = String(detailDraft[f.key] ?? '').trim();
    if (f.key === 'bizCategoryLabel') {
      const meta = [...BUILDING_CATEGORIES, OTHER_CATEGORY].find((c) => c.label === raw);
      patch.bizCategory = meta?.id ?? 'other';
    } else if (f.kind === 'number') {
      patch[f.key] = raw === '' ? undefined : Number(raw);
    } else {
      patch[f.key] = raw;
    }
  }
  buildingData.value = { ...buildingData.value, [key]: { ...target, ...patch } };
  const edits = loadStoredDetailEdits();
  edits[key] = { ...(edits[key] ?? {}), ...patch };
  localStorage.setItem(DETAIL_EDITS_KEY, JSON.stringify(edits));
  ElMessage.success('楼宇基础信息已保存');
  cancelDetailEdit();
}

function onDetailTabClick(t: (typeof detailTabs)[number]): void {
  if (detailEditing && t !== '基础信息') cancelDetailEdit(); // 离开本页时放弃未保存的修改
  detailTab.value = t;
}

// ---------------------------------------------------------------------------
// 楼宇详情导出 Excel：零依赖生成 SpreadsheetML 2003 (.xls)，Excel 可直接打开。
// 三个分块各占一个工作表，每表两列（字段 / 值），表头带楼名与导出时间。
// ---------------------------------------------------------------------------
function xmlEscape(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function exportDetailExcel(): void {
  const p = selectedProps.value;
  if (!p.name) return;
  const esc = xmlEscape;
  const exportName = shownBuildingName() || p.name; // 用改名后的名称（若已修改）
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const sheets = detailSections.map((sec) => {
    const rows = sec.fields.map((f) => {
      const label = esc(f.label);
      const value = esc(detailFieldDisplay(f));
      return `<Row><Cell><Data ss:Type="String">${label}</Data></Cell><Cell><Data ss:Type="String">${value}</Data></Cell></Row>`;
    }).join('');
    return `<Worksheet ss:Name="${esc(sec.title)}"><Table>
      <Row><Cell><Data ss:Type="String">${esc(exportName)} · ${esc(sec.title)}</Data></Cell><Cell><Data ss:Type="String">导出时间：${esc(stamp)}</Data></Cell></Row>
      <Row><Cell><Data ss:Type="String">字段</Data></Cell><Cell><Data ss:Type="String">值</Data></Cell></Row>
      ${rows}
      </Table></Worksheet>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
${sheets}
</Workbook>`;

  const blob = new Blob(['\ufeff', xml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${exportName}_楼宇详情.xls`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  ElMessage.success('楼宇详情已导出为 Excel');
}

interface AttachmentItem {
  name: string;
  type: 'img' | 'doc';
  typeLabel: string;
  format: string;
  size: string;
  time: string;
  sample: boolean;
}

/** 附件信息：含楼宇实景图（真实）与若干示例文档 */
const attachmentList = computed<AttachmentItem[]>(() => {
  const p = selectedProps.value;
  const list: AttachmentItem[] = [];
  if (p.image) {
    list.push({ name: `${p.name} 实景图.jpg`, type: 'img', typeLabel: '图片', format: 'jpg', size: '1.2 MB', time: '2025-03-12', sample: false });
  }
  list.push(
    { name: `${p.name} 建筑平面图.dwg`, type: 'doc', typeLabel: 'CAD 图纸', format: 'dwg', size: '3.4 MB', time: '2024-11-08', sample: true },
    { name: `${p.name} 竣工验收备案表.pdf`, type: 'doc', typeLabel: '文档', format: 'pdf', size: '860 KB', time: '2024-09-20', sample: true },
    { name: `${p.name} 资产清查表.xlsx`, type: 'doc', typeLabel: '表格', format: 'xlsx', size: '210 KB', time: '2025-06-01', sample: true },
  );
  return list;
});

// ---- 附件查询：文件名关键词 + 附件分类筛选 ----
const attachKeyword = ref('');
const attachTypeFilter = ref('');
const attachTypeOptions = ['图片', 'CAD 图纸', '文档', '表格'];
const filteredAttachments = computed<AttachmentItem[]>(() => {
  const kw = attachKeyword.value.trim().toLowerCase();
  const tf = attachTypeFilter.value;
  return attachmentList.value.filter((a) =>
    (!kw || a.name.toLowerCase().includes(kw)) && (!tf || a.typeLabel === tf)
  );
});
/** 统计条按全量附件统计（不随筛选变化） */
const attachStats = computed(() => ({
  img: attachmentList.value.filter((a) => a.type === 'img').length,
  doc: attachmentList.value.filter((a) => a.type === 'doc').length,
}));
/** 重置查询：清空关键词与类型筛选 */
function resetAttachQuery(): void {
  attachKeyword.value = '';
  attachTypeFilter.value = '';
}

/** 资产信息：按建筑面积测算的示例资产卡片 */
const assetSummary = computed(() => {
  const p = selectedProps.value;
  const area = Number(p.buildingArea) || 0;
  const unitPrice = 8000; // 元/㎡（示例）
  const original = area * unitPrice;
  const codeSeed = p.name ? [...p.name].reduce((s, c) => s + c.charCodeAt(0), 0) : 0;
  return {
    code: 'GD-' + String(codeSeed).padStart(6, '0'),
    category: '房屋构筑物',
    original,
    net: Math.round(original * 0.82),
    life: 50,
    status: '在用',
  };
});

/** 楼栋资产：按大类拆分（示例测算） */
const buildingAssetRows = computed(() => {
  const total = assetSummary.value.original || 1;
  const cats = [
    { name: '房屋建筑物', ratio: 0.86 },
    { name: '通用设备', ratio: 0.07 },
    { name: '专用设备', ratio: 0.05 },
    { name: '家具用具', ratio: 0.02 },
  ];
  return cats.map((c) => ({
    name: c.name,
    amount: Math.round(total * c.ratio),
    percent: Math.round(c.ratio * 100),
  }));
});

interface FloorRow {
  floor: number;
  area: number;
  rooms: number;
  use: string;
}

/** 楼层信息：优先聚合房间数据，否则按总层数均匀拆分 */
const floorRows = computed<FloorRow[]>(() => {
  const p = selectedProps.value;
  const rooms = roomsOf(p.name);
  if (rooms.length) {
    const byFloor = new Map<number, Room[]>();
    for (const r of rooms) {
      if (!byFloor.has(r.floor)) byFloor.set(r.floor, []);
      byFloor.get(r.floor)!.push(r);
    }
    return [...byFloor.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([floor, rs]) => ({
        floor,
        area: Math.round(rs.reduce((s, r) => s + (Number(r.area) || 0), 0)),
        rooms: rs.length,
        use: rs[0]?.purpose ?? '—',
      }));
  }
  const total = p.totalFloors;
  if (!total) return [];
  const areaPer = Math.round((Number(p.buildingArea) || 0) / total);
  const roomsPer = Math.round((Number(p.roomCount) || 0) / total);
  return Array.from({ length: total }, (_, i) => ({ floor: i + 1, area: areaPer, rooms: roomsPer, use: '教学/办公' }));
});

/** 变更记录（示例） */
const changeRecords = computed(() => [
  { date: '2024-09-20', type: '竣工验收', desc: `${selectedProps.value.name} 通过竣工验收并交付使用。`, by: '基建处' },
  { date: '2024-11-08', type: '资产入账', desc: '完成固定资产入账，建立楼宇资产卡片。', by: '资产处' },
  { date: '2025-03-12', type: '维修改造', desc: '外立面及屋面防水维修改造。', by: '后勤处' },
  { date: '2025-06-01', type: '用途调整', desc: '部分楼层用途由办公调整为实训教室。', by: '教务处' },
]);

/** 预览：真实图片新窗口打开；示例文档诚实提示（无真实文件） */
function previewAttachment(a: AttachmentItem): void {
  if (a.type === 'img' && selectedProps.value.image) {
    window.open(selectedProps.value.image, '_blank');
    return;
  }
  ElMessage.warning(a.sample ? '该附件为示例数据，暂无真实文件可预览' : '暂无可预览的文件');
}

/** 下载：真实图片新窗口打开；示例文档诚实提示（无真实文件） */
function downloadAttachment(a: AttachmentItem): void {
  if (a.type === 'img' && selectedProps.value.image) {
    window.open(selectedProps.value.image, '_blank');
    return;
  }
  ElMessage.warning(a.sample ? '该附件为示例数据，暂无真实文件可下载' : '暂无可下载的文件');
}

/** 导出附件清单：零依赖 SpreadsheetML .xls，导出当前筛选结果 */
function exportAttachmentsExcel(): void {
  const p = selectedProps.value;
  if (!p.name) return;
  const esc = xmlEscape;
  const exportName = shownBuildingName() || p.name;
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const headers = ['序号', '文件名称', '附件分类', '格式', '大小', '上传时间', '是否示例'];
  const headerRow = `<Row>${headers.map((h) => `<Cell><Data ss:Type="String">${esc(h)}</Data></Cell>`).join('')}</Row>`;
  const rows = filteredAttachments.value.map((a, i) => {
    const cells = [String(i + 1), a.name, a.typeLabel, a.format, a.size, a.time, a.sample ? '示例' : '真实'];
    return `<Row>${cells.map((c) => `<Cell><Data ss:Type="String">${esc(c)}</Data></Cell>`).join('')}</Row>`;
  }).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="附件清单"><Table>
<Row><Cell><Data ss:Type="String">${esc(exportName)} · 附件清单</Data></Cell><Cell><Data ss:Type="String">导出时间：${esc(stamp)}</Data></Cell></Row>
${headerRow}
${rows}
</Table></Worksheet>
</Workbook>`;
  const blob = new Blob(['\ufeff', xml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${exportName}_附件清单.xls`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  ElMessage.success(`附件清单已导出（${filteredAttachments.value.length} 条）`);
}

// ---------------------------------------------------------------------------
// 楼盘表模式
// ---------------------------------------------------------------------------
function enterRoomMode() {
  if (!selected.value || selected.value.isRoom) return;
  const { name, target } = selected.value;
  const rooms = roomsOf(name);
  scene?.showRooms(target, rooms);
  roomBuilding.value = { name, object: target };
  roomFloors.value = scene?.getRoomFloors() ?? [];
  currentFloor.value = roomFloors.value[0] ?? 1;
  selectedRoom.value = null;
  selected.value = null;
  scene?.clearHighlight();
  viewMode.value = 'room';
}

function exitRoomMode() {
  scene?.clearRooms();
  scene?.highlightRoom(null, 0);
  viewMode.value = 'scene';
  roomBuilding.value = null;
  roomFloors.value = [];
  selectedRoom.value = null;
}

function switchFloor(floor: number) {
  currentFloor.value = floor;
  scene?.setRoomFloor(floor);
  if (viewMode.value === 'allocate') {
    // 分配模式：保留已选房间的高亮
    scene?.setSelectedRooms(new Set(selectedRooms.value.map((r) => r.id)));
  } else {
    selectedRoom.value = null;
    scene?.highlightRoom(null, 0);
  }
}

// ---------------------------------------------------------------------------
// 室内视角 & 导出
// ---------------------------------------------------------------------------
const exportTitle = computed(() => {
  if (viewMode.value === 'room' && roomBuilding.value) {
    return `${roomBuilding.value.name}-${currentFloor.value}F楼盘表`;
  }
  return '海南警察学院-3D场景';
});

/** 【待开发·已注释】双击建筑进入室内视角（忽略房间格子/空白）。
 * 恢复室内功能：取消下方函数体注释，并恢复 callbacks 里的 onDoubleClick 注册。 */
function handleDoubleClick(result: PickResult | null) {
  void result; // 入口已关闭，参数保留便于恢复
  // if (!result || result.isRoom) return;
  // selected.value = null;
  // scene?.clearHighlight();
  // scene?.enterIndoorView(result.target);
  // isIndoorView.value = true;
}

function handleEscKey(e: KeyboardEvent) {
  // 测量中按 Enter = 完成（与「完成测量」按钮等效）；输入框内不劫持回车
  if (e.key === 'Enter' && measureActive.value) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    completeMeasure();
    return;
  }
  if (e.key === 'Escape') {
    if (rotateMode.value) {
      exitRotate();
      return;
    }
    if (measureTool.value !== 'none' || measureResult.value) {
      stopMeasure();
      return;
    }
    // 室内视角待开发：以下分支整体注释，保留 else-if 链结构（恢复时取消注释并把 if 改回联用）
    // if (isIndoorView.value) {
    //   scene?.exitIndoorView();
    //   isIndoorView.value = false;
    // } else
    if (viewMode.value === 'allocate') {
      exitAllocationMode();
    } else if (exportOpen.value) {
      exportOpen.value = false;
    } else if (detailEditing.value) {
      cancelDetailEdit(); // 编辑中按 Esc 先退出编辑，不关闭弹窗
    } else if (detailOpen.value) {
      detailOpen.value = false;
    }
  }
}

// ---------------------------------------------------------------------------
// 视图切换 & 量算
// ---------------------------------------------------------------------------
function setView(mode: '2.5d' | '3d') {
  // 暂无 2.5D 图/素材：暂时禁用 2.5D 切换（代码保留，素材就绪后即可恢复）。
  // 恢复：删除下面的 if，并按上方待开发占位条注释把 2.5D 按钮接回「视图」组。
  if (mode === '2.5d') return;
  currentView.value = mode;
  isIndoorView.value = false;
  scene?.setMapView(mode); // 内部会处理退出室内；中心/缩放保持不变（定位不丢失）
}

/** 【待开发·已注释】工具栏「室内」按钮原入口。
 * 按钮已置灰不可点，双击进入室内视角的入口也已注释（功能整体关闭，代码保留）。
 * 恢复：取消下方函数体注释，并把按钮接回 @click="toggleIndoor"。 */
function toggleIndoor() {
  // if (isIndoorView.value) {
  //   scene?.exitIndoorView();
  //   isIndoorView.value = false;
  //   currentView.value = '3d';
  //   return;
  // }
  // let target: THREE.Object3D | null =
  //   selected.value && !selected.value.isRoom ? (selected.value.target as THREE.Object3D) : null;
  // if (!target && objectList.value.length) target = objectList.value[0].object;
  // if (!target) {
  //   window.alert('请先在场景中点击选中一栋建筑，再进入室内视角');
  //   return;
  // }
  // scene?.enterIndoorView(target);
  // isIndoorView.value = true;
}

// ---------------------------------------------------------------------------
// 旋转交互：工具栏「旋转」按钮 + 右下角罗盘
// ---------------------------------------------------------------------------
/** 工具栏「旋转」按钮：进入后左键拖动直接旋转；与量算互斥（进入旋转会先清掉量算） */
function toggleRotate(): void {
  const next = !rotateMode.value;
  if (next && (measureTool.value !== 'none' || measureResult.value)) stopMeasure();
  rotateMode.value = next;
  scene?.setRotateMode(next);
}

/** 退出旋转（供 Esc / 引导条调用） */
function exitRotate(): void {
  if (!rotateMode.value) return;
  rotateMode.value = false;
  scene?.setRotateMode(false);
}

/** 罗盘拖动：以罗盘中心为轴，指针跟随鼠标方位角；地图 bearing 与指针同向 */
let compassDragStart = 0; // 按下时鼠标相对罗盘中心的角度（度）
let compassDragRot = 0; // 按下时的地图 bearing
let compassMoved = false; // 区分「拖动」与「单击回正北」

function compassAngle(e: PointerEvent, el: HTMLElement): number {
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  // 屏幕坐标 y 向下：atan2(dy,dx) 顺时针为正；罗盘 0° 朝上，故 +90
  return (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90;
}

function onCompassDown(e: PointerEvent): void {
  const el = e.currentTarget as HTMLElement;
  compassDragStart = compassAngle(e, el);
  compassDragRot = scene?.getRotation() ?? 0;
  compassMoved = false;
  compassDragging.value = true;
  el.setPointerCapture?.(e.pointerId);
  e.preventDefault();
}

function onCompassMove(e: PointerEvent): void {
  if (!compassDragging.value) return;
  const el = e.currentTarget as HTMLElement;
  let delta = compassAngle(e, el) - compassDragStart;
  // 走最短路径，避免跨 ±180° 时瞬间跳转一整圈
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  if (Math.abs(delta) > 2) compassMoved = true;
  scene?.setRotation(compassDragRot + delta); // 罗盘指针顺时针转 = 北朝右 = bearing 增大
  compassRotation.value = scene?.getRotation() ?? compassDragRot;
}

function onCompassUp(e: PointerEvent): void {
  if (!compassDragging.value) return;
  const el = e.currentTarget as HTMLElement;
  el.releasePointerCapture?.(e.pointerId);
  compassDragging.value = false;
}

/** 罗盘单击（未拖动）：回到初始朝向，和常见地图罗盘「点一下回正北」一致 */
function onCompassClick(): void {
  if (compassMoved) { compassMoved = false; return; }
  scene?.resetRotation();
  compassRotation.value = scene?.getRotation() ?? 0;
}

function startMeasure(mode: 'distance' | 'area') {
  if (rotateMode.value) exitRotate(); // 量算与旋转互斥
  measureTool.value = mode; // 高亮保持，直到点击「清除」
  scene?.startMeasure(mode);
}

function completeMeasure() {
  scene?.completeMeasure(); // 结束本次测量，但保持工具高亮（measureTool 不变）
}

function stopMeasure() {
  measureTool.value = 'none';
  scene?.stopMeasure();
}

function formatMeters(m: number): string {
  if (!isFinite(m)) return '0.0 m';
  return `${m.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} m`;
}

function formatArea(s: number): string {
  if (!isFinite(s)) return '0.0 ㎡';
  return `${s.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ㎡`;
}

// ---------------------------------------------------------------------------
// 分配模式
// ---------------------------------------------------------------------------
const totalArea = computed(() => computeTotalArea(selectedRooms.value));

function enterAllocationMode() {
  if (viewMode.value !== 'room' || !roomBuilding.value) return;
  viewMode.value = 'allocate';
  selectedRoom.value = null;
  selectedRooms.value = [];
  allocResultMessage.value = null;
  allocResultType.value = null;
  scene?.setSelectedRooms(new Set());
}

function exitAllocationMode() {
  viewMode.value = 'room';
  selectedRooms.value = [];
  allocResultMessage.value = null;
  allocResultType.value = null;
  scene?.setSelectedRooms(new Set());
}

function toggleRoomSelection(room: Room) {
  const idx = selectedRooms.value.findIndex((r) => r.id === room.id);
  if (idx >= 0) selectedRooms.value.splice(idx, 1);
  else selectedRooms.value.push(room);
  scene?.setSelectedRooms(new Set(selectedRooms.value.map((r) => r.id)));
}

function removeSelectedRoom(roomId: string) {
  selectedRooms.value = selectedRooms.value.filter((r) => r.id !== roomId);
  scene?.setSelectedRooms(new Set(selectedRooms.value.map((r) => r.id)));
}

async function confirmAllocation(payload: { requestedArea: number; applicant: string }) {
  allocating.value = true;
  allocResultMessage.value = null;
  try {
    const result = await submitAllocation(
      {
        roomIds: selectedRooms.value.map((r) => r.id),
        roomNos: selectedRooms.value.map((r) => r.roomNo),
        totalArea: totalArea.value,
        requestedArea: payload.requestedArea,
        applicant: payload.applicant || undefined,
      },
      config.allocationApiUrl,
    );
    allocResultType.value = result.success ? 'success' : 'error';
    allocResultMessage.value = result.message;

    if (result.success) {
      // 本地更新房间状态为「占用」并刷新格子颜色
      for (const room of selectedRooms.value) {
        room.status = 'occupied';
        scene?.updateRoomStatus(room.id, 'occupied');
      }
      selectedRooms.value = [];
      scene?.setSelectedRooms(new Set());
    }
  } finally {
    allocating.value = false;
  }
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------
function selectByName(name: string) {
  clearSearchError(); // 成功选中楼栋即撤销无结果提示
  if (viewMode.value === 'allocate') exitAllocationMode();
  if (viewMode.value === 'room') exitRoomMode();
  const found = objectList.value.find((o) => o.name === name);
  if (!found) return;
  // 回填真实楼名而不是 GLB 数字节点名（如 20 → 搏击馆）。
  // 下拉列表 / 常驻标签 / 属性面板用的都是 displayName，输入框必须保持一致，
  // 否则搜「搏击馆」定位成功后框里会莫名其妙变成「20」。
  searchQuery.value = displayName(name);
  searchFocused.value = false;
  const wp = new THREE.Vector3();
  found.object.getWorldPosition(wp);
  // 用「包围盒中心」作为锚点（约在建筑半高处），避免直接拿对象原点（地面/角落）
  // 导致浮层钉在楼栋基底而非可见楼体上；飞行同样飞到该中心，二者一致。
  const bbox = new THREE.Box3().setFromObject(found.object);
  const anchorPoint = bbox.isEmpty() ? wp : bbox.getCenter(new THREE.Vector3());
  const result: PickResult = {
    object: found.object,
    target: found.object,
    name: found.name,
    point: anchorPoint,
    lngLat: found.lngLat,
    screenX: 0,
    screenY: 0,
    isRoom: false,
  };
  // 注意：保留 result.name 为模型里的「数字节点名」（如 15）；
  // 真实楼栋主键（用于查楼层图 / 属性数据）由 selectedKey 另行归并，避免显示名被改写。
  selected.value = result;
  detailOpen.value = false;
  imageError.value = false;
  // 先清空锚点（用兜底位），待相机飞行真正落位（moveend）后再用最新相机重算，
  // 避免用「飞行前旧相机」算出的过期坐标把浮层钉在错误位置。
  panelAnchor.value = null;
  debugAnchor(`搜索定位「${found.name}」`);
  // 选中不再整栋高亮（用户要求），清掉可能残留的 hover/旧高亮
  scene?.clearHighlight();
  scene?.flyToObjectCenter(found.object, () => {
    // 飞行结束：用落位后的相机重新投影楼栋世界坐标，浮层精准钉在该楼栋旁
    updateAnchors();
    panel.measure();
    debugAnchor(`搜索定位完成「${found.name}」`);
  });
}

function clearSearchError() {
  searchError.value = null;
  searchAlertDismissed.value = false;
}

/** 手动关闭：连即时中性提示一起压住，否则关掉红色错误态后提示会立刻弹回来 */
function dismissSearchAlert() {
  searchError.value = null;
  searchAlertDismissed.value = true;
}

function onSearchInput() {
  // 由 computed 自动过滤；一改动关键词就撤销上一次的错误态 / 关闭状态
  clearSearchError();
}

function resetSearch() {
  searchQuery.value = '';
  clearSearchError();
  searchFocused.value = true;
  searchInputRef.value?.focus();
}

function onSearchEnter() {
  const q = searchQuery.value.trim();
  clearSearchError(); // 本次提交重新判定，撤销上一次的错误 / 关闭状态
  if (!filteredObjects.value.length) {
    // 原来只弹一个 3 秒即消失的轻提示，白色底图上很容易被忽略。
    // 现在改为：搜索框转红色错误态 + 下方红色实底常驻提示（带推荐楼名，可点可关闭）。
    if (q) {
      searchError.value = q;
      searchAlertKey.value += 1;
    }
    return;
  }
  // 优先精确匹配输入；否则取下拉列表首项（已按精确 / 前缀排序）
  const lower = q.toLowerCase();
  // 精确匹配同时认「节点号」和「真实楼名」：框里回填楼名后再按回车不会选错楼
  const exact = filteredObjects.value.find(
    (o) => o.name.toLowerCase() === lower || displayName(o.name).toLowerCase() === lower,
  );
  selectByName((exact ?? filteredObjects.value[0]).name);
}

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------
/** 返回是否成功加载到真实业务数据（首页概览据此标注数据源，避免把示例数据当真实值） */
async function loadBuildingData(): Promise<boolean> {
  const url = config.dataUrl;
  if (!url) return false;
  try {
    buildingData.value = applyStoredDetailEdits(await fetchBuildingData(url));
    return true;
  } catch (err) {
    console.warn('[建筑数据] 加载失败，回退示例数据：', err);
    return false;
  }
}

async function loadRoomData(): Promise<boolean> {
  const url = config.roomDataUrl;
  if (!url) return false;
  try {
    const fetched = await fetchRoomData(url);
    // 以示例数据为兜底底座，再叠加真实数据：保证任何楼栋都不会因单条数据缺失而空白
    roomData.value = { ...SAMPLE_ROOM_DATA, ...fetched };
    return true;
  } catch (err) {
    console.warn('[房间数据] 加载失败，回退示例数据：', err);
    roomData.value = SAMPLE_ROOM_DATA;
    return false;
  }
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
onMounted(async () => {
  // 浮层定位依赖容器尺寸，必须尽早读取（否则尺寸为 0 会把弹窗夹到页面左上角）
  observeContainer();

  // 并行加载建筑/房间属性数据（不阻塞地图初始化）；两者都成功才标记为真实业务数据源
  Promise.all([loadBuildingData(), loadRoomData()]).then(([b, r]) => {
    businessReady.value = b && r;
  });

  window.addEventListener('keydown', handleEscKey);

  const key = import.meta.env.VITE_AMAP_KEY;
  const securityCode = import.meta.env.VITE_AMAP_SECURITY_CODE;

  if (!key || key.includes('填写')) {
    status.value = 'error';
    keyConfigured.value = false;
    errorMessage.value = '未配置高德地图 key';
    return;
  }
  keyConfigured.value = true;

  try {
    status.value = 'loading-amap';
    // 提前发起模型下载（与 await loadAMap 并行），缩短首屏：下载完成后存入缓冲，
    // 高德 GL 就绪后由 MapScene 直接 parse，无需再等网络。
    const modelFetch = fetch(config.modelUrl);
    const AMap = await loadAMap({ key, securityJsCode: securityCode });

    if (!mapContainer.value) return;
    // 自动取景（fitToBuildings + 迭代微调）期间视角会跳变，加载遮罩必须
    // 保持到「模型就绪 && 取景收敛」双条件齐备后才揭开，用户看到的第一个
    // 画面就是最终稳定视角（否则会看到底图 / 模型先跳几下再稳定）。
    let modelReady = false;
    let fitDone = false;
    const tryReveal = (): void => {
      if (modelReady && fitDone && status.value === 'loading-model') {
        status.value = 'ready';
      }
    };
    scene = new MapScene(mapContainer.value, config, {
      onModelProgress: (p) => (modelProgress.value = p),
      onModelStage: (label, done, total) => {
        modelStage.value = label;
        modelStageDone.value = done ?? 0;
        modelStageTotal.value = total ?? 0;
      },
      onModelReady: () => {
        modelReady = true;
        objectList.value = scene?.listObjects() ?? [];
        // 模型概览：从当前 GLB 实时统计（几何/材质/贴图/体积/耗时）
        modelStats.value = scene?.getModelStats() ?? null;
        // 首帧渲染后再刷新一次，renderer.info 的 draw call 才有真实值
        window.setTimeout(() => {
          if (scene) modelStats.value = scene.getModelStats();
        }, 1200);
        // 把 GLB 里真实存在的建筑节点名（0–25）登记进楼栋表，
        // 否则 DXF 第 6 步「确认归属」候选列表里找不到当前选中的建筑。
        buildingStore.registerBuildings(objectList.value.map((o) => o.name));
        tryReveal();
      },
      onFitComplete: () => {
        fitDone = true;
        tryReveal();
      },
      onModelError: () => {
        status.value = 'error';
        errorMessage.value = `GLB 模型加载失败：${config.modelUrl}`;
      },
      onMapError: (err) => {
        status.value = 'error';
        errorMessage.value = `地图初始化失败：${String(err)}`;
      },
      onHover: (result) => {
        hovered.value = result;
        if (viewMode.value === 'allocate') return; // 分配模式仅显示 tooltip
        if (viewMode.value === 'room') {
          // 房间模式：悬停房间格子
          if (result?.isRoom && result.room) scene?.highlightRoom(result.room.id, 0.5);
          else scene?.highlightRoom(null, 0);
          return;
        }
        // 场景模式：悬停建筑（未选中时才应用）。悬停只高亮该楼的楼顶，不改整栋外观。
        // 已有选中楼栋时保留其整栋高亮，不被 hover 覆盖；取消选中后 hover 恢复。
        if (!selected.value) {
          if (result && !result.isRoom) scene?.highlight(result.target, config.hoverColor, true, 0.45);
          else scene?.clearHighlight();
        }
      },
      onSelect: (result) => {
        if (viewMode.value === 'allocate') {
          // 分配模式：点击房间切换选中（跨楼层）
          if (result?.isRoom && result.room) toggleRoomSelection(result.room);
          return;
        }
        if (viewMode.value === 'room') {
          // 房间模式：点击房间 → 详情（浮层锚定到该房间格子）
          if (result?.isRoom && result.room) {
            selectedRoom.value = result.room;
            roomAnchor.value =
              scene?.getRoomScreenPos(result.room.id) ?? { x: result.screenX, y: result.screenY };
            roomDetail.measure();
            scene?.highlightRoom(result.room.id, 0.7);
          } else {
            selectedRoom.value = null;
            roomAnchor.value = null;
            scene?.highlightRoom(null, 0);
          }
          return;
        }
        // 场景模式：点击建筑 → 属性面板（浮层锚定到点击的节点位置）
        if (result && !result.isRoom) {
          // 保留 result.name 为模型「数字节点名」；真实楼栋主键由 selectedKey 另行归并
          selected.value = result;
          detailOpen.value = false;
          imageError.value = false;
          // 切换/点击建筑时，关闭可能残留的房间管理面板（避免与属性面板同时出现）
          roomMgmtOpen.value = false;
          panelAnchor.value =
            scene?.projectToScreen(result.point) ?? { x: result.screenX, y: result.screenY };
          panel.measure();
          debugAnchor(`点击「${result.name}」`);
          // 点击选中：整栋柔和高亮（低强度，只叠加发光、保留原贴图细节，避免过曝发白）
          scene?.highlight(result.target, config.highlightColor, false, 0.7);
          scene?.setSelectedBuilding(result.name);
        } else {
          selected.value = null;
          panelAnchor.value = null;
          scene?.clearHighlight();
          scene?.setSelectedBuilding('');
        }
      },
      // 【待开发·已注释】双击进入室内视角：恢复室内功能时取消下行注释
      // onDoubleClick: (result) => handleDoubleClick(result),
      // 量算结果回调：null 表示清除；finished（measuringMode==='none'）时仅保留结果、取消按钮高亮
      onMeasureUpdate: (data) => {
        measureResult.value = data;
        // 打点 / 结束时视角没变，onViewChange 不会触发，这里主动重算一次锚点
        updateAnchors();
      },
      onMeasureActive: (active: boolean) => {
        measureActive.value = active;
      },
      // 地图平移/缩放/旋转/飞行时，让锚定浮层跟随节点，并同步罗盘指针
      onViewChange: () => {
        updateAnchors();
        if (!compassDragging.value) compassRotation.value = scene?.getRotation() ?? 0;
      },
    });

    status.value = 'loading-model';
    // 关键优化：把「下载中的 fetch」直接交给 MapScene，并立即初始化地图。
    // 这样「模型下载」与「高德 WebGL 初始化（软件光栅下最慢的一段）」完全并行，
    // 不再互相等待；MapScene 在 GL 就绪后复用本次下载，不会重复拉取。
    // （旧写法在 scene.init 之前 await modelFetch，等于等模型下完才建地图，串行浪费数秒。）
    scene.setPrefetchFetch(modelFetch.then((r) => r.arrayBuffer()));
    scene.init(AMap);
  } catch (err) {
    status.value = 'error';
    errorMessage.value = `初始化失败：${(err as Error).message}`;
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleEscKey);
  onDetailDragEnd(); // 清理详情弹窗拖拽的全局监听
  unobserveContainer();
  scene?.destroy();
  scene = null;
});
</script>

<style scoped>
.scene-shell {
  position: relative;
  width: 100%;
  height: 100dvh;
  min-height: 480px;
  overflow: hidden;
  background: #0e1420;
}

.scene-map {
  position: absolute;
  inset: 0;
  /* 高德 .amap-container 自带 #f2f2f2 浅灰白底，而 GL 画布是透明的。
     按需渲染时若某帧画布没被完整重绘，纯白底会透出来形成「背景白光闪一下」。
     用与天空/地面接近的渐变兜底，即使出现空帧也不会刺眼地发白。 */
  background: linear-gradient(180deg, #a9c9e6 0%, #c9dded 30%, #e9eef1 58%, #e7e7e5 100%) !important;
}

.scene-overlay {
  position: absolute;
  z-index: 300;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #dce6f5;
  /* 近不透明：遮罩后面自动取景的视角跳变（缩放/俯仰/平移）完全不可见，
     揭开遮罩时直接呈现最终稳定视角 */
  background: rgba(14, 20, 32, 0.97);
  backdrop-filter: blur(6px);
}
.scene-overlay strong { font-size: 15px; font-weight: 500; }
.scene-overlay .err { color: #f87171; }
.scene-overlay small { color: #8a97ad; font-size: 12px; }

.err-hint {
  max-width: 420px;
  padding: 12px 16px;
  border: 1px solid #33415c;
  border-radius: 6px;
  color: #a7b4c8;
  background: rgba(20, 27, 43, 0.6);
  font-size: 12px;
  line-height: 1.9;
  text-align: left;
}
.err-hint code {
  padding: 1px 6px;
  border-radius: 3px;
  color: #eaf2ff;
  background: #1a2335;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.spinner {
  width: 30px;
  height: 30px;
  border: 2px solid #24324a;
  border-top-color: #38bdf8;
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.scene-badge {
  position: absolute;
  z-index: 120;
  top: 16px;
  left: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid #24324a;
  border-radius: 4px;
  color: #c3d0e5;
  background: rgba(20, 27, 43, 0.88);
  font-size: 12px;
  backdrop-filter: blur(8px);
  pointer-events: none;
}

.badge-light, .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #34d399;
  box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.15);
}

/* 统计概览触发按钮：左上角、标题徽标下方，点击打开校区数据统计弹窗 */
.stats-trigger {
  position: absolute;
  z-index: 120;
  top: 60px;
  left: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 13px;
  border: 1px solid #2d4260;
  border-radius: 20px;
  background: rgba(16, 24, 40, 0.92);
  box-shadow: 0 8px 24px rgba(2, 6, 23, 0.3);
  backdrop-filter: blur(10px);
  color: #e2e8f0;
  font-size: 12.5px;
  cursor: pointer;
  transition: border-color .15s, background .15s, transform .12s;
}
.stats-trigger:hover { border-color: #3d82c4; background: rgba(20, 38, 64, 0.96); transform: translateY(-1px); }
.stats-trigger strong { font-weight: 600; }
.stats-trigger__dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #34d399; box-shadow: 0 0 0 4px rgba(52, 211, 153, 0.16);
  flex-shrink: 0;
}
.stats-trigger__brief { color: #93a4bd; font-size: 11.5px; }
.stats-trigger__arrow { color: #56b0f0; font-size: 14px; margin-left: 2px; }

/* 首页模型数据概览：左上角、标题徽标下方，可收起 */
.model-stats {
  position: absolute;
  z-index: 120;
  top: 60px;
  left: 16px;
  width: 272px;
  border: 1px solid #24324a;
  border-radius: 10px;
  background: rgba(16, 24, 40, 0.9);
  box-shadow: 0 12px 32px rgba(2, 6, 23, 0.28);
  backdrop-filter: blur(10px);
  overflow: hidden;
}
.model-stats--collapsed { width: auto; }
.model-stats__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 36px;
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: #e2e8f0;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.model-stats__head:hover { background: rgba(56, 189, 248, 0.08); }
.model-stats__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #34d399;
  box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.15);
}
.model-stats__brief {
  margin-left: auto;
  color: #94a3b8;
  font-size: 11px;
  white-space: nowrap;
}
.model-stats__caret {
  width: 12px;
  color: #94a3b8;
  font-size: 15px;
  line-height: 1;
  text-align: center;
}
.model-stats__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  background: #24324a;
  border-top: 1px solid #24324a;
}
.model-stats__cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 9px;
  background: rgba(16, 24, 40, 0.94);
}
.model-stats__cell span { color: #94a3b8; font-size: 10px; line-height: 1.25; }
.model-stats__cell b {
  color: #eaf2ff;
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
}
.model-stats__warn {
  padding: 6px 10px;
  border-top: 1px solid #f59e0b;
  color: #fcd34d;
  background: rgba(245, 158, 11, 0.12);
  font-size: 10.5px;
}
.model-stats__section {
  padding: 5px 10px 4px;
  border-top: 1px solid #24324a;
}
.model-stats__section-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  color: #cbd5e1;
  font-size: 11px;
  font-weight: 600;
}
.model-stats__section-title small {
  color: #64748b;
  font-size: 10px;
  font-weight: 400;
}
.model-stats__bars {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 46px;
  margin-top: 4px;
}
.model-stats__bar {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  height: 100%;
}
.model-stats__bar b { color: #eaf2ff; font-size: 10px; font-weight: 600; }
.model-stats__bar i {
  display: block;
  width: 100%;
  max-width: 22px;
  border-radius: 2px 2px 0 0;
  background: linear-gradient(180deg, #38bdf8, #2563eb);
}
.model-stats__bar span { color: #94a3b8; font-size: 9.5px; }
.model-stats__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 4px;
}
.model-stats__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #b6c4da;
  font-size: 10.5px;
}
.model-stats__legend-item i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.model-stats__legend-item b { color: #eaf2ff; font-variant-numeric: tabular-nums; }
.model-stats__actions {
  display: flex;
  border-top: 1px solid #24324a;
}
.model-stats__more,
.model-stats__tech-toggle {
  flex: 1;
  display: block;
  padding: 5px 8px;
  border: 0;
  background: transparent;
  color: #7dd3fc;
  font-size: 10px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.model-stats__tech-toggle {
  flex: 0 0 84px;
  border-left: 1px solid #24324a;
  color: #64748b;
  text-align: center;
}
.model-stats__more:hover,
.model-stats__tech-toggle:hover { background: rgba(56, 189, 248, 0.08); }
.model-stats__list {
  max-height: 150px;
  overflow-y: auto;
  border-top: 1px solid #24324a;
  background: rgba(10, 17, 30, 0.5);
}
.model-stats__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid rgba(36, 50, 74, 0.6);
}
.model-stats__row strong { color: #e2e8f0; font-size: 11px; font-weight: 600; }
.model-stats__row span { color: #94a3b8; font-size: 10px; white-space: nowrap; }
.model-stats__types {
  padding: 7px 10px;
  color: #94a3b8;
  font-size: 10px;
  line-height: 1.5;
}
.model-stats__foot {
  padding: 5px 10px;
  border-top: 1px solid #24324a;
  color: #64748b;
  font-size: 10px;
}
.model-stats__tech {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 8px 10px;
  border-top: 1px solid #24324a;
  color: #94a3b8;
  font-size: 10px;
}

/* 工具栏 */
.toolbar {
  position: absolute;
  z-index: 120;
  top: 16px;
  right: 16px;
}
.toolbar__btn {
  height: 34px;
  padding: 0 14px;
  border: 1px solid #33415c;
  border-radius: 6px;
  color: #c3d0e5;
  background: rgba(20, 27, 43, 0.9);
  font-size: 13px;
  cursor: pointer;
  backdrop-filter: blur(8px);
}
.toolbar__btn:hover { border-color: #38bdf8; color: #eaf2ff; }

/* 室内视角提示 */
.indoor-badge {
  position: absolute;
  z-index: 120;
  top: 60px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 14px;
  border: 1px solid #f59e0b;
  border-radius: 20px;
  color: #ffe7c2;
  background: rgba(20, 27, 43, 0.9);
  font-size: 12px;
  pointer-events: none;
  backdrop-filter: blur(8px);
}
.indoor-badge__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #f59e0b;
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.15);
}

/* 搜索框 */
.search-box {
  position: absolute;
  z-index: 140;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  width: 320px;
  max-width: calc(100% - 200px);
}
.search-box input {
  width: 100%;
  height: 38px;
  padding: 0 14px;
  border: 1px solid #24324a;
  border-radius: 6px;
  color: #dce6f5;
  background: rgba(20, 27, 43, 0.92);
  font-size: 13px;
  outline: none;
  backdrop-filter: blur(8px);
  transition: border-color 0.15s ease;
}
.search-box input:focus { border-color: #38bdf8; }
.search-box input::placeholder { color: #6b7890; }
/* 未找到楼栋：输入框本身转成红色错误态，白色底图上也一眼可见 */
.search-box input.is-error,
.search-box input.is-error:focus {
  border-color: #fb7185;
  background: rgba(74, 16, 28, 0.97);
  color: #fff1f2;
  box-shadow: 0 0 0 3px rgba(248, 113, 113, 0.24);
}

/* 搜索无结果提示：紧贴搜索框、实底常驻，替代原来 3 秒即消失的轻提示 */
.search-alert {
  position: absolute;
  z-index: 175; /* 高于测量引导条(165)，两卡同屏时提示不被压住 */
  top: 44px;
  left: 0;
  right: 0;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 10px 10px 12px;
  border: 1px solid #f59e0b;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.98);
  box-shadow: 0 14px 36px rgba(2, 6, 23, 0.45);
  color: #eaf2ff;
  animation: search-alert-in 0.2s ease-out;
}
.search-alert--error {
  border: 1px solid #fb7185;
  border-top: 3px solid #fb7185;
  background: #4a101c;
  box-shadow: 0 0 0 3px rgba(248, 113, 113, 0.18), 0 16px 40px rgba(2, 6, 23, 0.5);
  animation: search-alert-in 0.2s ease-out, search-alert-glow 1s ease-out 1;
}
/* 测量引导条固定在 y64、高约 82px；两卡同屏时提示/下拉整体下移，留约 18px 间隙 */
.search-alert--below-guide,
.search-dropdown--below-guide { top: 148px; }
.search-alert__icon {
  flex: 0 0 22px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #f59e0b;
  color: #0b1220;
  font-size: 14px;
  font-weight: 800;
  line-height: 22px;
  text-align: center;
}
.search-alert--error .search-alert__icon { background: #fb7185; color: #3b0712; }
.search-alert__body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.search-alert__body strong { font-size: 13px; font-weight: 700; color: #fff1f2; }
.search-alert__body > span { font-size: 11.5px; line-height: 1.5; color: #fecaca; }
.search-alert:not(.search-alert--error) .search-alert__body strong { color: #eaf2ff; }
.search-alert:not(.search-alert--error) .search-alert__body > span { color: #b6c4da; }
.search-alert__suggest { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 5px; }
.search-alert__suggest > span { font-size: 11px; color: #fda4af; }
.search-alert__suggest button {
  padding: 3px 8px;
  border: 1px solid rgba(251, 113, 133, 0.55);
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.55);
  color: #fff1f2;
  font-size: 11px;
  cursor: pointer;
}
.search-alert__suggest button:hover { background: #fb7185; border-color: #fb7185; color: #3b0712; }
.search-alert__reset {
  align-self: flex-start;
  margin-top: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #7dd3fc;
  font-size: 11px;
  text-decoration: underline;
  cursor: pointer;
}
.search-alert__reset:hover { color: #bae6fd; }
.search-alert__close {
  flex: 0 0 20px;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #fecaca;
  font-size: 18px;
  line-height: 18px;
  cursor: pointer;
}
.search-alert__close:hover { background: rgba(251, 113, 133, 0.25); color: #ffffff; }
@keyframes search-alert-in {
  from { opacity: 0; transform: translateY(-7px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes search-alert-glow {
  from { box-shadow: 0 0 0 3px rgba(248, 113, 113, 0.6), 0 16px 40px rgba(2, 6, 23, 0.5); }
  to { box-shadow: 0 0 0 3px rgba(248, 113, 113, 0.18), 0 16px 40px rgba(2, 6, 23, 0.5); }
}

.search-dropdown {
  position: absolute;
  top: 44px;
  left: 0;
  right: 0;
  margin: 0;
  padding: 4px;
  list-style: none;
  border: 1px solid #24324a;
  border-radius: 6px;
  background: rgba(20, 27, 43, 0.97);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(10px);
  max-height: 280px;
  overflow-y: auto;
}
.search-dropdown li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  color: #dce6f5;
}
.search-dropdown li:hover { background: #22314a; }
.search-dropdown__coord { color: #6b7890; font-size: 11px; font-family: ui-monospace, monospace; }

/* tooltip */
.tooltip {
  position: absolute;
  z-index: 150;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid #38bdf8;
  border-radius: 4px;
  color: #e6f4ff;
  background: rgba(13, 22, 38, 0.94);
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
}
.tooltip__status { font-size: 11px; }

/* 节点锚点标记：指示浮层指向的模型节点 */
.anchor-dot {
  position: absolute;
  z-index: 125;
  width: 10px;
  height: 10px;
  margin: -5px 0 0 -5px;
  border: 2px solid #38bdf8;
  border-radius: 50%;
  background: rgba(56, 189, 248, 0.28);
  pointer-events: none;
  animation: anchor-pulse 1.8s ease-out infinite;
}
@keyframes anchor-pulse {
  0% { box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.3); }
  70% { box-shadow: 0 0 0 11px rgba(56, 189, 248, 0); }
  100% { box-shadow: 0 0 0 11px rgba(56, 189, 248, 0); }
}

/* 属性面板（位置由 JS 按被点击节点动态计算） */
.property-panel {
  position: absolute;
  z-index: 130;
  width: 322px;
  max-width: calc(100% - 24px);
  border: 1px solid #e2e8f1;
  border-radius: 12px;
  background: #ffffff;
  box-shadow: 0 16px 48px rgba(23, 43, 77, 0.22), 0 2px 8px rgba(23, 43, 77, 0.08);
  overflow: hidden;
}
.property-panel__head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 13px 15px;
  color: #16233a;
  border-bottom: 1px solid #eef1f6;
}
/* 标题栏可拖拽：move 光标提示；拖动时禁止选中文字（按钮自身的 pointer 光标不受影响） */
.property-panel__head--movable { cursor: move; user-select: none; }
.property-panel__head .dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #1a8f5a; box-shadow: 0 0 0 4px rgba(26, 143, 90, 0.13);
  flex-shrink: 0;
}
.property-panel__head strong {
  min-width: 0; max-width: 170px; font-size: 16px; font-weight: 700; letter-spacing: .2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 类别小标签：内联在标题行，替代原先占高 108px 的图片横幅 */
.property-panel__badge {
  flex-shrink: 0;
  padding: 2px 8px; border-radius: 5px;
  background: #eaf3fb; color: #1b6fa8;
  font-size: 10.5px; font-weight: 700; letter-spacing: .3px;
  white-space: nowrap;
}
.property-panel__close {
  width: 26px; height: 26px; border: 0; border-radius: 6px;
  color: #8a97ad; background: transparent; font-size: 20px; line-height: 1; cursor: pointer;
}
.property-panel__close:hover { color: #c0392b; background: #eef1f6; }
.property-panel .property-panel__close { color: #7c8798; }
.property-panel .property-panel__close:hover { color: #c0392b; background: #f2e9e9; }

/* 分区标题 */
.property-panel__section { padding: 13px 15px 3px; }
.property-panel__head + .property-panel__section { padding-top: 14px; }
.property-panel__section + .property-panel__section { padding-top: 6px; }
.property-panel__section-title {
  display: flex; align-items: baseline; gap: 6px;
  font-size: 11px; font-weight: 700; color: #8492a6;
  letter-spacing: 1px; margin-bottom: 10px;
}
.property-panel__section-title::before {
  content: ''; width: 3px; height: 11px; border-radius: 2px;
  background: #1a8f5a; margin-right: 2px;
}
.property-panel__section-title small { font-size: 10px; font-weight: 500; color: #aab4c2; letter-spacing: 0; }

/* 基本属性：两列网格 */
.pp-facts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.pp-fact {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 10px; border-radius: 8px;
  background: #f6f8fb; border: 1px solid #eef2f7;
}
.pp-fact__ico {
  width: 28px; height: 28px; border-radius: 8px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; color: #fff;
}
.pp-fact__ico--campus { background: #4a7fc1; }
.pp-fact__ico--dept   { background: #8a6bb5; }
.pp-fact__ico--floor  { background: #d98b3a; }
.pp-fact__ico--room   { background: #2f9e78; }
.pp-fact__body { display: flex; flex-direction: column; min-width: 0; }
.pp-fact__body label { font-size: 10.5px; color: #8b96a8; line-height: 1.5; }
.pp-fact__body b {
  font-size: 13px; color: #1f2a3a; font-weight: 700; line-height: 1.4;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* 面积大数字卡片 */
.pp-area { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.pp-area__card {
  position: relative; padding: 11px 12px; border-radius: 8px;
  background: linear-gradient(140deg, #eef4fb, #e4eef9);
  border: 1px solid #d9e7f5;
}
.pp-area__card--use { background: linear-gradient(140deg, #eaf7f1, #ddf0e6); border-color: #cfe9dc; }
.pp-area__card label { display: block; font-size: 10.5px; color: #6c7b90; margin-bottom: 3px; }
.pp-area__card b { font-size: 21px; font-weight: 800; color: #1b4e72; letter-spacing: -.5px; }
.pp-area__card--use b { color: #1a7a52; }
.pp-area__card span { font-size: 11px; color: #7c8a9c; margin-left: 3px; }

.property-panel__desc {
  margin: 0; padding: 4px 15px 12px;
  color: #3a4456; font-size: 12px; line-height: 1.7;
}
.property-panel__locate {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border: 0; border-radius: 6px;
  color: #0b6fb8; background: transparent; cursor: pointer;
  margin-left: auto;
}
.property-panel__locate:hover { background: rgba(11, 111, 184, 0.1); }

.property-panel__actions {
  display: flex; gap: 7px;
  padding: 13px 15px 15px; border-top: 1px solid #eef1f6; margin-top: 8px;
}
.property-panel__btn {
  flex: 1; height: 34px; border: 1px solid #d5dde8; border-radius: 7px;
  color: #46536a; background: #fff; font-size: 12.5px; font-weight: 600;
  cursor: pointer; white-space: nowrap; transition: all .15s;
}
.property-panel__btn:hover { border-color: #0b6fb8; color: #0b4f8a; background: #f0f7fc; }
.property-panel__btn--primary {
  border-color: #0b6fb8; color: #fff;
  background: linear-gradient(180deg, #1a86cf, #0b6fb8);
  box-shadow: 0 2px 6px rgba(11, 111, 184, .28);
}
.property-panel__btn--primary:hover { background: linear-gradient(180deg, #0b6fb8, #095a99); color: #fff; }

/* 楼宇详情弹窗 */
.detail-modal {
  position: absolute;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(6, 10, 20, 0.55);
  backdrop-filter: blur(3px);
}
.detail-modal__card {
  display: flex;
  flex-direction: column;
  width: 50vw;
  max-width: 50vw;
  height: 80vh;
  max-height: 80vh;
  overflow: hidden; /* 整体不滚动，仅 body 滚动，footer 永远固定底部 */
  border: 1px solid #2b3a56;
  border-radius: 10px;
  /* 上浅下深的深蓝灰渐变，替代纯黑，更有层次 */
  background: linear-gradient(180deg, rgba(28, 38, 58, 0.98) 0%, rgba(16, 22, 37, 0.98) 100%);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
  will-change: transform;
  transition: width 0.2s, height 0.2s, max-width 0.2s, max-height 0.2s;
}
.detail-modal__card--max {
  width: calc(100vw - 40px);
  max-width: calc(100vw - 40px);
  height: calc(100vh - 40px);
  max-height: calc(100vh - 40px);
  border-radius: 8px;
}
.detail-modal__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid #24324a;
  color: #eaf2ff;
  cursor: move;
  user-select: none;
  position: sticky;
  top: 0;
  z-index: 3;
  background: rgba(20, 27, 43, 0.98);
}
.detail-modal__head:active { cursor: grabbing; }
.detail-modal__head strong { flex: 1; font-size: 15px; font-weight: 600; }
.detail-modal__drag-hint {
  font-size: 10px; color: #7c8ba3; font-weight: 400;
  letter-spacing: .5px; padding: 2px 7px;
  border: 1px dashed #3a4a66; border-radius: 4px;
}
.detail-modal__maxbtn {
  appearance: none; cursor: pointer; flex: none;
  width: 22px; height: 22px; line-height: 20px; text-align: center;
  font-size: 15px; color: #9fb0c9;
  border: 1px solid transparent; border-radius: 5px; background: transparent;
}
.detail-modal__maxbtn:hover { color: #eaf2ff; border-color: #3a4a66; background: rgba(56, 189, 248, 0.08); }
.detail-modal__image {
  height: 200px;
  border-bottom: 1px solid #24324a;
  background: #141c2e;
  overflow: hidden;
}
.detail-modal__image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.detail-modal__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 28px;
  margin: 0;
  padding: 10px 16px 12px;
}
/* 每个字段：固定标签列 + 自适应值列，保证两列输入框等宽对齐 */
.detail-modal__grid .detail-field {
  display: grid;
  grid-template-columns: 80px minmax(0, 1fr);
  align-items: center;
  column-gap: 8px;
  min-width: 0;
  padding: 7px 0;
  font-size: 13px;
  border-bottom: 1px dashed #1e2a40;
}
.detail-modal__grid dt {
  color: #8a97ad;
  white-space: nowrap;
  line-height: 1.9;
}
.detail-modal__grid dd {
  margin: 0;
  color: #eaf2ff;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-modal__desc {
  margin: 0;
  padding: 4px 16px 16px;
  color: #a7b4c8;
  font-size: 12px;
  line-height: 1.7;
}

/* 楼宇详情 Tab */
.detail-modal__tabs {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 8px 12px 0;
  border-bottom: 1px solid #24324a;
  position: sticky;
  top: 0;
  background: rgba(20, 27, 43, 0.98);
  z-index: 2;
}
.detail-tab {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: #9fb0c9;
  font-size: 12.5px;
  padding: 7px 11px;
  border-radius: 7px 7px 0 0;
  cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}
.detail-tab:hover { color: #eaf2ff; background: rgba(56, 189, 248, 0.08); }
.detail-tab.active {
  color: #eaf2ff;
  background: rgba(56, 189, 248, 0.14);
  border-color: #24324a;
  border-bottom-color: transparent;
  font-weight: 600;
}
.detail-modal__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 0 8px; }
.detail-tabpane { padding-top: 4px; }

/* 楼宇详情 · 基础信息分块 */
.detail-block {
  margin: 10px 12px 0;
  border: 1px solid #26344d;
  border-radius: 8px;
  background: rgba(12, 18, 31, 0.45);
  overflow: hidden;
}
.detail-block__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 9px 12px;
  font-size: 13px;
  font-weight: 600;
  color: #dce8fb;
  border-bottom: 1px solid #26344d;
}
.detail-block__bar { width: 3px; height: 13px; border-radius: 2px; background: #38bdf8; }
.detail-modal__grid--edit { padding-top: 6px; }
.detail-modal__grid .detail-field--wide { grid-column: 1 / -1; grid-template-columns: 80px minmax(0, 1fr); }
.detail-field dt { display: flex; align-items: center; gap: 3px; }
.detail-req { color: #ff6b6b; font-style: normal; font-weight: 700; }
.detail-field dd { display: flex; align-items: center; justify-content: flex-start; gap: 6px; min-width: 0; }
.detail-value--locked { color: #8fa0b8; }
.detail-field-tag {
  flex: none; font-size: 10px; line-height: 1; color: #7c8ba3;
  border: 1px solid #3a4a66; border-radius: 3px; padding: 2px 4px;
}
/* 所有输入控件占满值列，宽度完全一致 */
.detail-input {
  display: block; width: 100%; min-width: 0; box-sizing: border-box;
  padding: 5px 8px; font-size: 12.5px;
  color: #eaf2ff; background: #0e1626;
  border: 1px solid #35507a; border-radius: 5px; outline: none;
}
.detail-input:focus { border-color: #38bdf8; box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.14); }
.detail-input--error { border-color: #ff6b6b !important; }
/* 日期框：深色主题让日历图标/占位文字可见，整框可点击 */
.detail-input--date { color-scheme: dark; cursor: pointer; }
.detail-input--date::-webkit-calendar-picker-indicator {
  cursor: pointer; opacity: .9;
}
.detail-input--date::-webkit-datetime-edit { color: #eaf2ff; }
.detail-input--date::-webkit-datetime-edit-fields-wrapper { color: #eaf2ff; }
.detail-textarea { resize: vertical; }
select.detail-input { cursor: pointer; }
select.detail-input option { background: #0e1626; color: #eaf2ff; }
/* 导出 Excel：贴在底部横线上方，固定在内容区与操作栏之间 */
.detail-export-row {
  flex: none;
  display: flex; justify-content: flex-start;
  padding: 4px 16px 8px;
  background: rgba(16, 22, 37, 0.98);
}
/* 底部操作栏：关闭 / 修改居中，按钮间留间隔 */
.detail-modal__footer {
  flex: none; z-index: 3;
  display: flex; align-items: center; justify-content: center;
  padding: 10px 16px 12px;
  border-top: 1px solid #2b3a56;
  background: rgba(16, 22, 37, 0.98);
}
.detail-footer-actions { display: flex; align-items: center; justify-content: center; gap: 18px; }
.detail-footer-btn {
  appearance: none; cursor: pointer; font-size: 12.5px;
  padding: 7px 18px; border-radius: 6px;
  border: 1px solid #3a4a66; background: #1b2740; color: #c8d6ea;
}
.detail-footer-btn:hover { border-color: #0b6fb8; color: #fff; }
.detail-footer-btn--primary {
  border-color: #0b6fb8; color: #fff;
  background: linear-gradient(180deg, #1a86cf, #0b6fb8);
  box-shadow: 0 2px 6px rgba(11, 111, 184, 0.28);
}
.detail-footer-btn--primary:hover { background: linear-gradient(180deg, #0b6fb8, #095a99); }
.detail-footer-btn--close {
  border-color: #b5485e; color: #ffd9e0; font-weight: 600;
  background: linear-gradient(180deg, #a33b50, #832c3e);
  box-shadow: 0 2px 6px rgba(163, 59, 80, 0.28);
}
.detail-footer-btn--close:hover { background: linear-gradient(180deg, #b5485e, #93344a); color: #fff; }
.detail-footer-btn--export {
  border-color: #2f7d6b; color: #b8e6d9;
  background: linear-gradient(180deg, #1c7a68, #14614f);
}
.detail-footer-btn--export:hover { background: linear-gradient(180deg, #14614f, #0f4c3e); color: #fff; }
.detail-error { color: #ff8f8f; font-size: 12px; }
.detail-footer-hint { color: #7c8ba3; font-size: 11.5px; }

/* 房间管理面板：右侧停靠，宽 20%，无遮罩层 */
.room-mgmt-modal {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 30vw;
  z-index: 210;
  display: block;
}
.room-mgmt__card {
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  display: flex;
  flex-direction: column;
  border: 1px solid #e3d9c4;
  border-right: none;
  border-radius: 0;
  background: #f7f2e7;
  box-shadow: -8px 0 30px rgba(0, 0, 0, 0.18);
}
.room-mgmt__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid #e3d9c4;
  color: #2a241a;
  position: sticky;
  top: 0;
  background: #f7f2e7;
  z-index: 2;
}
.room-mgmt__head strong { flex: 1; font-size: 15px; font-weight: 600; }
/* 米色面板内的关闭按钮（深色，保证在米底上可见） */
.room-mgmt__head .property-panel__close { color: #6b5d44; }
.room-mgmt__head .property-panel__close:hover { color: #c0392b; background: #ece2cf; }
.room-mgmt__summary {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid #e3d9c4;
}
.room-mgmt__pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid #e3d9c4;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.03);
  color: #4a4436;
  font-size: 13px;
}
.room-mgmt__pill i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; border: 1.5px solid transparent; }
.room-mgmt__pill b { color: var(--cd, var(--c)); font-size: 14px; }
.room-mgmt__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 0 18px;
}
.room-mgmt__floor-section {
  border-bottom: 1px dashed #a8714a;
  padding: 12px 16px 14px;
}
.room-mgmt__floor-section:last-child { border-bottom: none; }
.room-mgmt__floor-title {
  font-size: 14px;
  font-weight: 700;
  color: #8b5a2b;
  margin-bottom: 10px;
  letter-spacing: 0.5px;
}
.room-mgmt__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 10px;
  align-content: start;
}
.room-mgmt__cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 14px 6px;
  border: 1px solid #e3d9c4;
  border-left: 5px solid var(--cd, var(--c));
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.03);
  background: color-mix(in srgb, var(--c) 18%, #f3ecdb);
  cursor: default;
  transition: transform 0.12s, background 0.12s, border-color 0.12s;
}
.room-mgmt__cell:hover {
  transform: translateY(-2px);
  background: color-mix(in srgb, var(--c) 28%, #f3ecdb);
}
.room-mgmt__no { font-size: 16px; font-weight: 700; color: #2a241a; letter-spacing: 0.5px; }


/* 附件信息：查询区 + 字段表格 */
.attach-toolbar {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px 6px;
}
.attach-search, .attach-filter {
  appearance: none; outline: none;
  height: 30px; padding: 0 9px; font-size: 12.5px;
  color: #eaf2ff; background: #0e1626;
  border: 1px solid #35507a; border-radius: 5px;
}
.attach-search { width: 260px; flex: none; }
.attach-search::placeholder { color: #70809a; }
.attach-search:focus, .attach-filter:focus { border-color: #38bdf8; box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.14); }
.attach-filter { width: 110px; cursor: pointer; }
.attach-filter option { background: #0e1626; color: #eaf2ff; }
.attach-reset {
  appearance: none; cursor: pointer; font-size: 12px;
  height: 30px; padding: 0 12px; border-radius: 5px;
  border: 1px solid #3a4a66; background: transparent; color: #9fb0c8;
}
.attach-reset:hover { border-color: #38bdf8; color: #38bdf8; }
.attach-export {
  appearance: none; cursor: pointer; font-size: 12px; white-space: nowrap;
  height: 30px; padding: 0 12px; border-radius: 5px;
  margin-left: auto; /* 靠右对齐 */
  border: 1px solid #0b6fb8; color: #d7ecff;
  background: linear-gradient(180deg, #0d6fa8, #0a5686);
}
.attach-export:hover { filter: brightness(1.15); }
.attach-stats { padding: 2px 12px 8px; color: #8a97ad; font-size: 11.5px; }
.attach-stats b { color: #d7ecff; font-size: 12.5px; }
.attach-stats__sep { margin: 0 6px; color: #4a5a76; }
.attach-table {
  width: 100%; border-collapse: collapse;
  margin: 0 12px; width: calc(100% - 24px);
  font-size: 12px;
}
.attach-table th {
  text-align: left; padding: 8px 8px; white-space: nowrap;
  color: #9fb0c8; font-weight: 500; font-size: 11.5px;
  background: rgba(30, 42, 64, 0.7);
  border-bottom: 1px solid #2c3c58;
}
.attach-table td {
  padding: 8px; color: #d7e2f2; vertical-align: middle;
  border-bottom: 1px dashed #1e2a40;
}
.attach-table tbody tr:hover { background: rgba(56, 189, 248, 0.06); }
.attach-col-idx { width: 42px; }
.attach-col-type { width: 88px; }
.attach-col-fmt { width: 55px; }
.attach-col-size { width: 74px; }
.attach-col-time { width: 100px; }
.attach-col-op { width: 108px; }
.attach-idx { color: #7c8ba3; }
.attach-name-cell { display: flex; align-items: center; gap: 7px; min-width: 0; }
.attach-icon {
  flex: none; width: 26px; height: 26px; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; color: #fff; background: #3a4a66;
}
.attach-icon--img { background: #1d7a5a; }
.attach-name { color: #eaf2ff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag-sample {
  flex: none; font-style: normal; font-size: 10px;
  color: #f0b429; border: 1px solid #5a4a1e;
  background: rgba(240, 180, 41, 0.12);
  border-radius: 4px; padding: 0 5px;
}
.attach-ops { display: flex; gap: 5px; }
.attach-op {
  appearance: none; cursor: pointer; font-size: 11.5px;
  padding: 3px 8px; border-radius: 5px;
  border: 1px solid #2c3c58; background: transparent; color: #9fc6ff;
}
.attach-op:hover { border-color: #38bdf8; color: #38bdf8; }
.attach-op--primary { border-color: #0b6fb8; color: #d7ecff; background: rgba(11, 111, 184, 0.25); }

/* 资产信息卡片 */
.asset-summary {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 16px;
  padding: 12px 16px;
}
.asset-summary > div {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 0;
  font-size: 13px;
  border-bottom: 1px dashed #1e2a40;
}
.asset-summary span { color: #8a97ad; white-space: nowrap; }
.asset-summary b { color: #eaf2ff; text-align: right; }

/* 资产 / 楼层表格 */
.asset-table {
  width: calc(100% - 24px);
  margin: 10px 12px;
  border-collapse: collapse;
  font-size: 12.5px;
}
.asset-table th, .asset-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid #1e2a40;
}
.asset-table th { color: #8a97ad; font-weight: 600; }
.asset-table td { color: #eaf2ff; }
.asset-table tbody tr:hover { background: rgba(56, 189, 248, 0.06); }

.tab-note { margin: 4px 16px 14px; color: #7d8aa3; font-size: 11px; line-height: 1.6; }
.tab-empty { margin: 18px 16px; color: #7d8aa3; font-size: 13px; text-align: center; }

/* 变更记录时间线 */
.change-list { list-style: none; margin: 0; padding: 12px 16px; }
.change-item { display: flex; gap: 12px; padding-bottom: 16px; position: relative; }
.change-item:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 14px;
  bottom: 0;
  width: 1px;
  background: #24324a;
}
.change-dot {
  flex: none;
  width: 11px;
  height: 11px;
  margin-top: 3px;
  border-radius: 50%;
  background: #38bdf8;
  box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.18);
  z-index: 1;
}
.change-body { flex: 1; min-width: 0; }
.change-top { display: flex; justify-content: space-between; align-items: baseline; }
.change-top b { color: #eaf2ff; font-size: 13px; }
.change-top span { color: #8a97ad; font-size: 11px; }
.change-desc { color: #a7b4c8; font-size: 12px; line-height: 1.6; margin-top: 3px; }
.change-by { color: #7d8aa3; font-size: 11px; margin-top: 3px; }


/* 楼盘表面板 */
.room-panel {
  position: absolute;
  z-index: 130;
  left: 16px;
  top: 64px;
  width: 220px;
  border: 1px solid #24324a;
  border-radius: 8px;
  background: rgba(20, 27, 43, 0.95);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(12px);
  overflow: hidden;
}
.room-panel__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border-bottom: 1px solid #24324a;
  color: #eaf2ff;
}
.room-panel__head strong { flex: 1; font-size: 14px; font-weight: 600; }
.room-panel__exit {
  height: 26px;
  padding: 0 10px;
  border: 1px solid #f87171;
  border-radius: 4px;
  color: #fca5a5;
  background: transparent;
  font-size: 12px;
  cursor: pointer;
}
.room-panel__exit:hover { background: rgba(248, 113, 113, 0.15); }

.room-panel__alloc {
  height: 26px;
  padding: 0 10px;
  margin-right: 6px;
  border: 1px solid #22d3ee;
  border-radius: 4px;
  color: #a5f3fc;
  background: rgba(34, 211, 238, 0.12);
  font-size: 12px;
  cursor: pointer;
}
.room-panel__alloc:hover { background: rgba(34, 211, 238, 0.24); }

.floor-switch {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 12px 14px 8px;
}
.floor-switch__btn {
  min-width: 40px;
  height: 30px;
  border: 1px solid #33415c;
  border-radius: 4px;
  color: #a7b4c8;
  background: #1a2335;
  font-size: 12px;
  cursor: pointer;
}
.floor-switch__btn:hover { border-color: #38bdf8; color: #eaf2ff; }
.floor-switch__btn.active {
  border-color: #38bdf8;
  color: #0b1220;
  background: #38bdf8;
  font-weight: 600;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 6px 14px 12px;
}
.legend span {
  display: flex;
  align-items: center;
  gap: 5px;
  color: #a7b4c8;
  font-size: 11px;
}
.legend i {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  border: 1.5px solid transparent; /* 描边色由内联样式按状态传入（deep），浅色底点在浅背景上仍有边界 */
}

/* 房间详情（位置由 JS 按被点击的房间格子动态计算） */
.room-detail {
  position: absolute;
  z-index: 130;
  width: 280px;
  max-width: calc(100% - 24px);
  border: 1px solid #24324a;
  border-radius: 8px;
  background: rgba(20, 27, 43, 0.95);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(12px);
  overflow: hidden;
}
.room-detail__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid #24324a;
  color: #eaf2ff;
}
.room-detail__head strong { flex: 1; font-size: 15px; font-weight: 600; }
.room-detail__status { font-size: 12px; }
.room-detail__close {
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 4px;
  color: #8a97ad;
  background: transparent;
  font-size: 18px;
  cursor: pointer;
}
.room-detail__close:hover { color: #f87171; background: #22314a; }

.room-detail dl { margin: 0; padding: 6px 14px 12px; }
.room-detail dl div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  font-size: 13px;
  border-bottom: 1px dashed #1e2a40;
}
.room-detail dl div:last-child { border-bottom: 0; }
.room-detail dt { color: #8a97ad; }
.room-detail dd {
  margin: 0;
  color: #eaf2ff;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  text-align: right;
}
.room-detail__desc {
  margin: 0;
  padding: 0 14px 14px;
  color: #a7b4c8;
  font-size: 12px;
  line-height: 1.7;
}

.hint-bar {
  position: absolute;
  z-index: 120;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 14px;
  border: 1px solid #24324a;
  border-radius: 20px;
  color: #7d8aa3;
  background: rgba(20, 27, 43, 0.82);
  font-size: 11px;
  pointer-events: none;
  backdrop-filter: blur(8px);
}

/* 工具栏分组 */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  max-width: calc(100% - 32px);
  justify-content: flex-end;
}
.toolbar__group {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border: 1px solid #24324a;
  border-radius: 8px;
  background: rgba(20, 27, 43, 0.9);
  backdrop-filter: blur(8px);
}
.toolbar__label {
  padding: 0 6px 0 4px;
  color: #94a3b8;
  font-size: 11px;
  white-space: nowrap;
}
.toolbar__btn {
  height: 30px;
  padding: 0 12px;
  border: 1px solid #33415c;
  border-radius: 6px;
  color: #c3d0e5;
  background: transparent;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.toolbar__btn:hover { border-color: #38bdf8; color: #eaf2ff; }
.toolbar__btn.active {
  border-color: #38bdf8;
  color: #06121f;
  background: #38bdf8;
  font-weight: 600;
}
.toolbar__btn--ghost { border-style: dashed; color: #f87171; }
.toolbar__btn--ghost:hover { border-color: #f87171; background: rgba(248, 113, 113, 0.12); color: #fca5a5; }

/* 待开发功能占位条：单独占右上角第二行，避免加宽主工具栏压住居中的搜索框。
   按钮置灰 + 虚线边框 + not-allowed，明确「有此规划、暂不可点」。 */
.toolbar-pending {
  position: absolute;
  z-index: 120;
  top: 64px;
  right: 16px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border: 1px solid #24324a;
  border-radius: 8px;
  background: rgba(20, 27, 43, 0.9);
  backdrop-filter: blur(8px);
}
.toolbar-pending .toolbar__label {
  padding: 0 4px;
  color: #64748b;
}
.toolbar__btn--pending,
.toolbar__btn--pending:hover {
  border-color: #3b475c;
  border-style: dashed;
  color: #8492a8;
  background: rgba(30, 41, 59, 0.45);
  font-weight: 400;
  cursor: not-allowed;
  opacity: 0.78;
}
.toolbar__btn__tag {
  margin-left: 2px;
  font-size: 10px;
  color: #7b8aa1;
}

/* 「打印 / 导出」独立按钮：底图为浅色（白/淡蓝）时，
   原来的透明底 + 浅色字会糊成一片。这里改成实底 + 高对比文字，
   并加深色投影与旁边的深色分组对齐；不套外层容器以免挤到搜索框。 */
.toolbar__btn--standalone {
  height: 40px;
  padding: 0 12px;
  border-color: #475569;
  color: #f8fafc;
  background: rgba(30, 41, 59, 0.96);
  font-weight: 600;
  box-shadow: 0 6px 18px rgba(2, 6, 23, 0.28);
  backdrop-filter: blur(8px);
}
.toolbar__btn--standalone:hover {
  border-color: #38bdf8;
  background: #334155;
  color: #ffffff;
}
.toolbar__btn--standalone.active {
  border-color: #38bdf8;
  background: #38bdf8;
  color: #06121f;
  font-weight: 700;
}
/* 「打印 / 导出」作为主操作：蓝色实底 + 白字 */
.toolbar__btn--standalone.toolbar__btn--primary {
  border-color: #3b82f6;
  color: #ffffff;
  background: #2563eb;
}
.toolbar__btn--standalone.toolbar__btn--primary:hover {
  border-color: #60a5fa;
  background: #3b82f6;
  color: #ffffff;
}

/* 旋转操作引导条：旋转模式时常驻在画面上方，明确告知如何操作/退出 */
.rotate-guide {
  position: absolute;
  z-index: 165;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: calc(100% - 32px);
  padding: 10px 14px;
  border: 1px solid #a78bfa;
  border-radius: 12px;
  background: rgba(16, 24, 40, 0.95);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(10px);
}
.rotate-guide__dot {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #a78bfa;
  box-shadow: 0 0 0 4px rgba(167, 139, 250, 0.18);
}
.rotate-guide__text { display: flex; flex-direction: column; gap: 2px; }
.rotate-guide__text strong { font-size: 13px; font-weight: 700; color: #eaf2ff; }
.rotate-guide__text span { font-size: 12px; color: #b6c4da; }
.rotate-guide__exit {
  flex: none;
  height: 28px;
  padding: 0 10px;
  border: 1px solid #475569;
  border-radius: 6px;
  color: #eaf2ff;
  background: rgba(71, 85, 105, 0.5);
  font-size: 12px;
  cursor: pointer;
}
.rotate-guide__exit:hover { border-color: #a78bfa; background: rgba(167, 139, 250, 0.2); }
.rotate-guide__exit kbd,
.measure-guide__finish kbd,
.measure-guide__cancel kbd {
  margin-left: 4px;
  padding: 1px 4px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 3px;
  font-size: 10px;
  font-family: inherit;
  opacity: 0.8;
}

/* 右下角罗盘：N 指向正北，拖动旋转 / 单击复位。避开底部中间的 hint-bar。 */
.compass {
  position: absolute;
  z-index: 140;
  right: 18px;
  bottom: 58px;
  width: 62px;
  height: 62px;
  border-radius: 50%;
  border: 1px solid #475569;
  background: rgba(16, 24, 40, 0.88);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(8px);
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.compass--dragging { cursor: grabbing; }
.compass:hover { border-color: #a78bfa; }
.compass__face { position: relative; width: 100%; height: 100%; border-radius: 50%; }
.compass__n {
  position: absolute;
  top: 3px;
  left: 50%;
  transform: translateX(-50%);
  color: #f87171;
  font-size: 11px;
  font-weight: 800;
  line-height: 1;
}
.compass__needle {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 4px;
  height: 38px;
  transform-origin: 50% 50%;
}
.compass__tip {
  position: absolute;
  left: 50%;
  width: 0;
  height: 0;
  transform: translateX(-50%);
  border-left: 3px solid transparent;
  border-right: 3px solid transparent;
}
.compass__tip--n {
  top: 0;
  border-bottom: 18px solid #ef4444;
}
.compass__tip--s {
  bottom: 0;
  border-top: 18px solid #94a3b8;
}
.compass__center {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 8px;
  height: 8px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  background: #e2e8f0;
  box-shadow: 0 0 0 2px rgba(15, 23, 42, 0.7);
}

/* 量算操作引导条：测量进行时常驻在画面上方，明确告知如何结束 */
.measure-guide {
  position: absolute;
  z-index: 165;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  max-width: calc(100% - 32px);
  padding: 10px 14px 8px;
  border: 1px solid #38bdf8;
  border-radius: 12px;
  background: rgba(16, 24, 40, 0.95);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(10px);
}
.measure-guide--area { border-color: #f59e0b; }
.measure-guide__dot {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #38bdf8;
  box-shadow: 0 0 0 4px rgba(56, 189, 248, 0.18);
}
.measure-guide--area .measure-guide__dot { background: #f59e0b; box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.18); }
.measure-guide__text { display: flex; flex-direction: column; gap: 2px; min-width: 210px; }
.measure-guide__text strong { font-size: 13px; font-weight: 700; color: #eaf2ff; }
.measure-guide__text span { font-size: 12px; color: #b6c4da; }
.measure-guide__finish {
  border: 0;
  border-radius: 8px;
  padding: 9px 15px;
  background: #22c55e;
  color: #052e16;
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.18);
}
.measure-guide__finish:hover { background: #4ade80; }
.measure-guide__cancel {
  border: 1px solid #3a4a63;
  border-radius: 8px;
  padding: 8px 12px;
  background: transparent;
  color: #a7b4c8;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.measure-guide__cancel:hover { border-color: #f87171; color: #fca5a5; }
.measure-guide__sub { flex-basis: 100%; text-align: center; font-size: 11px; color: #8a97ad; }
.measure-guide kbd {
  display: inline-block;
  margin-left: 4px;
  padding: 1px 5px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 4px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 10px;
  font-weight: 600;
  opacity: 0.85;
}

/* 量算结果面板 */
/* 结果卡片现在锚定在测绘范围内（left/top 由 measurePanelStyle 计算），不再是固定右下角 */
.measure-panel {
  position: absolute;
  z-index: 150;
  width: 236px;
  max-width: calc(100% - 24px);
  border: 1px solid #38bdf8;
  border-radius: 10px;
  background: rgba(16, 24, 40, 0.94);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(10px);
  overflow: hidden;
  /* 卡片浮在地图中间：只让「关闭按钮 / 分段列表」接收指针事件，
     其余部分点击穿透到地图，不挡继续打点或重新测量 */
  pointer-events: none;
}
.measure-panel--area { border-color: #f59e0b; }
.measure-panel__close, .measure-panel__segs { pointer-events: auto; }

/* 锚点小圆点：标出这张结果卡片对应的是哪一处测绘图形 */
.measure-anchor {
  position: absolute;
  z-index: 149;
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  border: 2px solid #38bdf8;
  border-radius: 50%;
  background: rgba(56, 189, 248, 0.25);
  box-shadow: 0 0 0 5px rgba(56, 189, 248, 0.18), 0 0 12px rgba(56, 189, 248, 0.6);
  pointer-events: none;
}
.measure-anchor--area {
  border-color: #f59e0b;
  background: rgba(245, 158, 11, 0.25);
  box-shadow: 0 0 0 5px rgba(245, 158, 11, 0.18), 0 0 12px rgba(245, 158, 11, 0.6);
}
.measure-panel__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid #24324a;
  color: #eaf2ff;
}
.measure-panel__head strong { flex: 1; font-size: 13px; font-weight: 600; }
.measure-panel__state {
  flex: none;
  padding: 2px 7px;
  border-radius: 10px;
  font-size: 11px;
  color: #8a97ad;
  background: rgba(138, 151, 173, 0.12);
}
.measure-panel__state--live {
  color: #86efac;
  background: rgba(34, 197, 94, 0.16);
  border: 1px solid rgba(34, 197, 94, 0.35);
}
.measure-panel__close {
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 4px;
  color: #8a97ad;
  background: transparent;
  font-size: 17px;
  cursor: pointer;
}
.measure-panel__close:hover { color: #f87171; background: #22314a; }
.measure-panel__body { padding: 10px 12px; }
.measure-panel__total { font-size: 13px; color: #a7b4c8; }
.measure-panel__total b {
  color: #38bdf8;
  font-size: 16px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.measure-panel--area .measure-panel__total b { color: #f59e0b; }
.measure-panel__segs {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  max-height: 96px;
  overflow-y: auto;
}
.measure-panel__segs li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 5px 8px;
  border-radius: 4px;
  margin-bottom: 4px;
  font-size: 12px;
  color: #c3d0e5;
  background: rgba(56, 189, 248, 0.08);
}
.measure-panel--area .measure-panel__segs li { background: rgba(245, 158, 11, 0.1); }
.measure-panel__segs li span:last-child { font-family: ui-monospace, monospace; color: #eaf2ff; }
.measure-panel__meta { margin-top: 6px; font-size: 12px; color: #8a97ad; }
.measure-panel__tip {
  padding: 7px 10px;
  border-top: 1px solid #24324a;
  color: #b6c4da;
  font-size: 11px;
  line-height: 1.5;
}

</style>
