/**
 * 楼层平面图 / 房间 数据结构（本功能新增，不改动 BuildingProps）。
 *
 * 外键统一使用 buildingName（= BuildingProps.name），不新建楼栋对象。
 * 房间状态复用 roomData 中的 RoomStatus（使用中 / 无权限 / 空置）。
 */

import type { RoomStatus } from '../data/roomData';

/** 二维顶点（DXF 局部坐标，单位与图纸一致） */
export interface RoomVertex {
  x: number;
  y: number;
}

/** DXF / 平面图解析出的单个房间 */
export interface ParsedRoom {
  /** 房间唯一标识 */
  id: string;
  /** 所属建筑（外键 = BuildingProps.name） */
  buildingName: string;
  /** 楼层（从 1 开始） */
  floor: number;
  /** 房间号 / 名称（来自 DXF 文本标签；缺失时自动编号） */
  label: string;
  /** 房间轮廓（DXF 原始局部坐标，逆时针/顺时针均可） */
  polygon: RoomVertex[];
  /** 轮廓质心（局部坐标，由 polygon 计算） */
  centroid: RoomVertex;
  /** 面积（DXF 原始单位平方） */
  area: number;
  /** 状态（导入时默认空置，可在查看器中调整） */
  status: RoomStatus;
  /** 是否由 DXF 文本标签匹配得到名称 */
  labelled: boolean;
}

/** 单栋楼单层平面图 */
export interface FloorPlan {
  /** 唯一键：buildingName#floor */
  id: string;
  /** 所属建筑（外键） */
  buildingName: string;
  /** 楼层 */
  floor: number;
  /** 数据来源 */
  source: 'dxf' | 'manual';
  /** 该层所有房间 */
  rooms: ParsedRoom[];
  /** 原始坐标包围盒 */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** 来源文件名 */
  fileName: string;
  /** 导入时间戳 */
  importedAt: number;
}

export interface DxfParseWarning {
  level: 'info' | 'warn';
  message: string;
}

/** DXF 解析结果 */
export interface DxfParseResult {
  rooms: ParsedRoom[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  warnings: DxfParseWarning[];
}
