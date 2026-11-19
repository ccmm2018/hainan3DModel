// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import FloorPlan2D from '../FloorPlan2D.vue';
import { useBuildingStore } from '../../stores/building';
import { parseDxfToResult } from '../../utils/dxfParser';
import { SAMPLE_DXF } from '../../mock/mockData';

// ---- 最小化的 element-plus stub（保证 slot 渲染与 v-model 行为）----
const ElDialog = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: `<div v-if="modelValue" class="el-dialog-stub"><slot/></div>`,
};
const ElButton = {
  props: ['type', 'plain', 'text', 'size'],
  emits: ['click'],
  template: `<button class="el-button-stub" @click="$emit('click', $event)"><slot/></button>`,
};
const ElInput = {
  props: ['modelValue', 'size', 'type', 'rows', 'placeholder'],
  emits: ['update:modelValue'],
  template: `<input class="el-input-stub" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />`,
};
const ElSelect = {
  props: ['modelValue', 'size', 'placeholder', 'filterable', 'allowCreate', 'defaultFirstOption'],
  emits: ['update:modelValue'],
  template: `<select class="el-select-stub" :value="modelValue"><slot/></select>`,
};
const ElOption = {
  props: ['label', 'value'],
  template: `<option class="el-option-stub" :value="value">{{ label }}</option>`,
};
const ElEmpty = { props: ['description'], template: `<div class="el-empty-stub"></div>` };
const passthrough = (name: string) => ({
  name,
  props: ['modelValue', 'size', 'label', 'value'],
  emits: ['update:modelValue', 'change'],
  template: `<div class="${name}"><slot/></div>`,
});

const stubs = {
  'el-dialog': ElDialog,
  'el-button': ElButton,
  'el-input': ElInput,
  'el-select': ElSelect,
  'el-option': ElOption,
  'el-empty': ElEmpty,
  'el-radio-group': passthrough('el-radio-group'),
  'el-radio-button': passthrough('el-radio-button'),
  'el-checkbox': passthrough('el-checkbox'),
  'el-slider': passthrough('el-slider'),
  'el-button-group': passthrough('el-button-group'),
};

function mountPlan(buildingName: string, pinia: any): VueWrapper<any> {
  return mount(FloorPlan2D, {
    props: { modelValue: true, buildingName, fullscreen: true },
    global: { stubs, plugins: [pinia] },
    attachTo: document.body,
  });
}

