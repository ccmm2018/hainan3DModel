/**
 * 后端 CAD 解析服务（兜底用，当前为【预留接口】，尚未部署）。
 *
 * 前端 MVP 解析器（src/utils/dxfParser.ts + src/workers/dxf.worker.ts）的能力边界
 * 见 dxfParser.ts 顶部「能力边界」注释。当图纸命中以下任一情形时，不应由前端解析，
 * 而应走后端解析服务兜底：
 *   ✗ 天正未转 T3 的私有实体（ACAD_XRECORD / 自定义图元等）
 *   ✗ SPLINE / ELLIPSE 曲线房间
 *   ✗ 深层嵌套块（INSERT 嵌套 INSERT）
 *   ✗ 单文件 > 20MB
 *   ✗ 带洞多边形（柱洞 / 内凹）—— 后续版本数据结构中预留 holes 字段支持
 *
 * 预留接口：POST /api/cad/parse
 *   Request  : multipart/form-data 或 application/json
 *              { file: Blob, encoding?, buildingName?, floorNo? }
 *   Response : 与前端 DxfParseResult 对齐的 { result: DxfParseResult, engine?: string }
 *
 * 当前后端尚未部署，调用 parseCadViaBackend() 会抛出明确错误，
 * 导入向导据此提示「该图纸需后端解析，请稍后重试 / 先转 T3 / 拆分后上传」。
 */

import type { DxfParseResult } from '../types/cad';

/** 后端解析请求载荷 */
export interface CadParseRequest {
  /** DXF 文件字节（必填） */
  file: Blob;
  /** 指定编码（可选，后端自动探测） */
  encoding?: string;
  /** 批量上传时的归属楼栋（可选） */
  buildingName?: string;
  /** 批量上传时的楼层号（可选） */
  floorNo?: number;
}

/** 后端解析响应（与前端 DxfParseResult 对齐） */
export interface CadParseResponse {
  /** 解析结果，字段语义与前端 DxfParseResult 完全一致 */
  result: DxfParseResult;
  /** 后端解析引擎标识（如 'tianzheng-t3' / 'teigha' / 'odafc'），用于诊断 */
  engine?: string;
}

/** 调用选项 */
export interface CadParseApiOptions {
  /** 后端地址，默认 /api/cad/parse */
  baseUrl?: string;
  /** 请求超时（毫秒），默认 60000 */
  timeoutMs?: number;
}

/**
 * 调用后端 CAD 解析服务（兜底路径）。
 *
 * ⚠️ 预留接口：当前后端未部署，函数体直接抛出明确错误。
 * 待后端上线后，在此实现 multipart 上传 + 超时控制 + 结果映射即可，
 * 调用方（导入向导）无需改动签名。
 */
export async function parseCadViaBackend(
  _req: CadParseRequest,
  options: CadParseApiOptions = {},
): Promise<CadParseResponse> {
  const baseUrl = options.baseUrl ?? '/api/cad/parse';
  // 预留：当前后端未部署。调用将抛出明确错误，由导入向导提示用户转 T3 / 拆分 / 稍后重试。
  throw new Error(`后端 CAD 解析服务尚未部署（预留接口 ${baseUrl}）`);
}
