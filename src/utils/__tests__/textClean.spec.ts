import { describe, expect, it } from 'vitest';
import {
  cleanMtext,
  normalizeLabel,
  parseRoomFields,
  inferRoomPurpose,
} from '../textClean';

describe('textClean', () => {
  it('cleanMtext 去除格式控制符', () => {
    expect(cleanMtext('{\\fSimSun|b0|i0;101}')).toBe('101');
    expect(cleanMtext('机房\\P面积 30')).toBe('机房 面积 30');
  });

  it('normalizeLabel 取首行', () => {
    expect(normalizeLabel('101\n副文本')).toBe('101');
  });

  describe('parseRoomFields 6 字段解析', () => {
    it('按标签识别 6 个字段（含中英文冒号与单位）', () => {
      const lines = [
        '房间编码: A101',
        '房间号码：101',
        '房间名称 教室',
        '部门名称：教务部',
        '使用面积 45.2㎡',
        '建筑面积 50.0',
      ];
      const { fields, unmatched } = parseRoomFields(lines);
      expect(fields.code).toBe('A101');
      expect(fields.number).toBe('101');
      expect(fields.name).toBe('教室');
      expect(fields.dept).toBe('教务部');
      expect(fields.useArea).toBeCloseTo(45.2);
      expect(fields.buildArea).toBeCloseTo(50.0);
      expect(unmatched).toHaveLength(0);
    });

    it('混合：有标签字段 + 无标签行（归入 unmatched）', () => {
      const { fields, unmatched } = parseRoomFields(['房间编码: A101', '教学楼']);
      expect(fields.code).toBe('A101');
      expect(unmatched).toEqual(['教学楼']);
    });

    it('无标签时按位置兜底', () => {
      const { fields, unmatched } = parseRoomFields(['101', 'A101', '教室', '教务部', '45.2', '50']);
      expect(fields.code).toBe('101');
      expect(fields.number).toBe('A101');
      expect(fields.name).toBe('教室');
      expect(fields.dept).toBe('教务部');
      expect(fields.useArea).toBeCloseTo(45.2);
      expect(fields.buildArea).toBeCloseTo(50);
      expect(unmatched).toHaveLength(0);
    });

    it('面积字段剥离单位并转数值', () => {
      const { fields } = parseRoomFields(['使用面积 128.5 平方米', '建筑面积: 140']);
      expect(fields.useArea).toBeCloseTo(128.5);
      expect(fields.buildArea).toBeCloseTo(140);
    });

    it('未识别文字进入 unmatched（供 remark）', () => {
      const { fields, unmatched } = parseRoomFields(['房间编码: 101', '备注：玻璃幕墙']);
      expect(fields.code).toBe('101');
      expect(unmatched).toEqual(['备注：玻璃幕墙']);
    });
  });

  it('inferRoomPurpose 由名称推断用途（非 6 字段之一）', () => {
    expect(inferRoomPurpose('101 教室')).toBe('教学');
    expect(inferRoomPurpose('配电间')).toBe('设备');
    expect(inferRoomPurpose('普通房间')).toBe('');
  });
});
