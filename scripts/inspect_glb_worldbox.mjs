import fs from 'fs';

const path = process.argv[2] || 'public/models/hnjcxy.glb';
const buf = fs.readFileSync(path);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));

// --- minimal mat4 helpers ---
function ident() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
function mul(a, b) {
  const r = new Array(16).fill(0);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++)
      for (let k = 0; k < 4; k++)
        r[i*4+j] += a[i*4+k] * b[k*4+j];
  return r;
}
// local matrix from node (matrix OR t/r/s)
function nodeMatrix(n) {
  if (n.matrix) {
    // glTF matrix is column-major; our mul expects column-major too
    return n.matrix.slice();
  }
  const t = n.translation || [0,0,0];
  const r = n.rotation || [0,0,0,1]; // quaternion xyzw
  const s = n.scale || [1,1,1];
  // R from quaternion
  const [x,y,z,w] = r;
  const R = [
    1-2*(y*y+z*z), 2*(x*y-z*w),   2*(x*z+y*w),  0,
    2*(x*y+z*w),   1-2*(x*x+z*z), 2*(y*z-x*w),  0,
    2*(x*z-y*w),   2*(y*z+x*w),   1-2*(x*x+y*y),0,
    0,0,0,1
  ];
  const T = [1,0,0,t[0], 0,1,0,t[1], 0,0,1,t[2], 0,0,0,1];
  const S = [s[0],0,0,0, 0,s[1],0,0, 0,0,s[2],0, 0,0,0,1];
  return mul(mul(T, R), S);
}
function transformPoint(m, p) {
  const [x,y,z] = p;
  return [
    m[0]*x + m[4]*y + m[8]*z + m[12],
    m[1]*x + m[5]*y + m[9]*z + m[13],
    m[2]*x + m[6]*y + m[10]*z + m[14],
  ];
}

// --- compute world matrix per node ---
const nodes = json.nodes || [];
const world = new Array(nodes.length);
function walk(i, parent) {
  const n = nodes[i];
  const m = mul(parent || ident(), nodeMatrix(n));
  world[i] = m;
  for (const c of (n.children || [])) walk(c, m);
}
for (let i = 0; i < nodes.length; i++) {
  if (!world[i]) walk(i, ident());
}

// --- accumulate world-space box from every primitive ---
let mn = [Infinity,Infinity,Infinity], mx = [-Infinity,-Infinity,-Infinity];
const acc = json.accessors;
for (const n of nodes) {
  if (n.mesh == null) continue;
  const m = world[nodes.indexOf(n)];
  const mesh = json.meshes[n.mesh];
  for (const prim of mesh.primitives) {
    const a = acc[prim.attributes.POSITION];
    const r = a.min, R = a.max;
    const corners = [
      [r[0],r[1],r[2]],[R[0],r[1],r[2]],[r[0],R[1],r[2]],[R[0],R[1],r[2]],
      [r[0],r[1],R[2]],[R[0],r[1],R[2]],[r[0],R[1],R[2]],[R[0],R[1],R[2]],
    ];
    for (const c of corners) {
      const p = transformPoint(m, c);
      for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
    }
  }
}
const size = mx.map((v,i)=>+(v-mn[i]).toFixed(2));
const center = mn.map((v,i)=>+((v+mx[i])/2).toFixed(2));
console.log('WORLD-SPACE min :', mn.map(v=>+v.toFixed(2)));
console.log('WORLD-SPACE max :', mx.map(v=>+v.toFixed(2)));
console.log('WORLD-SPACE size:', size, '(X=东西宽, Y=高度, Z=南北深)');
console.log('WORLD-SPACE center:', center, '距原点:', Math.hypot(...center).toFixed(2));

// guess: which unit makes a sane building?
console.log('--- 假设不同单位下真实尺寸(米) ---');
for (const factor of [1, 0.01, 100]) {
  console.log(`乘子 ${factor}: 宽 ${size[0]*factor}m × 高 ${size[1]*factor}m × 深 ${size[2]*factor}m`);
}
