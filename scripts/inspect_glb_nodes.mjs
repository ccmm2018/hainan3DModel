// 解析 GLB 节点树：索引 / 名称 / 是否带 mesh / mesh 名 / 父子关系
import fs from 'fs';

const path = process.argv[2] || 'public/models/hnjcxy.glb';
const buf = fs.readFileSync(path);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));

const nodes = json.nodes || [];
const meshes = json.meshes || [];

// 反向：每个节点的子节点
const childrenOf = nodes.map(() => []);
nodes.forEach((n, i) => {
  (n.children || []).forEach((c) => {
    if (c >= 0 && c < childrenOf.length) childrenOf[c].push(i); // c 的父是 i
  });
});

function parentOf(i) {
  for (let p = 0; p < childrenOf.length; p++) {
    if (childrenOf[i].includes(p)) return p;
  }
  return -1;
}

console.log(`GLB: ${path}`);
console.log(`节点总数: ${nodes.length} | 网格总数: ${meshes.length}`);
console.log('='.repeat(80));

// 树状打印（从根节点开始：无父节点的节点）
const roots = nodes.map((_, i) => i).filter((i) => parentOf(i) === -1);

function printNode(i, depth) {
  const n = nodes[i];
  const hasMesh = n.mesh !== undefined;
  const meshName = hasMesh ? (meshes[n.mesh]?.name || `mesh#${n.mesh}`) : '';
  const nm = n.name || '(无名)';
  const flag = hasMesh ? `[MESH:${meshName}]` : '[空节点]';
  console.log(
    `${'  '.repeat(depth)}#${i} "${nm}" ${flag}` +
      (n.children?.length ? ` -> ${n.children.length}个子节点` : ''),
  );
  (n.children || []).forEach((c) => printNode(c, depth + 1));
}

roots.forEach((r) => printNode(r, 0));

console.log('='.repeat(80));
// 统计：带 mesh 的节点 vs 空节点
const meshNodes = nodes.filter((n) => n.mesh !== undefined);
const emptyNodes = nodes.filter((n) => n.mesh === undefined);
console.log(`带 mesh 的节点: ${meshNodes.length}`);
console.log(`空节点(empty/armature/bone 等,不渲染几何): ${emptyNodes.length}`);
console.log('--- 带 mesh 的节点清单 ---');
meshNodes.forEach((n) => {
  console.log(`  "${n.name || '(无名)'}" -> ${meshes[n.mesh]?.name || '?'}`);
});
