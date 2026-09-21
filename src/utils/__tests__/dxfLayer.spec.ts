import { describe, expect, it } from 'vitest';
import { parseDxfToResult, resolveLayerRole } from '../dxfParser';
import { SAMPLE_DXF_4LAYER, SAMPLE_DXF, SAMPLE_DXF_ROOM_FIELDS } from '../../mock/sampleDxf';

describe('dxfParser 4 图层结构', () => {
  const r = parseDxfToResult(SAMPLE_DXF_4LAYER, '教学楼', 1);

  it('resolveLayerRole 归一层角色', () => {
    expect(resolveLayerRole('楼层外轮廓线')).toBe('floorOutline');
    expect(resolveLayerRole('内部结构外墙线')).toBe('outerWall');
    expect(resolveLayerRole('内部结构内墙线')).toBe('innerWall');
    expect(resolveLayerRole('柱子及窗户线')).toBe('columnWindow');
    expect(resolveLayerRole('自定义图层')).toBe('other');
    // 模糊匹配（英文 / 含空格）
    expect(resolveLayerRole('Floor Outline')).toBe('floorOutline');
  });

  it('识别楼层外轮廓线作为指纹唯一来源', () => {
    expect(r.floorOutline).not.toBeNull();
    expect(r.floorOutline!.layer).toBe('楼层外轮廓线');
    // 12000 x 9000 = 1.08e8 mm²
    expect(r.floorOutline!.area).toBeCloseTo(1.08e8, -2);
  });

  it('房间来自内墙线层（2 间，含文字标签）', () => {
    expect(r.rooms.length).toBe(2);
    const codes = r.rooms.map((x) => x.code).sort();
    expect(codes).toEqual(['101', '102']);
  });

  it('分离柱与窗（柱子及窗户线 → 柱；窗层 → 窗）', () => {
    expect(r.columns.length).toBe(1);
    expect(r.windows.length).toBe(1);
  });

  it('外墙线单独归类（不参与指纹）', () => {
    expect(r.outerWalls.length).toBe(1);
  });

  it('层角色映射覆盖 4+1 个图层', () => {
    expect(r.layerRoles['楼层外轮廓线']).toBe('floorOutline');
    expect(r.layerRoles['内部结构外墙线']).toBe('outerWall');
    expect(r.layerRoles['内部结构内墙线']).toBe('innerWall');
    expect(r.layerRoles['柱子及窗户线']).toBe('columnWindow');
    expect(r.layerRoles['窗']).toBe('columnWindow');
  });

  it('坐标来源 local / 单位 mm（毫米图纸按局部坐标处理）', () => {
    expect(r.coordSource).toBe('local');
    expect(r.unit).toBe('mm');
  });

  it('未含楼层外轮廓线时给出兼容告警', () => {
    const r2 = parseDxfToResult(SAMPLE_DXF, '图书馆', 1);
    // 单图层（"0"）无楼层外轮廓线 → floorOutline 为 null，并提示告警
    expect(r2.floorOutline).toBeNull();
    expect(r2.warnings.some((w) => w.code === 'NO_FLOOR_OUTLINE')).toBe(true);
  });

  it('房间 6 字段（MTEXT 多行 \\P 拆分）解析为 code/number/name/dept/useArea/buildArea', () => {
    const r3 = parseDxfToResult(SAMPLE_DXF_ROOM_FIELDS, '教学楼', 1);
    expect(r3.rooms.length).toBe(1);
    const room = r3.rooms[0];
    expect(room.code).toBe('A101');
    expect(room.number).toBe('101');
    expect(room.name).toBe('教室');
    expect(room.dept).toBe('教务部');
    expect(room.useArea).toBeCloseTo(45.2);
    expect(room.buildArea).toBeCloseTo(50.0);
    expect(room.inspectStatus).toBe('normal');
  });
});
