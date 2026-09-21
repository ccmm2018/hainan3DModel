/**
 * DXF 文本解码（编码兼容）。
 * 真实图纸编码未必是 UTF-8：AutoCAD 中文环境常导出 GBK / GB2312。
 * 默认 'auto'：先按 UTF-8（严格）解码，失败再回退 GBK，最后宽松 UTF-8。
 * 显式指定编码时直接使用，失败回退 UTF-8。
 * 不使用 any；TextDecoder 为浏览器 / Node 全局。
 */

export type DxfEncoding = 'auto' | 'utf-8' | 'gbk' | 'gb2312';

function decodeWith(enc: string, buffer: ArrayBuffer): string {
  // TextDecoder 在部分运行时（如某些测试环境）可能不支持 gbk，用 try/catch 兜底
  return new TextDecoder(enc).decode(buffer);
}

export function decodeDxf(buffer: ArrayBuffer, encoding: DxfEncoding | string | undefined): string {
  if (encoding && encoding !== 'auto') {
    try {
      return decodeWith(encoding, buffer);
    } catch {
      return decodeWith('utf-8', buffer);
    }
  }
  // auto：UTF-8 严格 → GBK 严格 → UTF-8 宽松
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return decodeWith('gbk', buffer);
    } catch {
      return decodeWith('utf-8', buffer);
    }
  }
}
