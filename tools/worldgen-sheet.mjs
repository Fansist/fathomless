// Contact sheet of several levels in one PNG.   node tools/worldgen-sheet.mjs out.png "1,3,6,9,12" [seedPrefix=q] [seedNo=0] [cols=2] [scale=1]
// Legend: green=start yellow=exit white dots=pearls, white line=S-route, cyan=jelly red=urchin(ring=22px) magenta=eel orange=angler
//         green dots=patch, teal=buoy, big red=leviathan, blue rings=currents
const { generateLevel } = await import(process.env.WORLD || '../js/world.js');
import { renderLevel, writePng } from './worldgen-preview.mjs';

const out = process.argv[2] || 'sheet.png';
const specs = (process.argv[3] || '1,3,6,9,12').split(','); // each entry: depth or depth@seedNo
const depths = specs.map((x) => +x.split('@')[0]);
const prefix = process.argv[4] || 'q', seedNo = process.argv[5] || '0';
const cols = +(process.argv[6] || 2), scale = +(process.argv[7] || 1);
const tiles = specs.map((x) => { const [d, sn] = x.split('@'); return renderLevel(generateLevel(prefix + (sn !== undefined ? sn : seedNo), +d), scale); });
const rows = Math.ceil(tiles.length / cols);
const cw = Math.max(...tiles.map((t) => t.w)) + 6, ch = Math.max(...tiles.map((t) => t.h)) + 6;
const W = cw * cols, H = ch * rows;
const px = Buffer.alloc(W * H * 3, 30);
tiles.forEach((t, i) => {
  const ox = (i % cols) * cw + 3, oy = ((i / cols) | 0) * ch + 3;
  for (let y = 0; y < t.h; y++) t.px.copy(px, ((oy + y) * W + ox) * 3, y * t.w * 3, (y + 1) * t.w * 3);
});
writePng(out, W, H, px);
console.log('wrote', out, W + 'x' + H, 'depths', depths.join(','));
