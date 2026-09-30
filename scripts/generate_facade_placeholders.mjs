// 程序化生成「示意立面贴图」——用于源 GLB 中缺失真实照的楼栋/食堂面占位。
// 输出两张 PNG 到 facade_photos/：dorm.png（宿舍楼示意）、canteen.png（食堂示意）。
// 这是临时兜底：后续拿到真实外立面照片，按同名替换 dorm.png / canteen.png 并重跑 embed 即可覆盖。
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// ---------- PNG 编码（8bit RGB, color type 2） ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(W, H, rgb) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0;
    const src = y * W * 3;
    for (let x = 0; x < W * 3; x++) raw[y * (1 + W * 3) + 1 + x] = rgb[src + x];
  }
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 简易画板 ----------
function makeCanvas(W, H) {
  const img = new Uint8Array(W * H * 3);
  return {
    img, W, H,
    fill(r, g, b) { for (let i = 0; i < W * H; i++) { img[i*3]=r; img[i*3+1]=g; img[i*3+2]=b; } },
    rect(x0, y0, x1, y1, r, g, b) {
      for (let y = Math.max(0,y0); y < Math.min(H,y1); y++)
        for (let x = Math.max(0,x0); x < Math.min(W,x1); x++) {
          const i = (y * W + x) * 3; img[i]=r; img[i+1]=g; img[i+2]=b;
        }
    },
    border(x0, y0, x1, y1, t, r, g, b) {
      this.rect(x0, y0, x1, y0 + t, r, g, b);
      this.rect(x0, y1 - t, x1, y1, r, g, b);
      this.rect(x0, y0, x0 + t, y1, r, g, b);
      this.rect(x1 - t, y0, x1, y1, r, g, b);
    },
  };
}

// ---------- 宿舍楼示意 ----------
function drawDorm() {
  const W = 1024, H = 1024, c = makeCanvas(W, H);
  c.fill(232, 218, 178);                 // 暖米黄墙体
  c.rect(0, 0, W, 46, 210, 196, 160);   // 屋顶压顶
  const floors = 6, margin = 50, top = 70;
  const floorH = (H - top - margin) / floors;
  const cols = 5, wW = 130, wH = Math.floor(floorH * 0.6);
  const gapX = (W - 2 * margin - cols * wW) / (cols + 1);
  for (let f = 0; f < floors; f++) {
    const y = top + f * floorH;
    c.rect(0, y, W, y + 4, 198, 183, 148);  // 楼层分隔线
    for (let k = 0; k < cols; k++) {
      const x = margin + gapX + k * (wW + gapX);
      const wy = y + floorH * 0.18, wh = wH;
      c.rect(x, wy, x + wW, wy + wh, 74, 96, 128);          // 窗玻璃
      c.border(x, wy, x + wW, wy + wh, 4, 122, 142, 172);   // 窗框
      c.rect(x + 6, wy + 6, x + wW - 6, wy + 10, 150, 170, 196); // 高光
    }
  }
  c.rect(W / 2 - 70, H - margin - 180, W / 2 + 70, H - margin, 96, 74, 56); // 入口门
  c.border(W / 2 - 70, H - margin - 180, W / 2 + 70, H - margin, 5, 70, 52, 38);
  c.rect(0, H - 26, W, H, 188, 180, 158); // 散水/地面
  return encodePNG(W, H, c.img);
}

// ---------- 食堂示意（大玻璃幕墙 + 入口） ----------
function drawCanteen() {
  const W = 1024, H = 1024, c = makeCanvas(W, H);
  c.fill(220, 223, 228);                 // 浅灰白墙体
  c.rect(0, 0, W, 40, 200, 203, 208);    // 顶
  const rows = 4, cols = 6, mx = 34, my = 60;
  const baseH = 120;
  const gh = (H - my - baseH) / rows;
  const gw = (W - 2 * mx) / cols;
  for (let r = 0; r < rows; r++)
    for (let k = 0; k < cols; k++) {
      const x = mx + k * gw + 12, y = my + r * gh + 12, w = gw - 24, h = gh - 24;
      c.rect(x, y, x + w, y + h, 150, 192, 210);            // 玻璃
      c.border(x, y, x + w, y + h, 5, 108, 150, 176);       // 幕墙框
      c.rect(x + w / 2 - 3, y, x + w / 2 + 3, y + h, 205, 213, 222); // 竖梃
      c.rect(x, y + h / 2 - 3, x + w, y + h / 2 + 3, 205, 213, 222); // 横梃
    }
  c.rect(W / 2 - 110, H - baseH + 10, W / 2 + 110, H - 30, 92, 112, 132); // 入口
  c.border(W / 2 - 110, H - baseH + 10, W / 2 + 110, H - 30, 6, 70, 90, 110);
  c.rect(0, H - 30, W, H, 182, 184, 188); // 地面
  return encodePNG(W, H, c.img);
}

mkdirSync('facade_photos', { recursive: true });
const dorm = drawDorm();
const canteen = drawCanteen();
writeFileSync('facade_photos/dorm.png', dorm);
writeFileSync('facade_photos/canteen.png', canteen);
console.log(`✓ 生成 dorm.png (${dorm.length} bytes)  canteen.png (${canteen.length} bytes) -> facade_photos/`);
