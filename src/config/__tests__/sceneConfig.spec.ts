// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { DEFAULT_SCENE_CONFIG } from '../mapConfig';

/** s487: 后补建的 10 个独立顶层楼栋节点（GLB 里的英文节点名）。 */
const ADDED_NODES = [
  'NewBld_17_Front', 'NewBld_19_Front', 'NewBld_20_Front', 'NewBld_21_Front',
  'B_Gym_Arc_01', 'B_Gym_Arc_02', 'B_Dorm_New_01', 'B_C0_New_01',
  'NewBox_O1_SW', 'NewBld_Dorm_NBoxSW',
];

// public/data/buildings.geojson 里带业务字段的 6 栋楼名。
// （与 GeoJSON 保持一致；若将来改动 6 栋名单，此处与 GeoJSON 需同步。）
const BIZ_BUILDING_NAMES = ['教学楼', '实验楼', '图书馆', '警体综合训练馆', '学生公寓', '食堂'];

describe('s487 后补建楼栋的可点击与数据归并配置', () => {
  it('10 个节点全部进入可点击白名单 buildingNodeNames', () => {
    const set = new Set(DEFAULT_SCENE_CONFIG.buildingNodeNames);
    for (const n of ADDED_NODES) {
      expect(set.has(n), `${n} 应在 buildingNodeNames 中`).toBe(true);
    }
  });

  it('原有数字主楼 0–25 仍在白名单里（未被覆盖/丢失）', () => {
    const set = new Set(DEFAULT_SCENE_CONFIG.buildingNodeNames);
    for (let i = 0; i <= 25; i++) expect(set.has(String(i))).toBe(true);
  });

  it('别名【精确等于】6 栋业务键，保证 resolveBuildingName 命中', () => {
    const bizNames = new Set(BIZ_BUILDING_NAMES);
    const aliases = DEFAULT_SCENE_CONFIG.buildingNameAliases;
    // 除模拟法庭（不在 6 栋业务数据内，保持原名显示「—」）外，其余别名必须命中真实楼栋键。
    for (const n of ADDED_NODES) {
      if (n === 'NewBld_17_Front') continue;
      const alias = aliases[n];
      expect(alias, `${n} 必须有别名`).toBeTruthy();
      expect(bizNames.has(alias), `${n} 的别名「${alias}」必须精确存在于 6 栋业务键中`).toBe(true);
    }
  });

  it('模拟法庭不在 6 栋内，不误挂其它楼栋数据', () => {
    expect(BIZ_BUILDING_NAMES.includes(DEFAULT_SCENE_CONFIG.buildingNameAliases['NewBld_17_Front'])).toBe(false);
  });
});
