// How much of the player's water can each creature class actually path through?  (nav S = eels, L = jellies/anglers, XL = leviathan)
//   node tools/worldgen-navcover.mjs [--seeds 40]
//   WORLD=../js/world.baseline.js node tools/worldgen-navcover.mjs
import { COARSE } from '../js/config.js';
import { mean } from './worldgen-lib.mjs';
const WORLD = process.env.WORLD || '../js/world.js';
const { generateLevel, cellOf } = await import(WORLD);
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const SEEDS = +arg('seeds', 40);
const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

function components(lv, cls) {
  const nav = lv.nav[cls], gw = lv.gw, gh = lv.gh, n = gw * gh;
  const lab = new Int32Array(n).fill(-1), q = new Int32Array(n), sizes = [];
  for (let c0 = 0; c0 < n; c0++) {
    if (!nav[c0] || lab[c0] >= 0) continue;
    let qh = 0, qt = 0; q[qt++] = c0; lab[c0] = sizes.length;
    while (qh < qt) {
      const c = q[qh++], x = c % gw, y = (c / gw) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + D8[k][0], ny = y + D8[k][1];
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const m = ny * gw + nx;
        if (!nav[m] || lab[m] >= 0) continue;
        if (k >= 4 && !(nav[y * gw + nx] && nav[ny * gw + x])) continue;
        lab[m] = sizes.length; q[qt++] = m;
      }
    }
    sizes.push(qt);
  }
  let big = 0; sizes.forEach((s, i) => { if (s > sizes[big]) big = i; });
  return { lab, sizes, big };
}

console.log(`world=${WORLD}`);
console.log('depth |  S cells(reach)  L / S%   biggest L patch / S%   jellies in biggest L patch  anglers in L   |  XL / S%  biggest XL patch / S%');
for (const d of [1, 2, 3, 4, 6, 8, 10, 12]) {
  const A = { l: [], bl: [], xl: [], bxl: [], jin: [], jn: [], ain: [], an: [], s: [] };
  for (let s = 0; s < SEEDS; s++) {
    const lv = generateLevel('nc' + s, d);
    const nS = lv.reach;
    const cL = components(lv, 'L'), cX = components(lv, 'XL');
    let nL = 0, nX = 0;
    for (let c = 0; c < lv.gw * lv.gh; c++) { if (lv.nav.L[c] && lv.startDist[c] >= 0) nL++; if (lv.nav.XL[c] && lv.startDist[c] >= 0) nX++; }
    A.s.push(nS); A.l.push(nL / nS); A.bl.push(cL.sizes[cL.big] / nS); A.xl.push(nX / nS); A.bxl.push(cX.sizes.length ? cX.sizes[cX.big] / nS : 0);
    for (const j of lv.spawns.jellies) { A.jn.push(1); const c = cellOf(lv, j.x, j.y); A.jin.push(cL.lab[c] === cL.big ? 1 : 0); }
    for (const a of lv.spawns.anglers) { A.an.push(1); const c = cellOf(lv, a.x, a.y); A.ain.push(lv.nav.L[c] ? 1 : 0); }
  }
  const f = (a) => (100 * mean(a)).toFixed(0).padStart(3) + '%';
  console.log(`${String(d).padStart(4)}  | ${mean(A.s).toFixed(0).padStart(6)}         ${f(A.l)}    ${f(A.bl)}                   ${A.jn.length ? f(A.jin) : '  - '}                       ${A.an.length ? f(A.ain) : '  - '}         |  ${f(A.xl)}     ${f(A.bxl)}`);
}
