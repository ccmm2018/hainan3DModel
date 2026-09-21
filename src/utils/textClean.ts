/**
 * DXF 文本清洗与房间字段解析。
 *
 * 房间字段（6 个，每个单行文本）：
 *   房间编码 / 房间号码 / 房间名称 / 部门名称 / 使用面积 / 建筑面积
 * TEXT 与 MTEXT 均接受；MTEXT 按 \P（或 \n）拆成多行，每行视为一个候选字段。
 * 不使用 any。
 */

/** 去除 MTEXT 常见格式控制符（字体/字高/字宽/颜色控制串、段落、花括号等） */
export function cleanMtext(raw: string): string {
  return raw
    .replace(/\\[fFHWC][^;\\]*;/g, '') // \f 字体 / \H 字高 / \W 字宽 / \C 颜色 控制串
    .replace(/\\P/gi, ' ') // 段落
    .replace(/[{}]/g, '') // 花括号
    .replace(/\\[A-Za-z]/g, '') // 其余单字母控制符
    .replace(/\s+/g, ' ')
    .trim();
}

/** 归一化为单行可读标签（先取首行，再清洗，避免空白折叠吞掉换行） */
export function normalizeLabel(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0] ?? '';
  return cleanMtext(firstLine);
}

/** 房间 6 字段（来自 DXF 房间文本） */
export interface RoomFields {
  /** 房间编码 */
  code: string;
  /** 房间号码 */
  number: string;
  /** 房间名称 */
  name: string;
  /** 部门名称 */
  dept: string;
  /** 使用面积 ㎡ */
  useArea: number;
  /** 建筑面积 ㎡ */
  buildArea: number;
}

/** 6 字段的规范顺序（用于无标签时的按位兜底） */
export const ROOM_FIELD_ORDER: ReadonlyArray<keyof RoomFields> = [
  'code',
  'number',
  'name',
  'dept',
  'useArea',
  'buildArea',
];

/** 房间用途关键词表（中文），用于从房间名称推断 usePurpose（用于分色，非 6 字段之一） */
const PURPOSE_KEYWORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/教室|教学|智慧教室|多媒体/, '教学'],
  [/实验|实训/, '实验'],
  [/办公|办公室|教研室|行政/, '办公'],
  [/宿舍|寝室|公寓/, '住宿'],
  [/卫生间|厕所|盥洗|淋浴|更衣/, '辅助'],
  [/楼梯|电梯|前室|走道|走廊|门厅|大厅|候梯/, '交通'],
  [/会议|报告厅|研讨/, '会议'],
  [/档案|资料/, '档案'],
  [/配电|电井|弱电|机房|设备|水泵|空调|换热/, '设备'],
  [/库房|仓库|储藏/, '仓储'],
  [/消防|监控|安防/, '设备'],
  [/值班|宿管|安保/, '值班'],
  [/阅览|书库|图书/, '图书'],
  [/餐厅|食堂|厨房|操作间/, '餐饮'],
  [/医务|保健|心理/, '医疗'],
];

/** 从文本中提取首个浮点数（剥离 ㎡/m²/m2/平方米 等单位后缀） */
function parseArea(raw: string): number {
  const m = raw.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

/** 字段标签 → 正则（捕获标签后的取值部分） */
const FIELD_PATTERNS: ReadonlyArray<readonly [keyof RoomFields, RegExp]> = [
  [
    'code',
    /^(?:房间编码|编码|房号编码|room[-\s_]?code|code)\s*[:：]?\s*(.*)$/i,
  ],
  [
    'number',
    /^(?:房间号码|房间号|房号|门牌|编号|room[-\s_]?no|number|no)\s*[:：]?\s*(.*)$/i,
  ],
  ['name', /^(?:房间名称|房名|名称|房间|room[-\s_]?name|name)\s*[:：]?\s*(.*)$/i],
  [
    'dept',
    /^(?:部门名称|使用部门|部门|使用单位|院系|单位|dept|department)\s*[:：]?\s*(.*)$/i,
  ],
  ['useArea', /^(?:使用面积|使用|usable[-\s_]?area|usable)\s*[:：]?\s*(.*)$/i],
  [
    'buildArea',
    /^(?:建筑面积|建面|建筑面|建筑|built[-\s_]?area|gross[-\s_]?area|built|gross)\s*[:：]?\s*(.*)$/i,
  ],
];

export interface ParsedRoomFields {
  fields: RoomFields;
  /** 未能识别为任一 6 字段标签的剩余文本（材质 / 注释等），供 remark 参考 */
  unmatched: string[];
}

/**
 * 把一段房间的候选字段行（每个单行文本）解析成 6 字段。
 *
 * 解析策略：
 *  - 优先按「标签 + 取值」识别每一行（如 "房间编码：101"、"使用面积 45.2㎡"）；
 *  - 完全无标签命中时，按 ROOM_FIELD_ORDER 顺序把裸行兜底映射到 字段
 *    （现实兼容：图纸未写字段名、纯靠位置排列的场景）；
 *  - 既非标签、又未被兜底消费的行，归入 unmatched（用于 remark）。
 */
export function parseRoomFields(lines: ReadonlyArray<string>): ParsedRoomFields {
  const fields: RoomFields = {
    code: '',
    number: '',
    name: '',
    dept: '',
    useArea: 0,
    buildArea: 0,
  };
  const unmatched: string[] = [];
  const bareLines: string[] = [];
  let labeled = false;

  for (const rawLine of lines) {
    const line = cleanMtext(rawLine);
    if (!line) continue;
    let hit: keyof RoomFields | null = null;
    let value = line;
    for (const [field, re] of FIELD_PATTERNS) {
      const m = line.match(re);
      if (m) {
        hit = field;
        value = (m[1] ?? '').trim();
        break;
      }
    }
    if (hit) {
      labeled = true;
      if (hit === 'useArea' || hit === 'buildArea') {
        fields[hit] = parseArea(value);
      } else {
        fields[hit] = value;
      }
    } else {
      bareLines.push(line);
    }
  }

  if (!labeled) {
    // 无标签：按位置兜底，面积字段做数值解析
    bareLines.forEach((line, i) => {
      if (i >= ROOM_FIELD_ORDER.length) {
        unmatched.push(line);
        return;
      }
      const f = ROOM_FIELD_ORDER[i];
      if (f === 'useArea' || f === 'buildArea') fields[f] = parseArea(line);
      else fields[f] = line;
    });
  } else {
    unmatched.push(...bareLines);
  }

  return { fields, unmatched };
}

/** 由房间名称推断用途（用于分色，非 6 字段之一） */
export function inferRoomPurpose(name: string): string {
  const cleaned = cleanMtext(name).replace(/\s+/g, ' ').trim();
  for (const [re, label] of PURPOSE_KEYWORDS) {
    if (re.test(cleaned)) return label;
  }
  return '';
}
