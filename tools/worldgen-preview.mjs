// Level preview: PNG (+ ASCII on request).  node tools/worldgen-preview.mjs <seed> <depth> [out.png] [--ascii]
import fs from 'node:fs';
import zlib from 'node:zlib';
import { generateLevel, sdfAt } from '../js/world.js';
import { CELL } from '../js/config.js';
import { traceRoute } from './worldgen-lib.mjs';

function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function writePng(file, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

export function renderLevel(lv, scale = 2) {
  const w = lv.W * scale, h = lv.H * scale;
  const px = Buffer.alloc(w * h * 3);
  const set = (x, y, r, g, b) => { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= w || y >= h) return; const i = (y * w + x) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b; };
  const k = scale / CELL;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = sdfAt(lv, x / k, y / k);
    if (s < 0) set(x, y, 14, 16, 26);
    else { const v = Math.min(1, s / 70); set(x, y, 30 + 70 * v, 50 + 100 * v, 80 + 110 * v); if (s < 2.5) set(x, y, 200, 220, 240); }
  }
  const disc = (cx, cy, r, c) => { for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) set(cx * k + x, cy * k + y, c[0], c[1], c[2]); };
  const ring = (cx, cy, rr, c) => { for (let a = 0; a < 6.283; a += 0.02) set(cx * k + Math.cos(a) * rr * k, cy * k + Math.sin(a) * rr * k, c[0], c[1], c[2]); };
  for (const c of lv.currents) { ring(c.x, c.y, c.r, [60, 120, 255]); for (let t = 0; t < c.r; t += 3) set((c.x + Math.cos(c.ang) * t) * k, (c.y + Math.sin(c.ang) * t) * k, 60, 120, 255); }
  const route = traceRoute(lv);
  for (const c of route.path) disc(((c % lv.gw) + 0.5) * 16, (((c / lv.gw) | 0) + 0.5) * 16, 1, [255, 255, 255]);
  const sp = lv.spawns;
  for (const p of sp.pearls) disc(p.x, p.y, 1, [255, 255, 255]);
  for (const p of sp.buoys) disc(p.x, p.y, 3, [80, 255, 200]);
  for (const p of sp.patches) disc(p.x, p.y, 3, [120, 255, 120]);
  for (const p of sp.jellies) disc(p.x, p.y, 4, [90, 220, 255]);
  for (const p of sp.urchins) { disc(p.x, p.y, 5, [255, 60, 60]); ring(p.x, p.y, 22, [255, 90, 90]); }
  for (const p of sp.eels) disc(p.x, p.y, 4, [255, 80, 220]);
  for (const p of sp.anglers) disc(p.x, p.y, 5, [255, 170, 40]);
  if (sp.leviathan) { disc(sp.leviathan.x, sp.leviathan.y, 9, [255, 30, 30]); }
  disc(lv.start.x, lv.start.y, 6, [60, 255, 60]);
  disc(lv.exit.x, lv.exit.y, 7, [255, 240, 40]);
  return { w, h, px };
}

export function asciiLevel(lv, step = 24) {
  const rows = [];
  const mark = new Map();
  const put = (p, ch) => mark.set(Math.round(p.x / step) + ',' + Math.round(p.y / (step * 2)), ch);
  for (const p of lv.spawns.pearls) put(p, '*');
  for (const p of lv.spawns.jellies) put(p, 'j');
  for (const p of lv.spawns.urchins) put(p, 'U');
  for (const p of lv.spawns.eels) put(p, 'e');
  for (const p of lv.spawns.anglers) put(p, 'A');
  for (const p of lv.spawns.buoys) put(p, 'b');
  for (const p of lv.spawns.patches) put(p, 'p');
  if (lv.spawns.leviathan) put(lv.spawns.leviathan, 'L');
  put(lv.start, 'S'); put(lv.exit, 'E');
  for (let y = 0; y < lv.height; y += step * 2) {
    let row = '';
    for (let x = 0; x < lv.width; x += step) {
      const m = mark.get(Math.round(x / step) + ',' + Math.round(y / (step * 2)));
      if (m) { row += m; continue; }
      const s = sdfAt(lv, x, y);
      row += s < 0 ? '#' : s < 18 ? '+' : s < 40 ? '.' : ' ';
    }
    rows.push(row);
  }
  return rows.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('worldgen-preview.mjs')) {
  const seed = process.argv[2] || 'preview', depth = +(process.argv[3] || 1);
  const out = process.argv[4] && !process.argv[4].startsWith('--') ? process.argv[4] : null;
  const lv = generateLevel(seed, depth);
  console.log(`seed=${seed} depth=${depth} grid=${lv.gw}x${lv.gh} route=${lv.routeLength} reach=${lv.reach} spawns=${JSON.stringify(Object.fromEntries(Object.entries(lv.spawns).map(([k, v]) => [k, Array.isArray(v) ? v.length : !!v])))}`);
  if (out) { const r = renderLevel(lv, 2); writePng(out, r.w, r.h, r.px); console.log('wrote', out); }
  if (process.argv.includes('--ascii')) console.log(asciiLevel(lv));
}
