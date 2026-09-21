import { describe, it, expect } from 'vitest';
import type {
  ClosedPolyline,
  DxfParseResult,
  ParsedRoom,
  FloorPlanLayerRole,
} from '../../types/cad';
import {
  validateDxf,
  isLikelyDxfBuffer,
  REQUIRED_LAYER_ROLES,
  type CheckResult,
} from '../dxfValidate';

function poly(pts: [number, number][]): ClosedPolyline {
  return { polygon: pts, centroid: [0, 0], area: 1, layer: 'L' };
}

function room(p: Partial<ParsedRoom> & { polygon: [number, number][] }): ParsedRoom {
  return {
    id: 'r1',
    buildingName: '',
    floorNo: 1,
    code: '',
    number: '',
    name: '',
    dept: '',
    usePurpose: '',
    useArea: 0,
    buildArea: 0,
    centroid: [0, 0],
    inspectStatus: 'normal',
    useStatus: '',
    area: 0,
    selected: true,
    layers: [],
    unmatchedTexts: [],
    ...p,
  };
}

function baseResult(): DxfParseResult {
  const layerRoles: Record<string, FloorPlanLayerRole> = {
    楼层外轮廓线: 'floorOutline',
    内部结构外墙线: 'outerWall',
    内部结构内墙线: 'innerWall',
    柱子及窗户线: 'columnWindow',
  };
  return {
    layers: [],
    rooms: [],
    warnings: [],
    coordSource: 'utm',
    unit: 'm',
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    floorOutline: poly([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]),
    outerWalls: [],
    columns: [],
    windows: [],
    layerRoles,
  };
}

function findCode(checks: CheckResult[], code: CheckResult['code']): CheckResult {
  const c = checks.find((x) => x.code === code);
  if (!c) throw new Error(`check ${code} not found`);
  return c;
}

const dxfBytes = new TextEncoder().encode('0\nSECTION\n2\nENTITIES\n0\nEOF\n').buffer;
const notDxfBytes = new TextEncoder().encode('这是一份普通中文文本，并非 DXF 图纸文件').buffer;
// UTF-16LE（带 BOM）+ 宽字符 "SECTION"
const utf16LeBytes = new Uint8Array([
  0xff, 0xfe, 0x53, 0x00, 0x45, 0x00, 0x43, 0x00, 0x54, 0x00, 0x49, 0x00, 0x4f, 0x00, 0x4e, 0x00,
]).buffer;

describe('isLikelyDxfBuffer', () => {
  it('UTF-8 DXF 文本识别为 DXF', () => {
    expect(isLikelyDxfBuffer(dxfBytes)).toBe(true);
  });
  it('UTF-16LE（BOM）DXF 识别为 DXF', () => {
    expect(isLikelyDxfBuffer(utf16LeBytes)).toBe(true);
  });
  it('非 DXF 文本识别为非 DXF', () => {
    expect(isLikelyDxfBuffer(notDxfBytes)).toBe(false);
  });
});

describe('validateDxf C1 编码', () => {
  it('合法 DXF 字节 → ok', () => {
    const v = validateDxf(baseResult(), { buffer: dxfBytes });
    expect(findCode(v.checks, 'C1').level).toBe('ok');
    expect(v.hasError).toBe(false);
  });
  it('非 DXF 字节 → error 且阻断', () => {
    const v = validateDxf(baseResult(), { buffer: notDxfBytes });
    expect(findCode(v.checks, 'C1').level).toBe('error');
    expect(v.hasError).toBe(true);
  });
  it('缺失 buffer → 跳过 C1（ok）', () => {
    const v = validateDxf(baseResult());
    expect(findCode(v.checks, 'C1').level).toBe('ok');
    expect(v.hasError).toBe(false);
  });
});

