import fs from 'node:fs';

const path = process.argv[2] || 'public/models/hnjcxy.glb';
const buf = fs.readFileSync(path);
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
const nodes = json.nodes || [];

const isNum = (n) => /^\d+$/.test(n || '');
const isBuilding = (n) => {
  const v = Number(n);
  return Number.isInteger(v) && v >= 0 && v <= 25;
};

console.log('total nodes:', nodes.length);
console.log('\nidx | name | parent | mesh? | numeric? | building(0-25)?');
nodes.forEach((nd, i) => {
  console.log(
    String(i).padStart(3, ' '),
    '|',
    (nd.name ?? '<none>').padEnd(20),
    '|',
    (nd.parent !== undefined ? nd.parent : '-').toString().padStart(4, ' '),
    '|',
    (nd.mesh !== undefined ? 'Y' : ' '),
    '|',
    (isNum(nd.name) ? 'Y' : ' '),
    '|',
    (isBuilding(nd.name) ? 'Y' : ' '),
  );
});

// 统计：非建筑节点里，有多少是某建筑节点的后代（即"建筑上的装饰"）
const parentOf = (i) => nodes[i].parent;
const ancestorsAreBuilding = (i) => {
  let p = parentOf(i);
  while (p !== undefined) {
    if (isBuilding(nodes[p].name)) return nodes[p].name;
    p = parentOf(p);
  }
  return null;
};

const nonBuilding = nodes
  .map((nd, i) => ({ i, nd }))
  .filter(({ nd }) => !isBuilding(nd.name));
let underBuilding = 0;
let standalone = 0;
nonBuilding.forEach(({ i }) => {
  if (ancestorsAreBuilding(i)) underBuilding++;
  else standalone++;
});
console.log('\n非建筑节点总数:', nonBuilding.length);
console.log('  ├─ 属于某建筑(0-25)后代(点它应归并到楼):', underBuilding);
console.log('  └─ 完全不属于任何楼(应彻底不可点):', standalone);
