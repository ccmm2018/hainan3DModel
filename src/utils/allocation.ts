/**
 * 房屋分配工具：面积计算（Turf.js）与分配提交（后端 API）
 */

import area from '@turf/area';
import type { Room } from '../data/roomData';

/** 计算单个房间的实际面积（㎡）。优先用 Turf.js 根据 GeoJSON geometry 计算，无几何则回退到 area 字段 */
export function computeRoomArea(room: Room): number {
  if (room.geometry) {
    try {
      const m2 = area(room.geometry);
      if (typeof m2 === 'number' && m2 > 0) return m2;
    } catch {
      /* 回退到 area 字段 */
    }
  }
  return Number(room.area ?? 0);
}

/** 计算已选房间的总实际面积（㎡） */
export function computeTotalArea(rooms: Room[]): number {
  return rooms.reduce((sum, room) => sum + computeRoomArea(room), 0);
}

export interface AllocationPayload {
  roomIds: string[];
  roomNos: string[];
  totalArea: number;
  requestedArea: number;
  applicant?: string;
}

export interface AllocationResult {
  success: boolean;
  message: string;
}

/**
 * 提交分配结果到后端 API。
 * 未配置 apiUrl 时返回模拟成功（便于本地联调）。
 */
export async function submitAllocation(
  payload: AllocationPayload,
  apiUrl?: string,
): Promise<AllocationResult> {
  if (!apiUrl) {
    // 模拟后端：延时后返回成功
    await new Promise((r) => setTimeout(r, 500));
    return { success: true, message: '分配成功（本地模拟，未接入后端）' };
  }

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { success: true, message: '分配成功' };
  } catch (err) {
    return { success: false, message: `分配失败：${(err as Error).message}` };
  }
}
