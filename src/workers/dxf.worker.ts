/**
 * DXF 解析 Web Worker：在后台线程解析 DXF，避免阻塞主线程 UI。
 * 接收原始 ArrayBuffer + 编码，先按编码解码为文本，再调用解析器。
 * 通过 new Worker(new URL('./dxf.worker.ts', import.meta.url), { type: 'module' }) 使用。
 *
 * 进度相位：收到字节后先发 `decoding`（解码中），解码完成发 `parsing`（解析中），
 * 最终发 `result` / `error`。主线程据此驱动「已接收→解码中→解析中→完成」进度条。
 *
 * 解析契约（导入向导「步骤3 解析」）：Worker 内执行 extractRooms（经 parseDxfToResult 编排），
 * 返回完整的 DxfParseResult，其中包含：
 *   - warnings：解析告警（曲线实体 / 自交 / 未识别外轮廓 / 缺图层 / 未匹配文本 等）
 *   - bbox：原始坐标包围盒（minX/minY/maxX/maxY）
 *   - coordSource：坐标来源（utm | local，自动推断）
 *   - unit：长度单位（m | cm | mm | unknown，自动推断）
 *   - rooms：extractRooms 产出的房间候选
 * 这些字段即导入向导「解析」步骤向用户呈现的核心数据。
 *
 * 能力边界：本 Worker 仅做「MVP 纯前端解析」——标准 DXF / 直线房间（LWPOLYLINE·POLYLINE）
 * / TEXT·MTEXT / GBK·UTF-8·UTF-16 / 单文件 ≤20MB。命中不支持项（天正未转 T3 的私有实体、
 * SPLINE·ELLIPSE 曲线房间、深层嵌套块、>20MB 图纸、带洞多边形）时，前端应拒解析并改走
 * 后端兜底（预留接口 POST /api/cad/parse，客户端封装见 src/utils/cadParseApi.ts）。
 */

import { parseDxfToResult } from '../utils/dxfParser';
import { decodeDxf } from '../utils/coordinate';
import type { DxfParseResult } from '../types/cad';

interface RequestMsg {
  id: number;
  buffer: ArrayBuffer;
  encoding?: string;
  /** 批量上传时归属未定，允许为空（最终入库时按楼栋/楼层重算 ID） */
  buildingName?: string;
  floorNo?: number;
  expandBlocks?: boolean;
}

interface ResponseMsg {
  id: number;
  /** 进度相位（解码中 / 解析中），与 result/error 互斥 */
  phase?: 'decoding' | 'parsing';
  result?: DxfParseResult;
  error?: string;
}

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<RequestMsg>) => void) | null;
  postMessage: (msg: ResponseMsg) => void;
};

/** 解码 DXF 字节流：手动指定编码时优先使用，否则自动探测（见 coordinate.decodeDxf） */
async function decodeBuffer(buffer: ArrayBuffer, encoding: string | undefined): Promise<string> {
  if (encoding && encoding !== 'auto') {
    try {
      return new TextDecoder(encoding).decode(buffer);
    } catch {
      // 编码不支持，回退自动探测
    }
  }
  return decodeDxf(buffer);
}

ctx.onmessage = async (ev: MessageEvent<RequestMsg>) => {
  const { id, buffer, encoding, buildingName, floorNo, expandBlocks } = ev.data;
  // 已收到字节，进入「解码中」
  ctx.postMessage({ id, phase: 'decoding' });
  try {
    const text = await decodeBuffer(buffer, encoding);
    // 解码完成，进入「解析中」
    ctx.postMessage({ id, phase: 'parsing' });
    // 解析阶段：parseDxfToResult 内部调用 extractRooms 提取房间，
    // 返回完整 DxfParseResult（含 warnings / bbox / coordSource / unit）。
    const result = parseDxfToResult(text, buildingName ?? '', floorNo ?? 0, { expandBlocks });
    ctx.postMessage({ id, result });
  } catch (err) {
    ctx.postMessage({
      id,
      error: err instanceof Error ? err.message : '解析失败',
    });
  }
};