describe('validateDxf C2 图层', () => {
  it('4 个规定图层齐全 → ok', () => {
    const v = validateDxf(baseResult());
    expect(findCode(v.checks, 'C2').level).toBe('ok');
    expect(v.missingLayers).toHaveLength(0);
  });
  it('缺图层 → warn 并列出缺失', () => {
    const r = baseResult();
    r.layerRoles = { 内部结构内墙线: 'innerWall' };
    const v = validateDxf(r);
    const c2 = findCode(v.checks, 'C2');
    expect(c2.level).toBe('warn');
    expect(v.missingLayers).toEqual(
      expect.arrayContaining(['floorOutline', 'outerWall', 'columnWindow']),
    );
    expect(c2.message).toContain('楼层外轮廓线');
  });
});

describe('validateDxf C3 单位', () => {
  it('单位已知（米）→ ok', () => {
    const v = validateDxf(baseResult());
    expect(findCode(v.checks, 'C3').level).toBe('ok');
  });
  it('单位 unknown → warn', () => {
    const r = baseResult();
    r.unit = 'unknown';
    const v = validateDxf(r);
    expect(findCode(v.checks, 'C3').level).toBe('warn');
  });
});

describe('validateDxf C4 闭合', () => {
  it('干净闭合轮廓 → ok', () => {
    const v = validateDxf(baseResult());
    expect(findCode(v.checks, 'C4').level).toBe('ok');
    expect(v.closureProblemCount).toBe(0);
  });
  it('自交轮廓 → warn 并计数', () => {
    const r = baseResult();
    // 自交「蝴蝶结」：两条对角线交叉
    r.floorOutline = poly([
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 10],
    ]);
    r.rooms = [];
    const v = validateDxf(r);
    expect(findCode(v.checks, 'C4').level).toBe('warn');
    expect(v.closureProblemCount).toBeGreaterThan(0);
  });
  it('正常闭合环（首末点不等）不误报', () => {
    const r = baseResult();
    r.floorOutline = poly([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
    const v = validateDxf(r);
    expect(v.closureProblemCount).toBe(0);
  });
});

describe('validateDxf C5 文本', () => {
  it('房间有字段 → ok', () => {
    const r = baseResult();
    r.rooms = [room({ polygon: [[0, 0], [1, 0], [1, 1], [0, 1]], name: '会议室' })];
    const v = validateDxf(r);
    expect(findCode(v.checks, 'C5').level).toBe('ok');
  });
  it('存在无任何字段的房间 → warn 并计数', () => {
    const r = baseResult();
    r.rooms = [room({ polygon: [[0, 0], [1, 0], [1, 1], [0, 1]] })];
    const v = validateDxf(r);
    expect(findCode(v.checks, 'C5').level).toBe('warn');
    expect(v.emptyRoomCount).toBe(1);
  });
});

describe('validateDxf C6 坐标', () => {
  it('UTM 量级 → info（utm）', () => {
    const v = validateDxf(baseResult());
    const c6 = findCode(v.checks, 'C6');
    expect(c6.level).toBe('info');
    expect(c6.message).toContain('UTM');
  });
  it('局部坐标 → info（local），非错误', () => {
    const r = baseResult();
    r.coordSource = 'local';
    const v = validateDxf(r);
    const c6 = findCode(v.checks, 'C6');
    expect(c6.level).toBe('info');
    expect(c6.message).toContain('局部坐标');
    expect(v.hasError).toBe(false);
  });
  it('coordSourceOverride 生效', () => {
    const r = baseResult(); // parsed 为 utm
    const v = validateDxf(r, { coordSourceOverride: 'local' });
    expect(v.coordSource).toBe('local');
  });
});

describe('validateDxf 仅 error 阻断', () => {
  it('仅有 warn/info，无 C1 error → hasError=false', () => {
    const r = baseResult();
    r.unit = 'unknown';
    r.layerRoles = { 内部结构内墙线: 'innerWall' };
    r.rooms = [room({ polygon: [[0, 0], [1, 0], [1, 1], [0, 1]] })];
    const v = validateDxf(r, { buffer: dxfBytes });
    expect(v.hasError).toBe(false);
    expect(v.hasWarn).toBe(true);
    expect(REQUIRED_LAYER_ROLES).toHaveLength(4);
  });
});
