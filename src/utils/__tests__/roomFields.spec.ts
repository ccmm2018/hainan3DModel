import { describe, expect, it } from 'vitest';
import { isRoomFieldComplete } from '../roomFields';
import type { ParsedRoom } from '../../types/cad';

function makeRoom(partial: Partial<ParsedRoom>): ParsedRoom {
  return {
    id: 'r1',
    buildingName: 'b',
    floorNo: 1,
    code: '',
    number: '',
    name: '',
    dept: '',
    usePurpose: '',
    useArea: 0,
    buildArea: 0,
    polygon: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
    centroid: [0.5, 0.5],
    area: 1,
    inspectStatus: 'normal',
    useStatus: '',
    selected: true,
    layers: [],
    unmatchedTexts: [],
    ...partial,
  };
}

describe('isRoomFieldComplete', () => {
  it('编码与名称均非空 → 完整', () => {
    expect(isRoomFieldComplete(makeRoom({ code: '101', name: '办公室' }))).toBe(true);
  });
  it('名称为空 → 待补填', () => {
    expect(isRoomFieldComplete(makeRoom({ code: '101', name: '' }))).toBe(false);
  });
  it('编码为空 → 待补填', () => {
    expect(isRoomFieldComplete(makeRoom({ code: '', name: '办公室' }))).toBe(false);
  });
  it('仅空白字符 → 待补填', () => {
    expect(isRoomFieldComplete(makeRoom({ code: '   ', name: '办公室' }))).toBe(false);
  });
  it('部门/面积缺失不影响完整性判定', () => {
    expect(isRoomFieldComplete(makeRoom({ code: '101', name: '办公室', dept: '', useArea: 0, buildArea: 0 }))).toBe(true);
  });
});
