/**
 * DXF 解析 Web Worker：在后台线程解析 DXF，避免阻塞主线程 UI。
 * 接收原始 ArrayBuffer + 编码，先按编码解码为文本，再调用解析器。
 * 通过 new Worker(new URL('./dxf.worker.ts', import.meta.url), { type: 'module' }) 使用。
 */

import { parseDxfToResult } from '../utils/dxfParser';
import { decodeDxf, type DxfEncoding } from '../utils/dxfDecode';
import type { DxfParseResult } from '../types/cad';

interface RequestMsg {
  id: number;
  buffer: ArrayBuffer;
  encoding?: DxfEncoding | string;
  buildingName: string;
  floorNo: number;
}

interface ResponseMsg {
  id: number;
  result?: DxfParseResult;
  error?: string;
}

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<RequestMsg>) => void) | null;
  postMessage: (msg: ResponseMsg) => void;
};

ctx.onmessage = (ev: MessageEvent<RequestMsg>) => {
  const { id, buffer, encoding, buildingName, floorNo } = ev.data;
  try {
    const text = decodeDxf(buffer, encoding);
    const result = parseDxfToResult(text, buildingName, floorNo);
    ctx.postMessage({ id, result });
  } catch (err) {
    ctx.postMessage({
      id,
      error: err instanceof Error ? err.message : '解析失败',
    });
  }
};
