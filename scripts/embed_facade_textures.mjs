// 把真实外立面照片按「材质名」精确嵌入 GLB，替换掉源文件里损坏/占位的 baseColor 贴图。
//
// 用法：
//   node scripts/embed_facade_textures.mjs \
//       --model public/models/hnjcxy.glb \
//       --photos ./facade_photos \
//       [--out public/models/hnjcxy.glb]   // 默认写 <model>.embedded.glb，加 --apply 才覆盖原文件（先自动备份 .bak）
//
// 照片命名约定：照片文件名（不含扩展名）必须等于 GLB 里的材质名。例如：
//   facade_photos/Bk____3.jpg
//   facade_photos/Bk_Facade_Dorm_8_8.jpg
//   facade_photos/Bk_Canteen_Face0__7.png
// 脚本会逐个匹配 GLB 中存在的同名师質，把该材質的 baseColor 贴图替换为对应照片的二进制。
// 只改这些指定材质，其它材质/几何体/节点完全不动 —— 绝不会误伤正常楼栋、屋顶或地面。
//
// 注意（WebGL1 兼容）：照片直接用原始字节嵌入。若照片非 2 的幂尺寸，运行时 MapScene
// 的 makeTexturesWebGL1Safe 会自动降级（关 mipmap + ClampToEdge），材质仍正常显示，
// 仅远处略粗糙。如需保留 mipmap 画质，请先自行把照片缩放到 1024×1024 等 2 的幂尺寸。

import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--apply') args.set('--apply', 'true');
  else if (a.startsWith('--')) args.set(a, process.argv[++i]);
}

const modelPath = args.get('--model') || 'public/models/hnjcxy.glb';
const photosDir = args.get('--photos');
const outPath = args.get('--out') || modelPath.replace(/\.glb$/i, '.embedded.glb');

if (!photosDir || !existsSync(photosDir)) {
  console.error('✗ 请提供照片目录：--photos <目录>');
  process.exit(1);
}
if (!existsSync(modelPath)) {
  console.error(`✗ 找不到模型：${modelPath}`);
  process.exit(1);
}

// ---- 解析 GLB 容器 ----
function readGLB(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB 文件');
  let off = 12;
  let json = null;
  let bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = Buffer.from(data);
    off += 8 + len;
  }
  if (!json || !bin) throw new Error('GLB 结构异常');
  return { json, bin: Buffer.from(bin) };
}

function writeGLB(path, json, bin) {
  // BIN chunk 必须 4 字节对齐，用 0 补齐
  const binPad = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);
  // buffer.byteLength 必须等于 BIN chunk 实际载荷长度（含补齐）。
  // 必须在 JSON.stringify 之前设置，否则序列化出的 JSON 会保留旧值。
  if (json.buffers && json.buffers[0]) json.buffers[0].byteLength = binChunk.length;
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  // JSON chunk 必须 4 字节对齐，用空格(0x20)补齐
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // glTF
  header.writeUInt32LE(2, 4); // version
  header.writeUInt32LE(total, 8);
  const out = Buffer.concat([
    header,
    (() => { const b = Buffer.alloc(8); b.writeUInt32LE(jsonChunk.length, 0); b.writeUInt32LE(0x4e4f534a, 4); return b; })(),
    jsonChunk,
    (() => { const b = Buffer.alloc(8); b.writeUInt32LE(binChunk.length, 0); b.writeUInt32LE(0x004e4942, 4); return b; })(),
    binChunk,
  ]);
  writeFileSync(path, out);
}

const { json, bin } = readGLB(readFileSync(modelPath));
const materials = json.materials || [];
const textures = json.textures || [];
const images = json.images || [];
const bufferViews = json.bufferViews || [];

// 材质名 -> 材质索引
const matByName = new Map();
materials.forEach((m, i) => { if (m.name) matByName.set(m.name, i); });

// 收集照片文件（文件名 stem = 材质名）
const extToMime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const photoFiles = [];
for (const f of readdirSync(photosDir)) {
  const ext = extname(f).toLowerCase();
  if (extToMime[ext]) photoFiles.push(f);
}

let modified = 0;
let binWork = Buffer.from(bin); // 可变的 bin，逐张追加
const newBufferViews = []; // 记录新增的 bufferView 索引（基于当前 bufferViews 长度）

