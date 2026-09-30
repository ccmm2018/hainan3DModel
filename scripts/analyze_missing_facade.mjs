// 诊断：列出每个 material 的 baseColorTexture 图像字节长度，定位"占位/极小图"。
import { readFileSync } from 'node:fs';

function readGLB(buf) {
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = Buffer.from(data);
    off += 8 + len;
  }
  return { json, bin: Buffer.from(bin) };
}

const { json, bin } = readGLB(readFileSync('public/models/hnjcxy.glb'));
const materials = json.materials || [];
const textures = json.textures || [];
const images = json.images || [];
const bufferViews = json.bufferViews || [];

console.log(`材质总数=${materials.length}  贴图=${textures.length}  图像=${images.length}`);
console.log('—'.repeat(90));
console.log('材质名'.padEnd(34), '有贴图', '字节'.padStart(9), 'mime', '判定');
console.log('—'.repeat(90));

// 白盒楼 / 食堂 名单（来自之前 inspect；此处仅做命中提示）
const WHITE = ['Bk____3','Bk____4','Bk_Facade_Dorm_8_8','Bk_Facade_Dorm_9_9','Bk_Facade_Dorm_10','Bk_Facade_Dorm_11','Bk_Facade_Dorm_16_16'];
const CANTEEN = ['Bk_Canteen_Face0__7','Bk_Canteen_Face1__7','Bk_Canteen_Face2__7','Bk_Canteen_Face3__7','Bk_Canteen_Face4__7','Bk_Canteen_Face5__7'];

let tiny = 0, white = 0, canteen = 0;
for (const m of materials) {
  const name = m.name || '(unnamed)';
  const texIdx = m.pbrMetallicRoughness?.baseColorTexture?.index;
  let has = '   -   ', bytes = 0, mime = '';
  if (texIdx !== undefined && textures[texIdx]) {
    const imgIdx = textures[texIdx].source;
    if (imgIdx !== undefined && images[imgIdx]) {
      has = '  YES  ';
      const img = images[imgIdx];
      mime = img.mimeType || '';
      if (img.bufferView !== undefined && bufferViews[img.bufferView]) {
        bytes = bufferViews[img.bufferView].byteLength;
      } else if (img.uri) {
        mime += ' (uri)';
      }
    }
  }
  let tag = '';
  if (WHITE.includes(name)) { tag = '白盒楼'; white++; }
  if (CANTEEN.includes(name)) { tag = '食堂面'; canteen++; }
  // 占位/极小判定：JPEG 且 < 2048 字节视为占位
  const isTiny = (bytes > 0 && bytes < 2048);
  if (isTiny) { tag += (tag ? '+' : '') + '极小图'; tiny++; }
  if (tag || isTiny) {
    console.log(name.padEnd(34), has, String(bytes).padStart(9), mime.padEnd(10), tag);
  }
}
console.log('—'.repeat(90));
console.log(`命中白盒名单=${white}  命中食堂名单=${canteen}  字节<2048的极小贴图=${tiny}`);