describe('FloorPlan2D 房间编辑/隐藏/重新显示', () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  it('真实楼层：编辑名称后弹窗标题与图层 label 应更新，隐藏后可重新显示', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    // 清空名称，模拟“未命名”初始态
    parsed.rooms.forEach((r) => {
      r.name = '';
      r.code = '';
      r.selected = true;
    });
    const fid = store.importFloor({
      buildingName: '教学楼',
      floorNo: 1,
      fileName: 'a.dxf',
      parsed,
      coordSource: 'local',
      transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 },
    });
    expect(store.roomsOfFloor(fid).length).toBeGreaterThan(0);
    console.log('DEBUG getFloor=', store.getFloor('教学楼', 1)?.id, 'floorsOf=', store.floorsOf('教学楼'), 'roomIds=', store.roomsOfFloor(fid).map((r) => r.id));

    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();

    // 找到房间色块并点击（房间来自 roomBlocks，渲染为 .fpv-room）
    let roomEls = wrapper.findAll('.fpv-room');
    console.log('DEBUG roomEls.length=', roomEls.length);
    expect(roomEls.length).toBeGreaterThan(0);
    await roomEls[0].trigger('click');
    await nextTick();

    // s498：只读态（未点「编辑本房间」）业务状态是纯展示——只有状态标签、无可点击按钮 / 清空 / 引导文案
    expect(wrapper.find('.fpv-pop__body .fpv-pop__status-chip').exists()).toBe(true);
    expect(wrapper.find('.fpv-pop__body .fpv-pop__status-btn').exists()).toBe(false);
    expect(wrapper.find('.fpv-pop__body').text()).not.toContain('点色块直接改');
    expect(wrapper.find('.fpv-pop__body').text()).not.toContain('清空');

    // 打开“编辑本房间”
    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('编辑本房间'));
    expect(editBtn).toBeTruthy();
    await editBtn!.trigger('click');
    await nextTick();

    // 编辑本房间：基础资料单表单，一次保存（维护台账已移除，部门改为下拉）
    expect(wrapper.find('.fpv-pop__form--all').exists()).toBe(true);
    expect(wrapper.find('.fpv-pop__section').exists()).toBe(true);
    // s496：部门是下拉（el-select），不是手动输入框；维护台账及其字段已彻底移除
    expect(wrapper.find('.fpv-pop__form--all .el-select-stub').exists()).toBe(true);
    expect(wrapper.find('.fpv-pop__form--all').text()).not.toContain('维护台账');
    expect(wrapper.find('.fpv-pop__form--all').text()).not.toContain('责任部门');
    // s497：编辑态与只读态显示项一致——也要有审图状态 + 业务状态色块
    const editFormText = wrapper.find('.fpv-pop__form--all').text();
    expect(editFormText).toContain('审图状态');
    expect(editFormText).toContain('业务状态');
    expect(wrapper.find('.fpv-pop__form--all .fpv-pop__status-btn').exists()).toBe(true);
    // 合并表单第一项仍是房间号、第二项是名称（绑定 editRoom.name）
    const editNameInput = wrapper.findAll('input.el-input-stub')[1];
    expect(editNameInput.exists()).toBe(true);

    // 找到名称输入框并写入新名称
    const nameInput = wrapper.findAll('input.el-input-stub')[1]; // 第2个输入框=名称
    await nameInput.setValue('测试会议室A');
    await nextTick();

    // 点击保存
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存'));
    expect(saveBtn).toBeTruthy();
    await saveBtn!.trigger('click');
    await nextTick();
    await nextTick();

    // s493: 弹窗标题始终固定为房号，不随名称变化（改名称后标题仍是 101）
    const title = wrapper.find('.fpv-pop__title').text();
    console.log('TITLE_AFTER_SAVE=', title);
    expect(title).toBe('101');
    // 名称改在弹窗「名称」信息行体现
    expect(findCell(wrapper, '名称')).toContain('测试会议室A');

    // 断言：store 里【被点击那间】房间名称已更新（真实模式写入 store）
    const updated = store.roomsOfFloor(fid).find((r) => r.name === '测试会议室A');
    console.log('STORE_MATCHED=', !!updated, 'storeNames=', store.roomsOfFloor(fid).map((r) => r.name));
    expect(updated).toBeTruthy();

    // ---- 隐藏 + 恢复 链路 ----
    // 「从视图隐藏」在「编辑本房间」表单内；保存后会自动回到只读态，需先重新展开表单
    const reopenEdit = wrapper.findAll('button').find((b) => b.text().includes('编辑本房间'));
    expect(reopenEdit).toBeTruthy();
    await reopenEdit!.trigger('click');
    await nextTick();
    const beforeHide = wrapper.findAll('.fpv-room').length;
    const hideBtn = wrapper.findAll('button').find((b) => b.text().includes('从视图隐藏'));
    expect(hideBtn).toBeTruthy();
    await hideBtn!.trigger('click');
    await nextTick();
    await nextTick();
    const afterHide = wrapper.findAll('.fpv-room').length;
    console.log('REAL beforeHide=', beforeHide, 'afterHide=', afterHide);
    expect(afterHide).toBe(beforeHide - 1);

    // 侧栏应出现「已隐藏房间」及「显示」入口
    const showBtn = wrapper.findAll('button').find((b) => b.text().trim() === '显示');
    console.log('REAL hasShowBtn=', !!showBtn);
    expect(showBtn).toBeTruthy();
    await showBtn!.trigger('click');
    await nextTick();
    await nextTick();
    const afterShow = wrapper.findAll('.fpv-room').length;
    console.log('REAL afterShow=', afterShow);
    expect(afterShow).toBe(beforeHide);

    wrapper.unmount();
  });

  it('未导入DXF(demo模式)：编辑名称应更新标题、隐藏后图层移除且可重新显示', async () => {
    const store = useBuildingStore();
    // 注意：不调用 importFloor —— 该楼有轮廓但无楼层，走 demo 12 宫格
    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();

    const roomEls = wrapper.findAll('.fpv-room');
    console.log('DEMO roomEls.length=', roomEls.length);
    expect(roomEls.length).toBeGreaterThan(0);

    // 记一下初始标题（demo 房间有样例名，不应是“测试会议室B”）
    await roomEls[0].trigger('click');
    await nextTick();

    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('编辑本房间'));
    expect(editBtn).toBeTruthy();
    await editBtn!.trigger('click');
    await nextTick();

    const nameInput = wrapper.findAll('input.el-input-stub')[1]; // 第2个输入框=名称
    await nameInput.setValue('测试会议室B');
    await nextTick();

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存'));
    await saveBtn!.trigger('click');
    await nextTick();
    await nextTick();

    // s493: 标题固定为房号，不随名称变化；名称在信息行体现
    const titleAfter = wrapper.find('.fpv-pop__title').text();
    console.log('DEMO TITLE_AFTER=', titleAfter);
    expect(titleAfter).toBe('101');
    expect(findCell(wrapper, '名称')).toContain('测试会议室B');

    // 隐藏该房间：保存后表单自动收起，先重新展开「编辑本房间」
    const reopenEdit = wrapper.findAll('button').find((b) => b.text().includes('编辑本房间'));
    expect(reopenEdit).toBeTruthy();
    await reopenEdit!.trigger('click');
    await nextTick();
    const hideBtn = wrapper.findAll('button').find((b) => b.text().includes('从视图隐藏'));
    expect(hideBtn).toBeTruthy();
    await hideBtn!.trigger('click');
    await nextTick();
    await nextTick();

    const afterHide = wrapper.findAll('.fpv-room').length;
    console.log('DEMO roomEls after hide=', afterHide);
    expect(afterHide).toBe(roomEls.length - 1);

    // 此时应出现“已隐藏房间”并可重新显示
    const showBtn = wrapper.findAll('button').find((b) => b.text().includes('显示'));
    console.log('DEMO hasShowBtn=', !!showBtn);
    expect(showBtn).toBeTruthy();
    await showBtn!.trigger('click');
    await nextTick();
    await nextTick();

    const afterShow = wrapper.findAll('.fpv-room').length;
    console.log('DEMO roomEls after show=', afterShow);
    expect(afterShow).toBe(roomEls.length);

    wrapper.unmount();
  });

  it('复现用户场景：房间 code="面试"、name=""，编辑名称后弹窗名称格与标题都应更新', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    parsed.rooms.forEach((r, i) => {
      r.name = '';
      r.code = i === 0 ? '面试' : ''; // 第一个房间 code=面试，name 为空
      r.selected = true;
    });
    const fid = store.importFloor({
      buildingName: '教学楼',
      floorNo: 1,
      fileName: 'a.dxf',
      parsed,
      coordSource: 'local',
      transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 },
    });
    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();

    const roomEls = wrapper.findAll('.fpv-room');
    expect(roomEls.length).toBeGreaterThan(0);
    await roomEls[0].trigger('click');
    await nextTick();

    // s491: 统一房间号口径——name 为空时标题回退显示「房间号码」(number=101)，与顶面一致；
    // 不再显示房间编码(code=面试)。名称格仍显示「（未命名）」。
    const title0 = wrapper.find('.fpv-pop__title').text();
    const nameCell0 = findCell(wrapper, '名称');
    console.log('USER title0=', title0, 'nameCell0=', nameCell0);
    expect(title0).toContain('101');
    expect(nameCell0).toContain('未命名');

    // 打开编辑本房间 → 在“名称”输入框写新名称 → 保存
    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('编辑本房间'));
    await editBtn!.trigger('click');
    await nextTick();
    const nameInput = wrapper.findAll('input.el-input-stub')[1];
    await nameInput.setValue('面试会议室');
    await nextTick();
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存'));
    await saveBtn!.trigger('click');
    await nextTick();
    await nextTick();

    // s493: 标题固定为房号 101（不随名称变化）；名称在信息行体现为新值
    const title1 = wrapper.find('.fpv-pop__title').text();
    const nameCell1 = findCell(wrapper, '名称');
    console.log('USER title1=', title1, 'nameCell1=', nameCell1);
    expect(title1).toBe('101');
    expect(nameCell1).toContain('面试会议室');
    // store 也应写入
    expect(store.roomsOfFloor(fid).find((r) => r.name === '面试会议室')).toBeTruthy();

    wrapper.unmount();
  });

  it('问题1回归：房间 name 是面积文本(如「45.2㎡」)时，弹窗标题不得显示面积，应回退房间号', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    parsed.rooms.forEach((r, i) => {
      r.name = i === 0 ? '面积 45.2㎡' : ''; // 第一个房间 name 被误存成面积文本
      r.code = i === 0 ? 'A101' : '';
      r.selected = true;
    });
    const fid = store.importFloor({
      buildingName: '教学楼',
      floorNo: 1,
      fileName: 'a.dxf',
      parsed,
      coordSource: 'local',
      transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 },
    });
    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();

    const roomEls = wrapper.findAll('.fpv-room');
    expect(roomEls.length).toBeGreaterThan(0);
    await roomEls[0].trigger('click');
    await nextTick();

    const title = wrapper.find('.fpv-pop__title').text();
    console.log('ISSUE1 title=', title);
    // 标题不应出现“面积”
    expect(title).not.toContain('面积');
    // s491: 回退显示「房间号码」number=101（与顶面一致），而非房间编码 A101
    expect(title).toContain('101');
    expect(title).not.toContain('A101');

    wrapper.unmount();
  });

  it('问题2回归：房间 name 初始为面积文本、code 为空，编辑名称为纯数字(101)后标题应显示该数字而非未命名', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    parsed.rooms.forEach((r, i) => {
      // 用户真实数据：名称被误存为面积文本，且房间号/code 为空 → 标题只能靠名称
      r.name = i === 0 ? '面积 45.2㎡' : '';
      r.code = '';
      r.selected = true;
    });
    const fid = store.importFloor({
      buildingName: '教学楼',
      floorNo: 1,
      fileName: 'a.dxf',
      parsed,
      coordSource: 'local',
      transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 },
    });
    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();

    const roomEls = wrapper.findAll('.fpv-room');
    expect(roomEls.length).toBeGreaterThan(0);
    await roomEls[0].trigger('click');
    await nextTick();

    // s491: 编辑前名称是面积文本、code 为空，但房间号码 number=101 有值 →
    // 标题回退显示 101（与顶面一致），不再是「未命名房间」。
    const title0 = wrapper.find('.fpv-pop__title').text();
    console.log('ISSUE2 title0=', title0);
    expect(title0).toContain('101');
    expect(title0).not.toContain('未命名');

    // 打开编辑本房间 → 名称输入框写入纯数字「101」→ 保存
    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('编辑本房间'));
    await editBtn!.trigger('click');
    await nextTick();
    const nameInput = wrapper.findAll('input.el-input-stub')[1];
    await nameInput.setValue('101');
    await nextTick();
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存'));
    await saveBtn!.trigger('click');
    await nextTick();
    await nextTick();

    // 新 UI：点击「保存资料」后自动回到只读态，无需再点一次按钮收起表单
    // 标题必须显示「101」，且不再显示未命名
    const title1 = wrapper.find('.fpv-pop__title').text();
    const nameCell1 = findCell(wrapper, '名称');
    console.log('ISSUE2 title1=', title1, 'nameCell1=', nameCell1);
    expect(title1).toContain('101');
    expect(title1).not.toContain('未命名');
    expect(nameCell1).toContain('101');
    // store 也应写入
    expect(store.roomsOfFloor(fid).find((r) => r.name === '101')).toBeTruthy();

    wrapper.unmount();
  });

  // s491 回归：顶面房间号(number)与弹窗房间号(code)字段不一致 + 编辑态名称回填面积脏值
  it('s491：弹窗房间号与顶面房号统一(number优先)，编辑态名称不回填面积脏值', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    parsed.rooms.forEach((r, i) => {
      if (i === 0) {
        r.code = 'B1-F2-R04';   // 房间编码
        r.number = '204';       // 房间号码（顶面显示、用户认知的房号）
        r.name = '面积:69.84';  // DXF 误把面积存进 name
        r.useArea = 69.84;
        r.buildArea = 69.84;
      } else { r.code = ''; r.number = ''; r.name = ''; }
      r.selected = true;
    });
    store.importFloor({
      buildingName: '教学楼', floorNo: 1, fileName: 'a.dxf', parsed,
      coordSource: 'local', transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 },
    });
    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();

    const roomEls = wrapper.findAll('.fpv-room');
    await roomEls[0].trigger('click');
    await nextTick();
    // 弹窗标题与信息格「房间号」都显示 204，而非编码 B1-F2-R04
    expect(wrapper.find('.fpv-pop__title').text()).toBe('204');
    expect(findCell(wrapper, '房间号')).toBe('204');
    // 只读态名称为未命名
    expect(findCell(wrapper, '名称')).toContain('未命名');

    // s492: 点「编辑本房间」：名称输入框与只读态一致显示「（未命名）」（不是面积脏值「面积:69.84」），
    // 房间号输入框显示 204（不是编码 B1-F2-R04）——两栏都要和只读态对应上。
    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('编辑本房间'));
    await editBtn!.trigger('click');
    await nextTick();
    const rows = wrapper.findAll('.fpv-edit__row');
    const nameRow = rows.find((r) => r.find('label')?.text().trim() === '名称');
    const nameVal = nameRow?.find('input')?.element?.value;
    expect(nameVal).toContain('未命名');
    expect(nameVal).not.toContain('面积');
    const noRow = rows.find((r) => r.find('label')?.text().trim() === '房间号');
    expect(noRow?.find('input')?.element?.value).toBe('204');

    wrapper.unmount();
  });

  // s492 复现：编辑态「房间号」栏应与弹窗房间号(number优先)一致，「名称」栏应与只读态名称一致
  it('s492：编辑本房间时房间号栏=204(非编码B1-F2-R04)、名称栏=只读态名称', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    parsed.rooms.forEach((r, i) => {
      if (i === 0) {
        r.code = 'B1-F2-R04'; r.number = '204'; r.name = '面积:69.84';
        r.useArea = 69.84; r.buildArea = 69.84;
      } else { r.code = ''; r.number = ''; r.name = ''; }
      r.selected = true;
    });
    store.importFloor({
      buildingName: '教学楼', floorNo: 1, fileName: 'a.dxf', parsed,
      coordSource: 'local', transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 },
    });
    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();
    await wrapper.findAll('.fpv-room')[0].trigger('click');
    await nextTick();

    const readonlyRoomNo = findCell(wrapper, '房间号');
    const readonlyName = findCell(wrapper, '名称');
    console.log('S492 readonly: roomNo=', readonlyRoomNo, 'name=', readonlyName);

    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('编辑本房间'));
    await editBtn!.trigger('click');
    await nextTick();
    const rows = wrapper.findAll('.fpv-edit__row');
    const noRow = rows.find((r) => r.find('label')?.text().trim() === '房间号');
    const nameRow = rows.find((r) => r.find('label')?.text().trim() === '名称');
    const noVal = noRow?.find('input')?.element?.value;
    const nameVal = nameRow?.find('input')?.element?.value;
    console.log('S492 edit inputs: roomNo=', JSON.stringify(noVal), 'name=', JSON.stringify(nameVal));

    // 用户核心诉求：编辑态两个栏都要与只读态/房间本身对应上
    expect(noVal).toBe(readonlyRoomNo);       // 房间号栏 = 弹窗房间号 204
    expect(noVal).toBe('204');
    expect(noVal).not.toContain('B1-F2-R04');
    expect(nameVal).toBe(readonlyName);       // 名称栏 = 弹窗只读态名称（未命名）
    expect(nameVal).toContain('未命名');

    wrapper.unmount();
  });

  // s493 复现：弹窗标题始终固定为房号，改名称后标题不变（不再跳变成名称值）
  it('s493：改名称后弹窗顶部标题保持房号204不变', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    parsed.rooms.forEach((r, i) => {
      if (i === 0) {
        r.code = 'B1-F2-R04'; r.number = '204'; r.name = '面积:69.84';
        r.useArea = 69.84; r.buildArea = 69.84;
      } else { r.code = ''; r.number = ''; r.name = ''; }
      r.selected = true;
    });
    store.importFloor({
      buildingName: '教学楼', floorNo: 1, fileName: 'a.dxf', parsed,
      coordSource: 'local', transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 },
    });
    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();
    await wrapper.findAll('.fpv-room')[0].trigger('click');
    await nextTick();

    const titleBefore = wrapper.find('.fpv-pop__title').text();
    console.log('S493 titleBefore=', titleBefore);
    expect(titleBefore).toBe('204');

    // 打开编辑 → 改名称为「办公室」→ 标题应仍是 204
    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('编辑本房间'));
    await editBtn!.trigger('click');
    await nextTick();
    const nameInput = wrapper.findAll('.fpv-edit__row').find((r) => r.find('label')?.text().trim() === '名称')!.find('input');
    await nameInput.setValue('办公室');
    await nextTick();
    const titleWhileEdit = wrapper.find('.fpv-pop__title').text();
    console.log('S493 titleWhileEdit=', titleWhileEdit);
    expect(titleWhileEdit).toBe('204');

    // 保存后标题仍固定为 204，名称在信息行显示「办公室」
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存'));
    await saveBtn!.trigger('click');
    await nextTick();
    await nextTick();
    const titleAfter = wrapper.find('.fpv-pop__title').text();
    console.log('S493 titleAfter=', titleAfter, 'nameCell=', findCell(wrapper, '名称'));
    expect(titleAfter).toBe('204');
    expect(findCell(wrapper, '名称')).toBe('办公室');

    wrapper.unmount();
  });

  it('s500: 编辑态点业务状态色块只暂存，点保存资料后才写入 store', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    parsed.rooms.forEach((r) => {
      r.selected = true;
      r.useStatus = 'vacant'; // 统一初始状态，便于断言
    });
    const fid = store.importFloor({
      buildingName: '教学楼', floorNo: 1, fileName: 's500.dxf', parsed,
      coordSource: 'local',
      transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 },
    });
    const rooms = store.roomsOfFloor(fid);
    expect(rooms.length).toBeGreaterThan(0);
    rooms.forEach((r) => expect(r.useStatus).toBe('vacant'));

    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();
    await wrapper.findAll('.fpv-room')[0].trigger('click');
    await nextTick();
    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('编辑本房间'));
    await editBtn!.trigger('click');
    await nextTick();

    // 编辑态高亮当前状态（vacant=空置），点「无权限」色块只改暂存，不写库
    const form = wrapper.find('.fpv-pop__form--all');
    expect(form.text()).toContain('点色块选择，保存后生效');
    const noaccessBtn = form.findAll('.fpv-pop__status-btn').find((b) => b.text().includes('无权限'));
    expect(noaccessBtn).toBeTruthy();
    await noaccessBtn!.trigger('click');
    await nextTick();
    // 暂存高亮切到无权限，但 store 里所有房间仍是 vacant（未点保存）
    expect(noaccessBtn!.classes()).toContain('is-on');
    rooms.forEach((r) => expect(r.useStatus).toBe('vacant'));

    // 点保存资料 → 状态才写入 store
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存资料'));
    await saveBtn!.trigger('click');
    await nextTick();
    await nextTick();
    expect(store.roomsOfFloor(fid).some((r) => r.useStatus === 'noaccess')).toBe(true);

    wrapper.unmount();
  });

  it('合并：点合并先弹参数表单不立即合并，房号必填，确认后按填写参数写入新房', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    parsed.rooms.forEach((r) => { r.selected = true; r.dept = '教务处'; });
    const fid = store.importFloor({
      buildingName: '教学楼', floorNo: 1, fileName: 'merge.dxf', parsed,
      coordSource: 'local', transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 },
    });
    const countBefore = store.roomsOfFloor(fid).length;

    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();
    // 进入编辑结构态
    const editStructBtn = wrapper.findAll('button').find((b) => b.text().includes('编辑结构'));
    expect(editStructBtn).toBeTruthy();
    await editStructBtn!.trigger('click');
    await nextTick();

    // 选中前两间房（编辑态选中走 mousedown）
    const rooms = wrapper.findAll('.fpv-room');
    await rooms[0].trigger('mousedown');
    await rooms[1].trigger('mousedown');
    await nextTick();

    // 点合并：只应弹表单，store 不应变化
    const mergeBtn = wrapper.findAll('button').find((b) => b.text().includes('合并'));
    expect(mergeBtn).toBeTruthy();
    await mergeBtn!.trigger('click');
    await nextTick();
    expect((wrapper.vm as any).mergeVisible).toBe(true);
    expect(store.roomsOfFloor(fid).length).toBe(countBefore);

    // 房号留空点确认 → 被拦截，store 不变
    const vm = wrapper.vm as any;
    vm.mergeForm.number = '';
    await nextTick();
    vm.confirmMerge();
    await nextTick();
    expect((wrapper.vm as any).mergeVisible).toBe(true);
    expect(store.roomsOfFloor(fid).length).toBe(countBefore);

    // 填写参数后确认 → 真正合并，房间数 -1，新房参数写入
    vm.mergeForm.number = '301';
    vm.mergeForm.name = '合并教室';
    vm.mergeForm.dept = '学生处';
    await nextTick();
    vm.confirmMerge();
    await nextTick();
    await nextTick();
    expect(store.roomsOfFloor(fid).length).toBe(countBefore - 1);
    const merged = store.roomsOfFloor(fid).find((r) => r.number === '301');
    expect(merged).toBeTruthy();
    expect(merged!.name).toBe('合并教室');
    expect(merged!.dept).toBe('学生处');

    wrapper.unmount();
  });

  it('拆分：点拆分弹表单且默认预填各子房房号，确认后按填写参数写入子房', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    parsed.rooms.forEach((r) => { r.selected = true; });
    const fid = store.importFloor({
      buildingName: '教学楼', floorNo: 1, fileName: 'split.dxf', parsed,
      coordSource: 'local', transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 },
    });
    const countBefore = store.roomsOfFloor(fid).length;

    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();
    const editStructBtn = wrapper.findAll('button').find((b) => b.text().includes('编辑结构'));
    await editStructBtn!.trigger('click');
    await nextTick();

    // 只选中一间
    await wrapper.findAll('.fpv-room')[0].trigger('mousedown');
    await nextTick();
    const splitBtn = wrapper.findAll('button').find((b) => b.text().includes('拆分'));
    expect(splitBtn).toBeTruthy();
    await splitBtn!.trigger('click');
    await nextTick();

    const vm = wrapper.vm as any;
    expect(vm.splitVisible).toBe(true);
    expect(vm.splitForms.length).toBe(2);
    // 默认预填：房号带 -1 / -2 后缀
    expect(vm.splitForms[0].number).toContain('-1');
    expect(vm.splitForms[1].number).toContain('-2');

    // 房号留空一间 → 拦截
    vm.splitForms[0].number = '';
    await nextTick();
    vm.confirmSplit();
    await nextTick();
    expect((wrapper.vm as any).splitVisible).toBe(true);
    expect(store.roomsOfFloor(fid).length).toBe(countBefore);

    // 逐间填写参数后确认 → 房间数 +1，子房参数按填写写入
    vm.splitForms[0].number = '401';
    vm.splitForms[0].name = '拆分A';
    vm.splitForms[1].number = '402';
    vm.splitForms[1].name = '拆分B';
    await nextTick();
    vm.confirmSplit();
    await nextTick();
    await nextTick();
    expect(store.roomsOfFloor(fid).length).toBe(countBefore + 1);
    expect(store.roomsOfFloor(fid).find((r) => r.number === '401' && r.name === '拆分A')).toBeTruthy();
    expect(store.roomsOfFloor(fid).find((r) => r.number === '402' && r.name === '拆分B')).toBeTruthy();

    wrapper.unmount();
  });

  it('拆分：各间面积合计超过原房总面积时拦截，改回不超过后可拆分', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    parsed.rooms.forEach((r) => { r.selected = true; });
    const fid = store.importFloor({
      buildingName: '教学楼', floorNo: 1, fileName: 'split-area.dxf', parsed,
      coordSource: 'local', transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 },
    });
    const countBefore = store.roomsOfFloor(fid).length;

    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();
    await wrapper.findAll('button').find((b) => b.text().includes('编辑结构'))!.trigger('click');
    await nextTick();
    await wrapper.findAll('.fpv-room')[0].trigger('mousedown');
    await nextTick();
    await wrapper.findAll('button').find((b) => b.text().includes('拆分'))!.trigger('click');
    await nextTick();

    const vm = wrapper.vm as any;
    expect(vm.splitVisible).toBe(true);
    // 房号填全，避免被房号必填先拦住
    vm.splitForms[0].number = '411';
    vm.splitForms[1].number = '412';
    // 面积填成远超原房总面积 → 拦截
    vm.splitForms[0].useArea = '999999';
    vm.splitForms[1].useArea = '999999';
    vm.confirmSplit();
    await nextTick();
    expect((wrapper.vm as any).splitVisible).toBe(true);
    expect((wrapper.vm as any).splitAreaError).toContain('需等于原房');
    expect((wrapper.vm as any).splitAreaError).toContain('超出');
    expect(store.roomsOfFloor(fid).length).toBe(countBefore);

    // 改回留空（自动按原房平分，合计恰好等于总面积）→ 可成功拆分
    vm.splitForms[0].useArea = '';
    vm.splitForms[1].useArea = '';
    vm.confirmSplit();
    await nextTick();
    await nextTick();
    expect(store.roomsOfFloor(fid).length).toBe(countBefore + 1);

    wrapper.unmount();
  });

  it('拆分：各间面积合计少于原房总面积时同样拦截，补齐后可拆分', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    parsed.rooms.forEach((r) => { r.selected = true; });
    const fid = store.importFloor({
      buildingName: '教学楼', floorNo: 1, fileName: 'split-short.dxf', parsed,
      coordSource: 'local', transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 },
    });
    const countBefore = store.roomsOfFloor(fid).length;

    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();
    await wrapper.findAll('button').find((b) => b.text().includes('编辑结构'))!.trigger('click');
    await nextTick();
    await wrapper.findAll('.fpv-room')[0].trigger('mousedown');
    await nextTick();
    await wrapper.findAll('button').find((b) => b.text().includes('拆分'))!.trigger('click');
    await nextTick();

    const vm = wrapper.vm as any;
    expect(vm.splitVisible).toBe(true);
    vm.splitForms[0].number = '421';
    vm.splitForms[1].number = '422';
    // 面积填得远小于总面积 → 拦截（新规则：合计必须恰好等于总面积，不足也不行）
    vm.splitForms[0].useArea = '1';
    vm.splitForms[1].useArea = '1';
    vm.confirmSplit();
    await nextTick();
    expect((wrapper.vm as any).splitVisible).toBe(true);
    expect((wrapper.vm as any).splitAreaError).toContain('需等于原房');
    expect((wrapper.vm as any).splitAreaError).toContain('还差');
    expect(store.roomsOfFloor(fid).length).toBe(countBefore);

    // 改回留空（自动按原房平分，合计恰好等于总面积）→ 可成功拆分
    vm.splitForms[0].useArea = '';
    vm.splitForms[1].useArea = '';
    vm.confirmSplit();
    await nextTick();
    await nextTick();
    expect(store.roomsOfFloor(fid).length).toBe(countBefore + 1);

    wrapper.unmount();
  });

  it('拆分：合计相等但某间使用面积>建筑面积时拦截，改回后可拆分', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    // 原房使用=建筑=100，预填每间 use=50/build=50。改值时刻意让两类合计都仍=100，
    // 以便单独验证「每间使用≤建筑」这条校验，而不被合计校验抢先拦掉。
    parsed.rooms.forEach((r) => { r.selected = true; r.useArea = 100; r.buildArea = 100; });
    const fid = store.importFloor({
      buildingName: '教学楼', floorNo: 1, fileName: 'split-order.dxf', parsed,
      coordSource: 'local', transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 },
    });
    const countBefore = store.roomsOfFloor(fid).length;

    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();
    await wrapper.findAll('button').find((b) => b.text().includes('编辑结构'))!.trigger('click');
    await nextTick();
    await wrapper.findAll('.fpv-room')[0].trigger('mousedown');
    await nextTick();
    await wrapper.findAll('button').find((b) => b.text().includes('拆分'))!.trigger('click');
    await nextTick();

    const vm = wrapper.vm as any;
    expect(vm.splitVisible).toBe(true);
    vm.splitForms[0].number = '431';
    vm.splitForms[1].number = '432';
    // 第1间 use60/build40、第2间 use40/build60：使用合计=100、建筑合计=100 都相等，但第1间 use>build
    vm.splitForms[0].useArea = '60';
    vm.splitForms[0].buildArea = '40';
    vm.splitForms[1].useArea = '40';
    vm.splitForms[1].buildArea = '60';
    vm.confirmSplit();
    await nextTick();
    expect((wrapper.vm as any).splitVisible).toBe(true);
    expect((wrapper.vm as any).splitAreaError).toContain('大于建筑面积');
    expect(store.roomsOfFloor(fid).length).toBe(countBefore);

    // 两间都改回 use=build=50 → 合法，可成功拆分
    vm.splitForms[0].useArea = '50';
    vm.splitForms[0].buildArea = '50';
    vm.splitForms[1].useArea = '50';
    vm.splitForms[1].buildArea = '50';
    vm.confirmSplit();
    await nextTick();
    await nextTick();
    expect(store.roomsOfFloor(fid).length).toBe(countBefore + 1);

    wrapper.unmount();
  });

  it('s503: 房间号必填——清空房间号阻止保存并高亮，重新填写后可保存', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    parsed.rooms.forEach((r) => { r.selected = true; r.name = '原名称'; });
    const fid = store.importFloor({
      buildingName: '教学楼', floorNo: 1, fileName: 's503.dxf', parsed,
      coordSource: 'local',
      transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 },
    });
    const roomsBefore = store.roomsOfFloor(fid);
    const target = roomsBefore[0];

    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();
    await wrapper.findAll('.fpv-room')[0].trigger('click');
    await nextTick();
    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('编辑本房间'));
    await editBtn!.trigger('click');
    await nextTick();

    const form = wrapper.find('.fpv-pop__form--all');
    expect(form.text()).toContain('房间号');
    // 房间号栏是第一个 input stub；把它清空，并把名称改成"改名测试"以验证整次保存都被拦截
    const inputs = form.findAll('input.el-input-stub');
    const roomNoInput = inputs[0];
    const nameInput = inputs[1];
    await nameInput.setValue('改名测试');
    await roomNoInput.setValue('');
    await nextTick();

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存资料'));
    await saveBtn!.trigger('click');
    await nextTick();
    // 房间号为空 → 未退出编辑态、字段高亮、出现错误文案、store 未改变
    expect(wrapper.find('.fpv-pop__form--all').exists()).toBe(true);
    expect(wrapper.find('.fpv-edit__row--error').exists()).toBe(true);
    expect(form.text()).toContain('房间号不能为空');
    expect(store.roomsOfFloor(fid).find((r) => r.id === target.id)?.name).toBe('原名称');

    // 重新填写房间号 → 错误态消除，可正常保存（名称一并写入）
    await roomNoInput.setValue('999');
    await nextTick();
    expect(wrapper.find('.fpv-edit__row--error').exists()).toBe(false);
    await saveBtn!.trigger('click');
    await nextTick();
    await nextTick();
    const saved = store.roomsOfFloor(fid).find((r) => r.id === target.id);
    expect(saved?.name).toBe('改名测试');

    wrapper.unmount();
  });

  it('面积大小：使用面积>建筑面积阻止保存并标红，改回合法后可保存', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    parsed.rooms.forEach((r) => { r.selected = true; r.name = '原名称'; });
    const fid = store.importFloor({
      buildingName: '教学楼', floorNo: 1, fileName: 's505.dxf', parsed,
      coordSource: 'local',
      transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 },
    });
    const target = store.roomsOfFloor(fid)[0];
    const beforeUse = target.useArea;

    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();
    await wrapper.findAll('.fpv-room')[0].trigger('click');
    await nextTick();
    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('编辑本房间'));
    await editBtn!.trigger('click');
    await nextTick();

    const form = wrapper.find('.fpv-pop__form--all');
    const rowInput = (label: string) =>
      form.findAll('.fpv-edit__row').find((row) => row.find('label')?.text().includes(label))!.find('input');
    const nameInput = rowInput('名称');
    const useInput = rowInput('使用面积');
    const buildInput = rowInput('建筑面积');
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存资料'))!;

    // 使用 80 / 建筑 50 → 非法，整次保存被拦截（名称也不写入）
    await nameInput.setValue('面积非法测试');
    await useInput.setValue('80');
    await buildInput.setValue('50');
    await saveBtn.trigger('click');
    await nextTick();
    expect(wrapper.find('.fpv-pop__form--all').exists()).toBe(true); // 仍停在编辑态
    expect(form.text()).toContain('建筑面积不能小于使用面积');
    expect(wrapper.findAll('.fpv-edit__row--error').length).toBeGreaterThanOrEqual(1);
    const blocked = store.roomsOfFloor(fid).find((r) => r.id === target.id)!;
    expect(blocked.name).toBe('原名称');
    expect(blocked.useArea).toBe(beforeUse);

    // 建筑面积改成 100 → 错误态清除，可正常保存
    await buildInput.setValue('100');
    await nextTick();
    expect(form.text()).not.toContain('建筑面积不能小于使用面积');
    await saveBtn.trigger('click');
    await nextTick();
    await nextTick();
    const saved = store.roomsOfFloor(fid).find((r) => r.id === target.id)!;
    expect(saved.name).toBe('面积非法测试');
    expect(saved.useArea).toBe(80);
    expect(saved.buildArea).toBe(100);

    wrapper.unmount();
  });

  it('未分配面积：建筑>使用时详情卡显示派生行，相等/未填/建筑<使用时不显示', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    // 第一间设成 建筑50/使用45（差 5㎡）；其余保持相等，便于分别点选验证显示与隐藏
    parsed.rooms.forEach((r, i) => {
      r.selected = true;
      if (i === 0) { r.useArea = 45; r.buildArea = 50; }
      else { r.useArea = 50; r.buildArea = 50; }
    });
    const fid = store.importFloor({
      buildingName: '教学楼', floorNo: 1, fileName: 'unassigned.dxf', parsed,
      coordSource: 'local', transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 },
    });
    const rooms = store.roomsOfFloor(fid);
    const withGap = rooms[0];
    const noGap = rooms[1];

    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();
    const vm = wrapper.vm as any;

    // 让详情卡指向「有差额」的房间（selectedId 驱动 liveRoom computed），直接读信息格验证口径
    vm.selectedId = withGap.id;
    await nextTick();
    const pairsGap = (vm.roomInfoPairs as { label: string; value: string; wide?: boolean }[]);
    const row = pairsGap.find((p) => p.label.includes('未分配面积'));
    expect(row).toBeTruthy();
    expect(row!.value).toBe('5.00 ㎡');
    expect(row!.wide).toBe(true);
    expect(findCell(wrapper, '未分配面积（建筑−使用）')).toBe('5.00 ㎡');

    // 无差额房间 → 不显示该行
    vm.selectedId = noGap.id;
    await nextTick();
    const pairsNoGap = (vm.roomInfoPairs as { label: string; value: string }[]);
    expect(pairsNoGap.some((p) => p.label.includes('未分配面积'))).toBe(false);

    wrapper.unmount();
  });

  it('多选后再次纯点击某间→只取消该间；拖动已选房间→不取消；点空白→清空全部', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    parsed.rooms.forEach((r) => { r.selected = true; });
    store.importFloor({
      buildingName: '教学楼', floorNo: 1, fileName: 'sel.dxf', parsed,
      coordSource: 'local', transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 },
    });

    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();
    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('编辑结构'));
    await editBtn!.trigger('click');
    await nextTick();
    const vm = wrapper.vm as any;
    const rooms = wrapper.findAll('.fpv-room');
    expect(rooms.length).toBeGreaterThanOrEqual(2);

    // 多选前两间（编辑态选中走 mousedown，确保语义累积）
    await rooms[0].trigger('mousedown');
    await rooms[1].trigger('mousedown');
    await nextTick();
    const sel = vm.selectedIds as string[];
    expect(sel.length).toBe(2);
    const second = sel[1]!;

    // ① 再次纯点击第一间（未拖动）→ 只取消它，第二间仍选中
    await rooms[0].trigger('mousedown');
    (vm as any).dragMoved = false;
    window.dispatchEvent(new MouseEvent('mouseup'));
    await nextTick();
    expect(vm.selectedIds).toEqual([second]);

    // ② 拖动已选中的第二间（dragMoved=true）→ 保持选中不取消
    await rooms[1].trigger('mousedown');
    (vm as any).dragMoved = true;
    window.dispatchEvent(new MouseEvent('mouseup'));
    await nextTick();
    expect(vm.selectedIds).toContain(second);

    // ③ 点画布空白（未拖动）→ 清空全部选中
    await wrapper.find('.fpv-stage').trigger('mousedown');
    (vm as any).dragMoved = false;
    window.dispatchEvent(new MouseEvent('mouseup'));
    await nextTick();
    expect(vm.selectedIds.length).toBe(0);

    wrapper.unmount();
  });
});

/** 从弹窗信息格里取出指定 label 的值文本 */
function findCell(wrapper: VueWrapper<any>, label: string): string {
  const cells = wrapper.findAll('.fpv-pop__cell');
  for (const c of cells) {
    const span = c.find('span');
    if (span.exists() && span.text().trim() === label) return c.find('b').text();
  }
  return '';
}