for (const f of photoFiles) {
  const matName = basename(f, extname(f));
  if (!matByName.has(matName)) {
    console.log(`⚠ 跳过 ${f}：GLB 中不存在材质「${matName}」`);
    continue;
  }
  const mi = matByName.get(matName);
  const mat = materials[mi];
  const texIdx = mat.pbrMetallicRoughness?.baseColorTexture?.index;
  if (texIdx === undefined || !textures[texIdx]) {
    console.log(`⚠ 跳过 ${f}：材质「${matName}」没有 baseColorTexture`);
    continue;
  }
  const imgIdx = textures[texIdx].source;
  if (imgIdx === undefined || !images[imgIdx]) {
    console.log(`⚠ 跳过 ${f}：贴图 ${texIdx} 没有 source 图像`);
    continue;
  }

  const photoBytes = readFileSync(join(photosDir, f));
  const mime = extToMime[extname(f).toLowerCase()] || 'image/jpeg';

  // 4 字节对齐后追加到 bin 末尾
  const offset = binWork.length;
  const pad = (4 - (offset % 4)) % 4;
  const paddedOffset = offset + pad;
  binWork = Buffer.concat([binWork, Buffer.alloc(pad, 0), photoBytes]);

  const bv = { buffer: 0, byteOffset: paddedOffset, byteLength: photoBytes.length };
  bufferViews.push(bv);
  const newBvIdx = bufferViews.length - 1;

  // 更新 image：指向新 bufferView，去掉可能的 uri，设置 mime
  delete images[imgIdx].uri;
  images[imgIdx].bufferView = newBvIdx;
  images[imgIdx].mimeType = mime;

  modified++;
  console.log(`✓ 已替换材质「${matName}」的贴图 <- ${f} (${photoBytes.length} bytes)`);
}

// ---- 自动兜底：白盒楼 / 食堂占位面 -> 复用示意贴图（dorm.png / canteen.png） ----
// 仅作用于「贴图字节 < 2048 的占位图」，已有真实照（≥2048）的材质绝不改动。
const REUSE = [
  { test: /^Bk_Facade_Dorm_/, photo: 'dorm.png' },
  // Bk____3 / Bk____4 原材质名为「食堂」（中文字符导出时被剥成下划线），套食堂贴图
  { test: /^Bk____/, photo: 'canteen.png' },
  { test: /^Bk_Canteen_Face/, photo: 'canteen.png' },
];
for (const [matName, mi] of matByName) {
  const mat = materials[mi];
  const texIdx = mat.pbrMetallicRoughness?.baseColorTexture?.index;
  if (texIdx === undefined || !textures[texIdx]) continue;
  const imgIdx = textures[texIdx].source;
  if (imgIdx === undefined || !images[imgIdx]) continue;
  const bv = images[imgIdx].bufferView;
  const curBytes = (bv !== undefined && bufferViews[bv]) ? bufferViews[bv].byteLength : 1e9;
  if (curBytes >= 2048) continue; // 已有真实照，跳过
  const rule = REUSE.find((r) => r.test.test(matName));
  if (!rule) continue;
  const photoPath = join(photosDir, rule.photo);
  if (!existsSync(photoPath)) continue;
  const photoBytes = readFileSync(photoPath);
  const mime = extToMime[extname(photoPath).toLowerCase()] || 'image/png';
  const offset = binWork.length;
  const pad = (4 - (offset % 4)) % 4;
  const paddedOffset = offset + pad;
  binWork = Buffer.concat([binWork, Buffer.alloc(pad, 0), photoBytes]);
  const bvNew = { buffer: 0, byteOffset: paddedOffset, byteLength: photoBytes.length };
  bufferViews.push(bvNew);
  const newBvIdx = bufferViews.length - 1;
  delete images[imgIdx].uri;
  images[imgIdx].bufferView = newBvIdx;
  images[imgIdx].mimeType = mime;
  modified++;
  console.log(`✓ [兜底] 已替换材质「${matName}」占位贴图 <- ${rule.photo} (${photoBytes.length} bytes)`);
}

if (modified === 0) {
  console.log('没有任何照片被嵌入，未改动模型。');
  process.exit(0);
}

json.bufferViews = bufferViews;
if (json.buffers && json.buffers[0]) json.buffers[0].byteLength = binWork.length;

const finalOut = args.get('--apply') === 'true' ? modelPath : outPath;
if (args.get('--apply') === 'true') {
  copyFileSync(modelPath, modelPath + '.bak');
  console.log(`已备份原模型为 ${modelPath}.bak`);
}
writeGLB(finalOut, json, binWork);
console.log(`\n✅ 完成：共嵌入 ${modified} 张照片 -> ${finalOut}`);
console.log(args.get('--apply') === 'true'
  ? '已覆盖原模型；如需回滚请使用 .bak。'
  : `未覆盖原文件。确认无误后用 --apply 覆盖，或手动把 .embedded.glb 改名覆盖 hnjcxy.glb。`);
