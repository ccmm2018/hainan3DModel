import { describe, expect, it } from 'vitest';
import { parseDxfToResult } from '../dxfParser';
import { SAMPLE_DXF } from '../../mock/mockData';

describe('dxfParser', () => {
  const result = parseDxfToResult(SAMPLE_DXF, '教学楼', 1);

  it('识别两个闭合房间', () => {
    expect(result.rooms.length).toBe(2);
  });

  it('匹配房间号文字标签', () => {
    const codes = result.rooms.map((r) => r.code).sort();
    expect(codes).toEqual(['101', '102']);
  });

  it('自动推断坐标来源与单位', () => {
    expect(result.coordSource).toBe('local');
    expect(result.unit).toBe('mm');
  });

  it('包围盒有限且有效', () => {
    expect(result.bbox.maxX).toBeGreaterThan(result.bbox.minX);
    expect(result.bbox.maxY).toBeGreaterThan(result.bbox.minY);
  });

  it('所有房间默认选中、审图状态正常', () => {
    expect(result.rooms.every((r) => r.selected)).toBe(true);
    expect(result.rooms.every((r) => r.inspectStatus === 'normal')).toBe(true);
  });

  it('读取图层与 $INSUNITS', () => {
    expect(result.layers.length).toBeGreaterThan(0);
  });
});
