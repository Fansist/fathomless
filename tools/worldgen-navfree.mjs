// Navigation with ARBITRARY start/target points (the real game: a creature hears a ping anywhere the player can be, and may itself
// sit in a spot outside the coarse nav class after a lunge or a shove).   node tools/worldgen-navfree.mjs [--levels 120] [--pairs 30]
// Success = within 44 px of the target.  Targets/starts are any water the 9 px player can use, connected to the start (fine flood).
import { RNG } from '../js/rng.js';
import { COARSE } from '../js/config.js';
import { fineFlood } from './worldgen-lib.mjs';
const WORLD = process.env.WORLD || '../js/world.js';
const { generateLevel, sdfAt, moveBody, NavField, cellOf } = await import(WORLD);
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const LEVELS = +arg('levels', 120), PAIRS = +arg('pairs', 30);
const DT = 1 / 60, d = { x: 0, y: 0 };
const MODELS = [
  { name: 'eel S r9.35', cls: 'S', r: 9.35, speed: 138, k: 3.6, wig: 0.22, wigRate: 7.2, minSdf: 10 },
  { name: 'jelly L r12', cls: 'L', r: 12, speed: 72, k: 2.6, pulse: 3.1, bounce: 0.35, minSdf: 13 },
  { name: 'leviathan XL r23', cls: 'XL', r: 22.95, speed: 105, k: 1.7, wig: 0.22, wigRate: 7.2, minSdf: 24 },
];
const tally = {};
const conn = {}; // pairs where the start cell has a finite flow-field distance to the target (same nav component)
for (const m of MODELS) tally[m.name] = { n: 0, ok: 0, navTarget: 0, navTargetOk: 0, off: 0, offOk: 0, fails: [], cn: 0, cok: 0, dn: 0, dok: 0, sn: 0, sok: 0 };
for (let li = 0; li < LEVELS; li++) {
  const depth = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 13][li % 14];
  const lv = generateLevel('nf' + li, depth);
  const rng = new RNG('nfrng' + li);
  const seen = fineFlood(lv, lv.start.x, lv.start.y, 9.5);
  const W = lv.W;
  const pts = [];
  for (let i = 0; i < lv.W * lv.H; i++) if (seen[i] && lv.sdf[i] >= 10.5) pts.push(i);
  const nav = new NavField(lv);
  for (const m of MODELS) {
    if (m.cls === 'XL' && !lv.spawns.leviathan) continue;
    const okPts = pts.filter((i) => lv.sdf[i] >= m.minSdf + 0.5);
    // the leviathan lives in its own sea: restrict to the XL patch around its spawn
    let pool = okPts;
    if (m.cls === 'XL') { const set = new Set(lv.xlCells); pool = okPts.filter((i) => set.has(cellOf(lv, ((i % W) + 0.5) * 8, (((i / W) | 0) + 0.5) * 8))); }
    if (pool.length < 50) continue;
    const T = tally[m.name];
    for (let p = 0; p < PAIRS; p++) {
      const a = pool[rng.int(0, pool.length - 1)], b = pool[rng.int(0, pool.length - 1)];
      const sx = ((a % W) + 0.5) * 8, sy = (((a / W) | 0) + 0.5) * 8, tx = ((b % W) + 0.5) * 8, ty = (((b / W) | 0) + 0.5) * 8;
      const straight = Math.hypot(tx - sx, ty - sy);
      if (straight < 120) continue;
      const tNav = lv.nav[m.cls][cellOf(lv, tx, ty)] === 1, sNav = lv.nav[m.cls][cellOf(lv, sx, sy)] === 1;
      nav.compute(lv, m.cls, tx, ty);
      const e = { x: sx, y: sy, vx: 0, vy: 0 };
      let ph = rng.range(0, 6.28), ok = false, steps = 0;
      // time allowance: twice the flow-field path length at the creature's real average speed (jellies pulse: ~0.6 of nominal), plus 12 s
      const stepsToGo = nav.valid ? nav.dist[cellOf(lv, sx, sy)] : -1;
      const pathPx = stepsToGo >= 0 ? stepsToGo * COARSE * 1.15 : straight * 2.5;
      const budget = Math.ceil((pathPx * 2 / (m.speed * (m.pulse ? 0.6 : 0.8)) + 12) * 60);
      for (; steps < budget; steps++) {
        ph += DT;
        const dd = Math.hypot(tx - e.x, ty - e.y);
        if (dd < 44) { ok = true; break; }
        let dx, dy;
        if (nav.dir(lv, e.x, e.y, d)) { dx = d.x; dy = d.y; } else { dx = (tx - e.x) / dd; dy = (ty - e.y) / dd; }
        let vtx, vty;
        if (m.pulse) { const th = m.speed * (0.28 + Math.max(0, Math.sin(ph * m.pulse))); vtx = dx * th; vty = dy * th; }
        else { const w = Math.sin(ph * m.wigRate) * m.wig; vtx = (dx - dy * w) * m.speed; vty = (dy + dx * w) * m.speed; }
        const f = 1 - Math.exp(-m.k * DT);
        e.vx += (vtx - e.vx) * f; e.vy += (vty - e.vy) * f;
        moveBody(lv, e, m.r, DT, m.bounce === undefined ? 0.25 : m.bounce);
      }
      T.n++; if (ok) T.ok++;
      const connected = nav.valid && nav.dist[cellOf(lv, sx, sy)] >= 0 || (nav.valid && (() => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const c = cellOf(lv, sx + dx * COARSE, sy + dy * COARSE); if (nav.dist[c] >= 0) return true; } return false; })());
      if (connected && tNav && sNav) { T.sn++; if (ok) T.sok++; }
      if (connected) { T.cn++; if (ok) T.cok++; } else { T.dn++; if (ok) T.dok++; }
      if (tNav && sNav) { T.navTarget++; if (ok) T.navTargetOk++; } else { T.off++; if (ok) T.offOk++; }
      if (!ok && connected && T.fails.length < 5) T.fails.push({ depth, seed: 'nf' + li, from: [Math.round(sx), Math.round(sy)], to: [Math.round(tx), Math.round(ty)], end: [Math.round(e.x), Math.round(e.y)], startInNav: sNav, targetInNav: tNav });
    }
  }
}
console.log(`world=${WORLD} levels=${LEVELS} pairs=${PAIRS}`);
console.log('model              runs   arrive%   | start connected to target by the flow field: n ok%   | not connected (other nav component / squeeze): n ok% | strict: both ends on nav cells and connected: n ok%');
for (const m of MODELS) {
  const T = tally[m.name];
  console.log(`${m.name.padEnd(18)} ${String(T.n).padStart(5)}   ${(100 * T.ok / Math.max(1, T.n)).toFixed(1).padStart(6)}%   | ${String(T.cn).padStart(5)} ${(100 * T.cok / Math.max(1, T.cn)).toFixed(1).padStart(6)}%      | ${String(T.dn).padStart(5)} ${(100 * T.dok / Math.max(1, T.dn)).toFixed(1).padStart(6)}%   | ${String(T.sn).padStart(5)} ${(100 * T.sok / Math.max(1, T.sn)).toFixed(2).padStart(6)}%`);
}
for (const m of MODELS) for (const f of tally[m.name].fails) console.log('  fail', m.name, JSON.stringify(f));
