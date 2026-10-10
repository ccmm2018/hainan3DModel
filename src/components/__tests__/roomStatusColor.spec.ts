// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import FloorPlan2D from '../FloorPlan2D.vue';
import { useBuildingStore } from '../../stores/building';
import { parseDxfToResult } from '../../utils/dxfParser';
import { SAMPLE_DXF } from '../../mock/mockData';

const ElDialog = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: `<div v-if="modelValue" class="el-dialog-stub"><slot /></div>`,
};
const ElButton = {
  props: ['type', 'plain', 'text', 'size'],
  emits: ['click'],
  template: `<button class="el-button-stub" @click="$emit('click', $event)"><slot /></button>`,
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
  template: `<div class="${name}"><slot /></div>`,
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
function mountPlan(buildingName: string): { wrapper: VueWrapper<any>; pinia: ReturnType<typeof createPinia> } {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(FloorPlan2D, {
    props: { modelValue: true, buildingName, fullscreen: true },
    global: { stubs, plugins: [pinia] },
    attachTo: document.body,
  });
  return { wrapper, pinia };
}
const VACANT = '#BBDEFB';

async function enterEditAndArm(wrapper: VueWrapper<any>, label: string): Promise<void> {
  const editBtn = wrapper.findAll('button').find((b) => (b.text() || '').includes('编辑'));
  expect(editBtn, '应存在[编辑]按钮').toBeTruthy();
  await editBtn!.trigger('click');
  await nextTick();
  const legendItems = wrapper.findAll('.fpv-legend__item');
  expect(legendItems.length, '图例项应存在').toBeGreaterThan(0);
  const target = legendItems.find((i) => (i.text() || '').includes(label));
  expect(target, `应存在图例项[${label}]`).toBeTruthy();
  await target!.trigger('click');
  await nextTick();
}

describe('房间状态标注 → 画布颜色更新', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('demo模式：编辑态 armed 空置 点房间，该房间颜色应变空置蓝', async () => {
    const { wrapper } = mountPlan('教学楼'); // 未导入DXF → demo 12宫格
    await nextTick();
    const store = useBuildingStore();
    console.log('DEMO store floorsOf=', store.floorsOf('教学楼')); // 应为空 → 确认走 demo 路径
    expect(store.floorsOf('教学楼').length).toBe(0);
    let rooms = wrapper.findAll('.fpv-room');
    expect(rooms.length).toBeGreaterThan(0);
    // demo_0 初始为「使用中」(occupied=#C8E6C9)，点击后应变为「空置」(vacant=#BBDEFB)
    const firstBefore = rooms[0].find('polygon')!.attributes('fill');
    console.log('DEMO firstBefore=', firstBefore);
    expect(firstBefore).toBe('#C8E6C9');
    const countVacant = () => wrapper.findAll('.fpv-room').filter(
      (g) => g.find('polygon')!.attributes('fill') === VACANT,
    ).length;
    const before = countVacant();
    console.log('DEMO beforeVacant=', before);

    await enterEditAndArm(wrapper, '空置');

    rooms = wrapper.findAll('.fpv-room');
    await rooms[0].trigger('mousedown', { clientX: 10, clientY: 10 });
    await nextTick();
    await nextTick();

    const after = countVacant();
    console.log('DEMO afterVacant=', after);
    // demo_0(occupied) 变为 vacant → 空置蓝房间数应 +1
    expect(after).toBe(before + 1);
    // 被点房间置顶到末尾，末尾应为空置蓝
    const all = wrapper.findAll('.fpv-room');
    expect(all[all.length - 1].find('polygon')!.attributes('fill')).toBe(VACANT);
  });

  it('真实楼层：编辑态 armed 空置 点房间，store 与画布颜色同时更新', async () => {
    const { wrapper, pinia } = mountPlan('教学楼');
    setActivePinia(pinia);
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    parsed.rooms.forEach((r) => {
      r.selected = true;
      r.useStatus = 'occupied'; // 强制非空缺，排除「本来就是空置」造成的假阳性
    });
    const fid = store.importFloor({ buildingName: '教学楼', floorNo: 1, fileName: 'a.dxf', parsed });
    // 断言：导入后首间房确为非空置
    expect(store.roomsOfFloor(fid)[0].useStatus).toBe('occupied');
    await nextTick();
    let rooms = wrapper.findAll('.fpv-room');
    expect(rooms.length).toBeGreaterThan(0);

    await enterEditAndArm(wrapper, '空置');

    rooms = wrapper.findAll('.fpv-room');
    await rooms[0].trigger('mousedown', { clientX: 10, clientY: 10 });
    await nextTick();
    await nextTick();

    // 数据层：被点房间(rooms[0])的 useStatus 应为 vacant
    const firstRoomId = store.roomsOfFloor(fid)[0].id;
    const stored = store.roomsOfFloor(fid).find((r) => r.id === firstRoomId)!;
    console.log('REAL store useStatus=', stored.useStatus);
    expect(stored.useStatus).toBe('vacant');

    // 画布层：被点房间置顶到末尾，应为空置蓝
    const all = wrapper.findAll('.fpv-room');
    const lastFill = all[all.length - 1].find('polygon')!.attributes('fill');
    console.log('REAL lastFill=', lastFill);
    expect(lastFill).toBe(VACANT);
  });
});
