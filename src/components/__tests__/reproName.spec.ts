// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import FloorPlan2D from '../FloorPlan2D.vue';
import { useBuildingStore } from '../../stores/building';
import { parseDxfToResult } from '../../utils/dxfParser';
import { SAMPLE_DXF } from '../../mock/mockData';

const ElDialog = { props: ['modelValue'], emits: ['update:modelValue'], template: `<div v-if="modelValue" class="el-dialog-stub"><slot/></div>` };
const ElButton = { props: ['type', 'plain', 'text', 'size'], emits: ['click'], template: `<button class="el-button-stub" @click="$emit('click', $event)"><slot/></button>` };
const ElInput = { props: ['modelValue', 'size', 'type', 'rows', 'placeholder'], emits: ['update:modelValue'], template: `<input class="el-input-stub" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />` };
const ElEmpty = { props: ['description'], template: `<div class="el-empty-stub"></div>` };
const passthrough = (name: string) => ({ name, props: ['modelValue', 'size', 'label', 'value'], emits: ['update:modelValue', 'change'], template: `<div class="${name}"><slot/></div>` });
const stubs = { 'el-dialog': ElDialog, 'el-button': ElButton, 'el-input': ElInput, 'el-empty': ElEmpty, 'el-radio-group': passthrough('el-radio-group'), 'el-radio-button': passthrough('el-radio-button'), 'el-checkbox': passthrough('el-checkbox'), 'el-slider': passthrough('el-slider'), 'el-button-group': passthrough('el-button-group') };

function mountPlan(buildingName: string, pinia: any): VueWrapper<any> {
  return mount(FloorPlan2D, { props: { modelValue: true, buildingName, fullscreen: true }, global: { stubs, plugins: [pinia] }, attachTo: document.body });
}

function findCell(wrapper: VueWrapper<any>, label: string): string {
  const cells = wrapper.findAll('.fpv-pop__cell');
  for (const c of cells) {
    const span = c.find('span');
    if (span.exists() && span.text().trim() === label) return c.find('b').text();
  }
  return '';
}

describe('REPRO: name literally "未命名"', () => {
  let pinia: ReturnType<typeof createPinia>;
  beforeEach(() => { pinia = createPinia(); setActivePinia(pinia); });

  it('真实楼层：name 初始为字面量"未命名"，编辑后标题与名称格应更新', async () => {
    const store = useBuildingStore();
    const parsed = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);
    parsed.rooms.forEach((r) => { r.name = '未命名'; r.code = ''; r.selected = true; });
    const fid = store.importFloor({ buildingName: '教学楼', floorNo: 1, fileName: 'a.dxf', parsed, coordSource: 'local', transform: { offset: [440000, 4100000] as [number, number], rotation: 0, scale: 0.001 } });
    const wrapper = mountPlan('教学楼', pinia);
    await nextTick();

    const roomEls = wrapper.findAll('.fpv-room');
    expect(roomEls.length).toBeGreaterThan(0);
    await roomEls[0].trigger('click');
    await nextTick();

    const title0 = wrapper.find('.fpv-pop__title').text();
    const nameCell0 = findCell(wrapper, '名称');
    console.log('REPRO title0=', title0, 'nameCell0=', nameCell0);
    expect(title0).toContain('未命名');

    const editBtn = wrapper.findAll('button').find((b) => b.text().includes('修改信息'));
    await editBtn!.trigger('click');
    await nextTick();

    const nameInput = wrapper.findAll('input.el-input-stub')[1];
    await nameInput.setValue('会议室A');
    await nextTick();

    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存'));
    await saveBtn!.trigger('click');
    await nextTick();
    await nextTick();

    const title1 = wrapper.find('.fpv-pop__title').text();
    const nameCell1 = findCell(wrapper, '名称');
    console.log('REPRO title1=', title1, 'nameCell1=', nameCell1);
    expect(title1).toContain('会议室A');
    expect(nameCell1).toContain('会议室A');
    expect(store.roomsOfFloor(fid).find((r) => r.name === '会议室A')).toBeTruthy();
    wrapper.unmount();
  });
});
