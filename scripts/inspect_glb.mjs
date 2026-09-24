// 解析 GLB，读取每个 POSITION accessors 的 min/max，结合节点 T/R/S 矩阵
// 推算模型的世界包围盒，从而判断：单位（是否米）、朝向（Y-up / Z-up）、是否以原点为中心。
import { readFileSync } from 'node:fs';

const path = process.argv[2] || 'public/models/hnjcxy.glb';
const buf = readFileSync(path);

// ---- 解析 GLB 容器 ----
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB 文件');
const totalLen = buf.readUInt32LE(8);
let off = 12;
let json = null;
let binChunks = [];
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
  else if (type === 0x004e4942) binChunks.push(data);
  off += 8 + len;
}
if (!json) throw new Error('找不到 JSON chunk');
const glb = json;

// ---- 极简 mat4（列主序，与 glTF 一致） ----
function identity() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
function mul(a, b) { // a * b
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let i = 0; i < 4; i++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[i + k * 4] * b[k + c * 4];
    r[i + c * 4] = s;
  }
  return r;
}
function fromTRS(node) {
  if (node.matrix) return node.matrix.slice();
  const t = node.translation || [0,0,0];
  const s = node.scale || [1,1,1];
  let q = node.rotation || [0,0,0,1];
  // 四元数 -> 旋转矩阵
  const [x,y,z,w] = q;
  const r00=1-2*(y*y+z*z), r01=2*(x*y-z*w), r02=2*(x*z+y*w);
  const r10=2*(x*y+z*w), r11=1-2*(x*x+z*z), r12=2*(y*z-x*w);
  const r20=2*(x*z-y*w), r21=2*(y*z+x*w), r22=1-2*(x*x+y*y);
  return [
    s[0]*r00, s[0]*r01, s[0]*r02, 0,
    s[1]*r10, s[1]*r11, s[1]*r12, 0,
    s[2]*r20, s[2]*r21, s[2]*r22, 0,
    t[0], t[1], t[2], 1,
  ];
}
function apply(m, p) { // 列主序 M * vec4(p,1)
  const [x,y,z] = p;
  return [
    m[0]*x + m[4]*y + m[8]*z + m[12],
    m[1]*x + m[5]*y + m[9]*z + m[13],
    m[2]*x + m[6]*y + m[10]*z + m[14],
  ];
}

const accessors = glb.accessors || [];
const nodes = glb.nodes || [];
const meshes = glb.meshes || [];

// 节点世界矩阵
const worldMat = new Map();
function computeWorld(idx, parent) {
  const node = nodes[idx];
  const local = fromTRS(node);
  const w = parent ? mul(parent, local) : local;
  worldMat.set(idx, w);
  for (const c of (node.children || [])) computeWorld(c, w);
}
(glb.scenes?.[glb.scene || 0]?.nodes || []).forEach((n) => computeWorld(n, null));

// 聚合世界包围盒
let min = [ Infinity, Infinity, Infinity ];
let max = [ -Infinity, -Infinity, -Infinity ];
let meshCount = 0, vertTotal = 0;

for (let ni = 0; ni < nodes.length; ni++) {
  const node = nodes[ni];
  if (node.mesh === undefined) continue;
  const m = meshes[node.mesh];
  const W = worldMat.get(ni) || identity();
  for (const prim of (m.primitives || [])) {
    const accIdx = prim.attributes?.POSITION;
    if (accIdx === undefined) continue;
    const a = accessors[accIdx];
    if (!a.min || !a.max) continue;
    meshCount++;
    vertTotal += a.count;
    const corners = [];
    for (const X of [a.min[0], a.max[0]])
      for (const Y of [a.min[1], a.max[1]])
        for (const Z of [a.min[2], a.max[2]])
          corners.push(apply(W, [X, Y, Z]));
    for (const c of corners) {
      min[0]=Math.min(min[0],c[0]); min[1]=Math.min(min[1],c[1]); min[2]=Math.min(min[2],c[2]);
      max[0]=Math.max(max[0],c[0]); max[1]=Math.max(max[1],c[1]); max[2]=Math.max(max[2],c[2]);
    }
  }
}

const size = [max[0]-min[0], max[1]-min[1], max[2]-min[2]];
const center = [(min[0]+max[0])/2, (min[1]+max[1])/2, (min[2]+max[2])/2];

console.log('=== GLB 概要 ===');
console.log('asset:', JSON.stringify(glb.asset));
console.log('mesh 节点数:', meshCount, ' 总顶点数:', vertTotal);
console.log('节点数:', nodes.length, ' 场景根:', glb.scenes?.[glb.scene||0]?.nodes);
console.log('');
console.log('=== 世界包围盒（应用节点变换后）===');
console.log('min :', min.map(v=>v.toFixed(2)));
console.log('max :', max.map(v=>v.toFixed(2)));
console.log('size:', size.map(v=>v.toFixed(2)), '  [X宽, Y高, Z深]');
console.log('center:', center.map(v=>v.toFixed(2)));
console.log('中心到原点距离:', Math.hypot(center[0],center[1],center[2]).toFixed(2));
console.log('');
console.log('=== 朝向/单位推断 ===');
const [sx,sy,sz] = size;
const axes = [['X',sx],['Y',sy],['Z',sz]].sort((a,b)=>b[1]-a[1]);
console.log('最长轴(可能是水平面):', axes[0][0], axes[0][1].toFixed(2));
console.log('最短轴(可能是高度):', axes[2][0], axes[2][1].toFixed(2));
// 建筑高度通常明显小于水平尺寸；若 Y 是高度且 ~10-50 -> Y-up 且单位米；若 Z 是高度 -> Z-up
const heightAxis = sy > sx && sy > sz ? 'Y' : (sz > sx && sz > sy ? 'Z' : '?');
console.log('推测“高度”轴:', heightAxis);
if (Math.max(sx,sy,sz) > 1000) console.log('⚠️ 模型尺寸 >1000，可能单位不是米（如 cm/mm），需调 modelScale 缩小');
else if (Math.max(sx,sy,sz) < 5) console.log('⚠️ 模型尺寸 <5，可能单位过大或异常');
else console.log('✅ 尺寸量级像“米”，modelScale=1 可能合理');
if (Math.hypot(center[0],center[1],center[2]) > 100) console.log('⚠️ 几何中心离原点很远 -> recenterModel 必须开，且需确保平移正确');
else console.log('✅ 几何中心接近原点');
