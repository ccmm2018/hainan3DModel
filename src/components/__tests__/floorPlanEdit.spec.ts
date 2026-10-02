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

    // 打开“修改信息”
    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('修改信息'));
    expect(editBtn).toBeTruthy();
    await editBtn!.trigger('click');
    await nextTick();

    // 新 UX：就地编辑，不应再出现独立的「修改信息」表单块（避免与上方信息重复）
    expect(wrapper.find('.fpv-pop__form').exists()).toBe(false);
    expect(wrapper.find('.fpv-pop__info--edit').exists()).toBe(true);
    // 就地编辑区应直接包含 名称 输入框（绑定 editRoom.name）
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

    // 断言：弹窗标题应包含新名称
    const title = wrapper.find('.fpv-pop__title').text();
    console.log('TITLE_AFTER_SAVE=', title);
    expect(title).toContain('测试会议室A');

    // 断言：store 里【被点击那间】房间名称已更新（真实模式写入 store）
    const updated = store.roomsOfFloor(fid).find((r) => r.name === '测试会议室A');
    console.log('STORE_MATCHED=', !!updated, 'storeNames=', store.roomsOfFloor(fid).map((r) => r.name));
    expect(updated).toBeTruthy();

    // ---- 隐藏 + 恢复 链路 ----
    const beforeHide = wrapper.findAll('.fpv-room').length;
    const hideBtn = wrapper.findAll('button').find((b) => b.text().includes('隐藏此房间'));
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

    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('修改信息'));
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

    const titleAfter = wrapper.find('.fpv-pop__title').text();
    console.log('DEMO TITLE_AFTER=', titleAfter);
    expect(titleAfter).toContain('测试会议室B');

    // 隐藏该房间
    const hideBtn = wrapper.findAll('button').find((b) => b.text().includes('隐藏此房间'));
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

    // 默认：标题应显示 code“面试”，名称格应显示“（未命名）”
    const title0 = wrapper.find('.fpv-pop__title').text();
    const nameCell0 = findCell(wrapper, '名称');
    console.log('USER title0=', title0, 'nameCell0=', nameCell0);
    expect(title0).toContain('面试');
    expect(nameCell0).toContain('未命名');

    // 打开修改信息 → 在“名称”输入框写新名称 → 保存
    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('修改信息'));
    await editBtn!.trigger('click');
    await nextTick();
    const nameInput = wrapper.findAll('input.el-input-stub')[1];
    await nameInput.setValue('面试会议室');
    await nextTick();
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存'));
    await saveBtn!.trigger('click');
    await nextTick();
    await nextTick();

    // 保存后：先收起编辑态，只读信息格才会渲染
    const editBtn2 = wrapper.findAll('button').find((b) => b.text().includes('修改信息'));
    await editBtn2!.trigger('click');
    await nextTick();
    await nextTick();
    const title1 = wrapper.find('.fpv-pop__title').text();
    const nameCell1 = findCell(wrapper, '名称');
    console.log('USER title1=', title1, 'nameCell1=', nameCell1);
    expect(title1).toContain('面试会议室');
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
    // 应回退显示房间号
    expect(title).toContain('A101');

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

    // 编辑前：名称是面积文本、code 为空 → 标题应为「未命名」（验证初始态与用户描述一致）
    const title0 = wrapper.find('.fpv-pop__title').text();
    console.log('ISSUE2 title0=', title0);
    expect(title0).toContain('未命名');

    // 打开修改信息 → 名称输入框写入纯数字「101」→ 保存
    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('修改信息'));
    await editBtn!.trigger('click');
    await nextTick();
    const nameInput = wrapper.findAll('input.el-input-stub')[1];
    await nameInput.setValue('101');
    await nextTick();
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存'));
    await saveBtn!.trigger('click');
    await nextTick();
    await nextTick();

    // 保存后：先收起编辑态，只读信息格才会渲染
    const editBtn2 = wrapper.findAll('button').find((b) => b.text().includes('修改信息'));
    await editBtn2!.trigger('click');
    await nextTick();
    await nextTick();
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

