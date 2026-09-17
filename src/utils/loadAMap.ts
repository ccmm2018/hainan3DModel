/**
 * 高德地图 JS API 2.0 动态加载器
 *
 * 说明：
 * - 必须在加载 script 之前设置 window._AMapSecurityConfig（安全密钥），否则无效。
 * - 采用单例 Promise，避免重复加载。
 */

let amapPromise: Promise<any> | null = null;

export interface AMapLoadOptions {
  key: string;
  securityJsCode?: string;
}

/**
 * 动态加载高德地图 JS API 2.0，返回 AMap 命名空间。
 */
export function loadAMap(options: AMapLoadOptions): Promise<any> {
  if (window.AMap) return Promise.resolve(window.AMap);
  if (amapPromise) return amapPromise;

  amapPromise = new Promise<any>((resolve, reject) => {
    const { key, securityJsCode } = options;

    // 安全密钥必须在脚本加载前设置
    if (securityJsCode) {
      window._AMapSecurityConfig = {
        ...(window._AMapSecurityConfig || {}),
        securityJsCode,
      };
    }

    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.async = true;
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
    script.onerror = () => {
      amapPromise = null;
      reject(new Error('高德地图 JS API 加载失败，请检查网络或 key 是否正确'));
    };
    script.onload = () => {
      if (window.AMap) resolve(window.AMap);
      else {
        amapPromise = null;
        reject(new Error('高德地图 JS API 加载完成但 AMap 未定义'));
      }
    };
    document.head.appendChild(script);
  });

  return amapPromise;
}
