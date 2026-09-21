/**
 * DXF 解析 Web Worker：在后台线程解析 DXF，避免阻塞主线程 UI。
 * 接收原始 ArrayBuffer + 编码，先按编码解码为文本，再调用解析器。
 * 通过 new Worker(new URL('./dxf.worker.ts', import.meta.url), { type: 'module' }) 使用。
 */

import { parseDxfToResult } from '../utils/dxfParser';
import { decodeDxf } from '../utils/coordinate';
import type { DxfParseResult } from '../types/cad';

interface RequestMsg {
  id: number;
  buffer: ArrayBuffer;
  encoding?: string;
  buildingName: string;
  floorNo: number;
  expandBlocks?: boolean;
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
  try {
    const text = await decodeBuffer(buffer, encoding);
    const result = parseDxfToResult(text, buildingName, floorNo, { expandBlocks });
    ctx.postMessage({ id, result });
  } catch (err) {
    ctx.postMessage({
      id,
      error: err instanceof Error ? err.message : '解析失败',
    });
  }
};
