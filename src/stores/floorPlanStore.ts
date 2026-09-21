/**
 * 楼层平面图数据仓库（Pinia）。
 *
 * 以 buildingName#floor 为唯一键存储每栋楼每层的 FloorPlan。
 * 仅新增 Floor / Room 数据，不创建 Building；外键统一为 buildingName。
 */

import { defineStore } from 'pinia';
import type { DxfParseResult, FloorPlan } from '../floorplan/types';
import { parseDxfToRooms } from '../floorplan/dxfParser';

function keyOf(buildingName: string, floor: number): string {
  return `${buildingName}#${floor}`;
}

interface FloorPlanState {
  /** buildingName#floor → FloorPlan */
  plans: Record<string, FloorPlan>;
}

export const useFloorPlanStore = defineStore('floorPlan', {
  state: (): FloorPlanState => ({
    plans: {},
  }),

  getters: {
    /** 返回某栋楼已导入的所有楼层（升序） */
    floorsOf(state) {
      return (buildingName: string): number[] => {
        const floors: number[] = [];
        for (const plan of Object.values(state.plans)) {
          if (plan.buildingName === buildingName) floors.push(plan.floor);
        }
        return [...new Set(floors)].sort((a, b) => a - b);
      };
    },

    /** 该楼是否存在任一楼层平面图 */
    hasPlans(state) {
      return (buildingName: string): boolean =>
        Object.values(state.plans).some((p) => p.buildingName === buildingName);
    },

    /** 取指定楼层平面图 */
    getPlan(state) {
      return (buildingName: string, floor: number): FloorPlan | undefined =>
        state.plans[keyOf(buildingName, floor)];
    },
  },

  actions: {
    /** 解析 DXF 文件并存入 store，返回生成的 FloorPlan */
    async importDxf(file: File, buildingName: string, floor: number): Promise<FloorPlan> {
      const text = await file.text();
      const result: DxfParseResult = parseDxfToRooms(text, buildingName, floor);
      const plan: FloorPlan = {
        id: keyOf(buildingName, floor),
        buildingName,
        floor,
        source: 'dxf',
        rooms: result.rooms,
        bounds: result.bounds,
        fileName: file.name,
        importedAt: Date.now(),
      };
      this.plans[plan.id] = plan;
      return plan;
    },

    /** 删除某楼层平面图 */
    removePlan(buildingName: string, floor: number): void {
      delete this.plans[keyOf(buildingName, floor)];
    },
  },
});
