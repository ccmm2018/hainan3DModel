import { describe, expect, it } from 'vitest';
import { fuzzyMatchBuilding, matchLabels } from '../matcher';
import type { Pt } from '../geometry';

describe('matcher', () => {
  it('matchLabels 命中房间内文字，远处文字返回 null', () => {
    const rooms = [
      { polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] as Pt[], centroid: [5, 5] as Pt },
      { polygon: [[100, 100], [110, 100], [110, 110], [100, 110]] as Pt[], centroid: [105, 105] as Pt },
    ];
    const texts = [
      { pos: [5, 5] as Pt, text: '101' },
      { pos: [500, 500] as Pt, text: '孤立文字' },
    ];
    const res = matchLabels(rooms, texts);
    expect(res[0]).toBe('101');
    expect(res[1]).toBeNull();
  });

  it('fuzzyMatchBuilding 支持精确 / 大小写 / 包含匹配', () => {
    const candidates = ['实验楼', '教学楼', '图书馆'];
    expect(fuzzyMatchBuilding('教学楼', candidates)).toBe('教学楼');
    expect(fuzzyMatchBuilding('教学', candidates)).toBe('教学楼');
    expect(fuzzyMatchBuilding('教', candidates)).toBe('教学楼');
    expect(fuzzyMatchBuilding('不存在', candidates)).toBeNull();
  });
});
