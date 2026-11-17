// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import CampusStatsDialog from '../CampusStatsDialog.vue';
import { SAMPLE_BUILDING_DATA, BUILDING_CATEGORIES, resolveBizCategory, buildModelBuildingStats } from '../../data/buildingData';
import type { ModelBuildingStat } from '../../data/buildingData';
import { SAMPLE_ROOM_DATA } from '../../data/roomData';
import { DEFAULT_SCENE_CONFIG } from '../../config/mapConfig';

// s489：统计主体 = 模型全部 36 栋可点击楼，全部归主校区
const MODEL_STATS: ModelBuildingStat[] = buildModelBuildingStats(
  DEFAULT_SCENE_CONFIG.buildingNodeNames,
  DEFAULT_SCENE_CONFIG.buildingNameAliases,
);

describe('CampusStatsDialog：36栋模型楼为主体 + 统一校区 + 箭头下钻', () => {
  function mountDialog() {
    return mount(CampusStatsDialog, {
      props: {
        buildings: SAMPLE_BUILDING_DATA,
        rooms: SAMPLE_ROOM_DATA,
        modelBuildings: MODEL_STATS.length,
        modelBuildingList: MODEL_STATS,
        businessReady: true,
      },
    });
  }

  it('统计主体 = 模型全部可点击楼栋（36栋），全部归主校区', () => {
    expect(MODEL_STATS.length).toBe(DEFAULT_SCENE_CONFIG.buildingNodeNames.length);
    expect(MODEL_STATS.length).toBe(36);
    // 全部主校区——不按业务档案的 campus 字段拆分
    expect(MODEL_STATS.every((m) => m.campus === '主校区')).toBe(true);
  });

  it('类别分布按栋数统计：教学科研9/实验实训1/图书文化1/体育训练16/生活服务9', () => {
    const byCat: Record<string, number> = {};
    for (const m of MODEL_STATS) byCat[m.category] = (byCat[m.category] ?? 0) + 1;
    expect(byCat['教学科研类']).toBe(9);
    expect(byCat['实验实训类']).toBe(1);
    expect(byCat['图书文化类']).toBe(1);
    expect(byCat['体育训练类']).toBe(16);
    expect(byCat['生活服务类']).toBe(9);
    expect(Object.values(byCat).reduce((a, b) => a + b, 0)).toBe(36);
  });

  it('楼栋类别来自数据层 resolveBizCategory，与字典一致', () => {
    expect(resolveBizCategory(SAMPLE_BUILDING_DATA['教学楼']).id).toBe('teaching');
    expect(resolveBizCategory(SAMPLE_BUILDING_DATA['实验楼']).id).toBe('lab');
    expect(resolveBizCategory(SAMPLE_BUILDING_DATA['警体综合训练馆']).id).toBe('sports');
    const ids = new Set(BUILDING_CATEGORIES.map((c) => c.id));
    expect(ids.has('teaching')).toBe(true);
    expect(ids.has('life')).toBe(true);
  });

  it('校区下拉只有「主校区」一个选项（其他校区是日后额外新增，不从当前36栋拆分）', async () => {
    const w = mountDialog();
    await nextTick();
    const options = w.findAll('.csd-campus option').map((o) => o.text());
    expect(options).toEqual(['主校区']);
  });

  it('饼图中心显示36栋，图例各类栋数之和=36', async () => {
    const w = mountDialog();
    await nextTick();
    const center = w.find('.csd-pie__center-num').text().trim();
    expect(Number(center)).toBe(36);
    const legendCounts = w.findAll('.csd-legend__btn b').map((b) => Number(b.text().replace(/\D/g, '')));
    expect(legendCounts.reduce((a, b) => a + b, 0)).toBe(36);
  });

  it('校区概况显示「空置房间」且与房间状态条一致，房间不因36栋共用档案重复累加', async () => {
    const w = mountDialog();
    await nextTick();
    const text = w.text();
    expect(text).toContain('空置房间');
    expect(text).not.toContain('房间总数');
    // 空置数与状态条「空置」一致
    const kpiCards = w.findAll('.csd-kpi');
    const vacantCard = kpiCards.find((c) => c.text().includes('空置房间'));
    const statusVacant = w.findAll('.csd-status__legend span').find((s) => s.text().includes('空置'));
    expect(vacantCard).toBeDefined();
    expect(statusVacant).toBeDefined();
    expect(Number(vacantCard!.find('b').text().replace(/\D/g, '')))
      .toBe(Number(statusVacant!.text().replace(/\D/g, '')));
    // 房间状态条三类之和 = 全局房间数（示例数据 SAMPLE_ROOM_DATA 的房间总量），不随 36 栋放大
    const statusCounts = w.findAll('.csd-status__legend span').map((s) => Number(s.text().replace(/\D/g, '')));
    const totalRooms = Object.values(SAMPLE_ROOM_DATA).flat().length;
    expect(statusCounts.reduce((a, b) => a + b, 0)).toBe(totalRooms);
  });

  it('点楼栋汇总的箭头后切到「数据详情」并进入下钻（回归 bug：原来不切 Tab 像摆设）', async () => {
    const w = mountDialog();
    await nextTick();
    expect(w.find('.csd-tab.active').text()).toBe('校区总览');
    const summaryRows = w.findAll('.csd-card--table .csd-table tbody tr');
    expect(summaryRows.length).toBe(36);
    await summaryRows[0].find('.csd-td-arrow').trigger('click');
    await nextTick();
    expect(w.find('.csd-tab.active').text()).toBe('数据详情');
    const crumb = w.find('.csd-crumb').text();
    expect(crumb).toContain('校区总览');
  });

  it('口径说明给出「共36栋楼·按楼栋数量统计」，不再出现误导的「业务楼栋6栋」', async () => {
    const w = mountDialog();
    await nextTick();
    const note = w.find('.csd-scope-note');
    expect(note.exists()).toBe(true);
    const txt = note.text();
    expect(txt).toContain('36');
    expect(txt).toContain('栋楼');
    expect(txt).not.toContain('业务楼栋');
  });

  it('楼栋汇总表带「校区」「类别」列，类别文案与字典一致', async () => {
    const w = mountDialog();
    await nextTick();
    const headers = w.findAll('.csd-card--table .csd-table th').map((h) => h.text());
    expect(headers).toContain('校区');
    expect(headers).toContain('类别');
    const cat = w.find('.csd-cat').text();
    const labels = new Set([...BUILDING_CATEGORIES.map((c) => c.label), '其他']);
    expect(labels.has(cat)).toBe(true);
  });
});
