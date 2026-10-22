// rayMarch accuracy / cost and lineClear sanity vs brute force (Node, single thread).
//   node tools/worldgen-ray.mjs [--levels 40] [--rays 100] [--strict]
//   WORLD=../js/world.baseline.js node tools/worldgen-ray.mjs
import { RNG, TAU } from '../js/rng.js';
import { pct, mean } from './worldgen-lib.mjs';

const WORLD = process.env.WORLD || '../js/world.js';
const { generateLevel, sdfAt, gradAt, rayMarch, lineClear } = await import(WORLD);
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const LEVELS = +arg('levels', 40), RAYS = +arg('rays', 100);

// ground truth: first sample (0.25 px steps) where sdf < 0.6, same hit definition as rayMarch
function brute(lv, x, y, dx, dy, maxD) {
  for (let t = 0; t <= maxD; t += 0.25) if (sdfAt(lv, x + dx * t, y + dy * t) < 0.6) return t;
  return maxD;
}
function bruteMinSdf(lv, ax, ay, bx, by) {
  const len = Math.hypot(bx - ax, by - ay);
  let m = 1e9;
  for (let t = 0; t <= len; t += 0.5) m = Math.min(m, sdfAt(lv, ax + (bx - ax) * t / len, ay + (by - ay) * t / len));
  return m;
}

const errs = [], big = [], kinds = { open: [], graze: [], near: [] };
let rays = 0, tMarch = 0, grazeTangent = 0;
let lcFalsePos = 0, lcFalseNeg = 0, lcN = 0;
const lcNear = [];
const gt = { x: 0, y: 0 };
const cases = []; // keep rays for the timing pass
for (let li = 0; li < LEVELS; li++) {
  const depth = 1 + (li % 13);
  const lv = generateLevel('ray' + li, depth);
  const rng = new RNG('rayrng' + li);
  for (let k = 0; k < RAYS; k++) {
    let x, y, a, kind;
    // random open point
    for (let tries = 0; tries < 200; tries++) { x = rng.range(30, lv.width - 30); y = rng.range(30, lv.height - 30); if (sdfAt(lv, x, y) > 9) break; }
    const flavour = k % 4;
    if (flavour === 3) { // grazing: start near a wall and shoot almost tangent to it
      gradAt(lv, x, y, gt);
      // walk onto a wall-adjacent point
      for (let i = 0; i < 40 && sdfAt(lv, x, y) > 12; i++) { x -= gt.x * 4; y -= gt.y * 4; gradAt(lv, x, y, gt); }
      a = Math.atan2(gt.x, -gt.y) + rng.range(-0.06, 0.06) + (rng.chance(0.5) ? Math.PI : 0);
      kind = 'graze';
    } else if (flavour === 2) { a = rng.range(0, TAU); kind = 'near'; // from a point that is close to rock
      gradAt(lv, x, y, gt);
      for (let i = 0; i < 40 && sdfAt(lv, x, y) > 10; i++) { x -= gt.x * 4; y -= gt.y * 4; gradAt(lv, x, y, gt); }
    } else { a = rng.range(0, TAU); kind = 'open'; }
    if (sdfAt(lv, x, y) < 1) continue;
    const dx = Math.cos(a), dy = Math.sin(a);
    const maxD = [230, 400, 660, 1056][k % 4];
    cases.push([lv, x, y, dx, dy, maxD]);
    const b = brute(lv, x, y, dx, dy, maxD);
    const m = rayMarch(lv, x, y, dx, dy, maxD);
    let e = Math.abs(m - b);
    if (e >= 2 && b < maxD) { // brushing the surface: the sdf dips under the 0.6 px hit threshold by a hair, sailing past is fine
      let dip = 1e9;
      for (let t = b - 1; t <= b + 2; t += 0.05) dip = Math.min(dip, sdfAt(lv, x + dx * t, y + dy * t));
      if (dip >= 0.25) { grazeTangent++; e = 0; }
    }
    errs.push(e); kinds[kind].push(e); rays++;
    if (e >= 2) big.push({ li, depth, kind, x: Math.round(x), y: Math.round(y), a: +a.toFixed(3), maxD, brute: +b.toFixed(1), march: +m.toFixed(1) });
    // lineClear vs brute force
    if (k % 2 === 0) {
      const bx = x + dx * rng.range(20, 420), by = y + dy * rng.range(20, 420) ;
      const r = [3, 9, 12, 15, 23][k % 5];
      if (sdfAt(lv, bx, by) > -50) {
        const ms = bruteMinSdf(lv, x, y, bx, by);
        const lc = lineClear(lv, x, y, bx, by, r);
        lcN++;
        if (lc && ms < r - 0.4) { lcFalsePos++; lcNear.push({ li, r, minSdf: +ms.toFixed(2) }); }
        if (!lc && ms >= r + 0.6 && Math.min(sdfAt(lv, x, y), sdfAt(lv, bx, by)) >= r) lcFalseNeg++;
      }
    }
  }
}
// synthetic grazing rays: start d px above a straight wall and shoot at a tiny angle theta towards it
const graz = {};
for (const th of [0.002, 0.005, 0.01, 0.02, 0.04, 0.08]) graz[th] = [];
let grazN = 0;
for (let li = 0; li < Math.min(LEVELS, 30); li++) {
  const lv = generateLevel('ray' + li, 1 + (li % 13));
  const rng = new RNG('grz' + li);
  let found = 0;
  for (let tries = 0; tries < 3000 && found < 12; tries++) {
    let x = rng.range(30, lv.width - 30), y = rng.range(30, lv.height - 30);
    if (sdfAt(lv, x, y) < 9) continue;
    gradAt(lv, x, y, gt);
    for (let i = 0; i < 60 && sdfAt(lv, x, y) > 7; i++) { x -= gt.x * 3; y -= gt.y * 3; gradAt(lv, x, y, gt); }
    const s0 = sdfAt(lv, x, y);
    if (s0 < 5 || s0 > 9) continue;
    const nx = gt.x, ny = gt.y, tx = -ny, ty = nx;
    // straight wall for 700px both ways? require the same normal at 80 px away
    gradAt(lv, x + tx * 80, y + ty * 80, gt); if (gt.x * nx + gt.y * ny < 0.995) continue;
    found++;
    for (const th of Object.keys(graz)) {
      const t = +th;
      const dx = tx * Math.cos(t) - nx * Math.sin(t), dy = ty * Math.cos(t) - ny * Math.sin(t);
      const b = brute(lv, x, y, dx, dy, 660), m = rayMarch(lv, x, y, dx, dy, 660);
      let ge = Math.abs(b - m);
      if (ge >= 2 && b < 660) { let dip = 1e9; for (let t2 = b - 1; t2 <= b + 2; t2 += 0.05) dip = Math.min(dip, sdfAt(lv, x + dx * t2, y + dy * t2)); if (dip >= 0.25) { grazeTangent++; ge = 0; } }
      graz[th].push(ge); grazN++;
    }
  }
}
console.log(`synthetic grazing rays (start ~7px off a straight wall, maxD 660): ${grazN} rays`);
for (const th of Object.keys(graz)) { const e = graz[th]; if (e.length) console.log(`  theta=${th}: n=${e.length} mean err ${mean(e).toFixed(1)}px  max ${Math.max(...e).toFixed(1)}px  >=2px: ${e.filter((v) => v >= 2).length}`); }
// timing
const reps = 3;
let t0 = performance.now();
let sink = 0;
for (let rep = 0; rep < reps; rep++) for (const c of cases) sink += rayMarch(c[0], c[1], c[2], c[3], c[4], c[5]);
tMarch = performance.now() - t0;
let sdfCalls = 0;
t0 = performance.now();
const probe = cases[0][0];
for (let i = 0; i < 2000000; i++) sink += sdfAt(probe, 100 + (i % 977), 100 + (i % 613));
const tSdf = performance.now() - t0;

