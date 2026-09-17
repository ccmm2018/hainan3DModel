/**
 * 生成占位校园 GLB 模型（用于在没有真实模型时联调测试）
 *
 * 用法：node scripts/generate-placeholder-glb.mjs
 * 产物：public/models/hnjcxy.glb
 *
 * 结构：Y-up（glTF 标准），建筑为命名 Group（匹配 sample 建筑数据名），
 *      单位为米，便于测试拾取 / 楼盘表 / 室内视角等功能。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// Node 环境无 FileReader，GLTFExporter 需要，补一个 polyfill
globalThis.FileReader = class FileReader {
  result = null;
  onloadend = null;
  async readAsArrayBuffer(blob) {
    this.result = await blob.arrayBuffer();
    this.onloadend?.();
  }
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const scene = new THREE.Scene();

// 地面（浅色）
const ground = new THREE.Mesh(
  new THREE.BoxGeometry(240, 0.6, 240),
  new THREE.MeshStandardMaterial({ color: '#7d8a6f', roughness: 1 }),
);
ground.position.y = -0.3;
scene.add(ground);

// 辅助：加一栋建筑（Group 命名，内部 mesh 不命名，便于拾取到建筑组）
function addBuilding(name, x, z, w, d, h, color) {
  const group = new THREE.Group();
  group.name = name;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05 }),
  );
  body.position.y = h / 2;
  group.add(body);

  // 加一个楼顶小方块，让建筑更有辨识度
  const cap = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.4, h * 0.12, d * 0.4),
    new THREE.MeshStandardMaterial({ color: '#cfd8e3', roughness: 0.5 }),
  );
  cap.position.y = h + h * 0.06;
  group.add(cap);

  group.position.set(x, 0, z);
  scene.add(group);
  return group;
}

// 建筑（名称与 buildingData / roomData 示例保持一致）
addBuilding('教学楼', 0, 0, 62, 26, 26, '#b7c3d8');
addBuilding('实验楼', 82, 0, 46, 22, 22, '#cbb8d8');
addBuilding('图书馆', -82, 0, 36, 30, 18, '#b8d6c4');
addBuilding('学生公寓', 0, 82, 42, 16, 16, '#d8ccb4');
addBuilding('学生公寓', 46, 82, 42, 16, 16, '#d8ccb4');
addBuilding('食堂', -60, -62, 32, 22, 12, '#d8b8b6');
addBuilding('警体综合训练馆', 60, -62, 40, 28, 16, '#b8c4d8');

// 道路（扁平，命名，供「道路」类拾取测试）
const road = new THREE.Mesh(
  new THREE.BoxGeometry(10, 0.4, 230),
  new THREE.MeshStandardMaterial({ color: '#5a5f66', roughness: 1 }),
);
road.position.set(0, 0.2, 0);
road.name = '主干道';
scene.add(road);

// 水系（扁平，命名，供「水系」类拾取测试）
const water = new THREE.Mesh(
  new THREE.BoxGeometry(44, 0.3, 30),
  new THREE.MeshStandardMaterial({ color: '#4a90c4', roughness: 0.2, metalness: 0.1 }),
);
water.position.set(124, 0.15, 124);
water.name = '人工湖';
scene.add(water);

// 导出
const exporter = new GLTFExporter();
exporter.parse(
  scene,
  (result) => {
    if (!(result instanceof ArrayBuffer)) {
      console.error('GLTFExporter 未返回二进制结果');
      process.exit(1);
    }
    const outDir = path.resolve(__dirname, '../public/models');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'hnjcxy.glb');
    fs.writeFileSync(outPath, Buffer.from(result));
    console.log(`已生成占位模型：${outPath}（${Math.round(result.byteLength / 1024)} KB）`);
  },
  (err) => {
    console.error('导出失败：', err);
    process.exit(1);
  },
  { binary: true },
);
