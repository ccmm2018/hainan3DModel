/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

// Vite 环境变量类型
interface ImportMetaEnv {
  readonly VITE_AMAP_KEY: string;
  readonly VITE_AMAP_SECURITY_CODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// 高德地图安全密钥全局配置（必须在 JS API 脚本加载前设置）
interface Window {
  _AMapSecurityConfig?: {
    securityJsCode?: string;
    serviceHost?: string;
  };
  AMap?: any;
}

// 高德地图 GLCustomLayer 相机参数
interface AMapCameraParams {
  near: number;
  far: number;
  fov: number;
  up: [number, number, number];
  lookAt: [number, number, number];
  position: [number, number, number];
}

// 高德地图自定义坐标系
interface AMapCustomCoords {
  setCenter(center: [number, number]): void;
  getCenter(): [number, number];
  getCameraParams(): AMapCameraParams;
  lngLatToCoord(lnglat: [number, number]): [number, number];
  lngLatsToCoords(lnglats: Array<[number, number]>): Array<[number, number]>;
}