console.log(`world=${WORLD} rays=${rays}  (open ${kinds.open.length}, near-wall ${kinds.near.length}, grazing ${kinds.graze.length})`);
for (const k of Object.keys(kinds)) {
  const e = kinds[k];
  console.log(`  ${k.padEnd(6)} err px: mean ${mean(e).toFixed(3)}  p95 ${pct(e, 0.95).toFixed(2)}  p99 ${pct(e, 0.99).toFixed(2)}  max ${Math.max(...e).toFixed(2)}   >=2px: ${e.filter((v) => v >= 2).length}`);
}
console.log(`  (${grazeTangent} rays brushed the surface within 0.25 px of the hit threshold and sailed past; counted as ok)`);
console.log(`  all    >=2px: ${big.length}  >=10px: ${errs.filter((v) => v >= 10).length}`);
if (big.length) console.log('  worst cases:', JSON.stringify(big.sort((a, b) => Math.abs(b.brute - b.march) - Math.abs(a.brute - a.march)).slice(0, 5)));
console.log(`  speed: ${(cases.length * reps / tMarch).toFixed(1)} rays/ms  (${(tMarch * 1000 / (cases.length * reps)).toFixed(2)} us/ray);  sdfAt ${(2000000 / tSdf / 1000).toFixed(1)} M/s`);
console.log(`lineClear vs brute force over ${lcN} segments: false positives (says clear but dips >=0.4px under r): ${lcFalsePos}   false negatives: ${lcFalseNeg}`);
if (lcNear.length) console.log('  e.g.', JSON.stringify(lcNear.slice(0, 4)));
if (process.argv.includes('--strict') && (big.length || lcFalsePos)) process.exit(1);
