// Fast regression gate for js/world.js (npm run test:world, ~15 s). Exits 1 on any failure.
// Deep versions of every check live in tools/worldgen-fuzz.mjs (7000+ levels), worldgen-physics.mjs, worldgen-ray.mjs,
// worldgen-nav.mjs, worldgen-quality.mjs and worldgen-browser.mjs.   Options: --seeds N (default 6)  --preview (ASCII level)
import { generateLevel, sdfAt, rayMarch, moveBody, lineClear, NavField, cellOf } from '../js/world.js';
import { RNG, TAU } from '../js/rng.js';
import { spawnTable, COARSE } from '../js/config.js';
import { fineFlood, inFlood } from './worldgen-lib.mjs';
import { asciiLevel } from './worldgen-preview.mjs';

const SEEDS = +(process.argv.includes('--seeds') ? process.argv[process.argv.indexOf('--seeds') + 1] : 6);
const NOM = { pearl: 8, buoy: 10, patch: 11, jelly: 15, urchin: 13, angler: 17, eel: 11, leviathan: 27 };
const KINDS = [['urchins', 'urchin'], ['anglers', 'angler'], ['eels', 'eel'], ['jellies', 'jelly'], ['pearls', 'pearl'], ['buoys', 'buoy'], ['patches', 'patch']];
const AVOID_START = { urchin: 180, angler: 300, eel: 380, jelly: 300, leviathan: 380 };
let fails = 0, levels = 0, maxMs = 0, attempts = 0;
const fail = (msg) => { fails++; if (fails <= 25) console.log('FAIL ' + msg); };

function hashLevel(lv) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < lv.sdf.length; i += 5) h = Math.imul(h ^ ((lv.sdf[i] * 16) | 0), 16777619) >>> 0;
  return h;
}

const t0 = performance.now();
for (let depth = 1; depth <= 14; depth++) {
  for (let s = 0; s < SEEDS; s++) {
    const tag = `d${depth}/s${s}`;
    let lv;
    const a = performance.now();
    try { lv = generateLevel('gate' + s, depth); } catch (e) { fail(`${tag} generation threw: ${e.message}`); continue; }
    maxMs = Math.max(maxMs, performance.now() - a); levels++; attempts += lv.attempt;
    if (s === 0 && hashLevel(generateLevel('gate' + s, depth)) !== hashLevel(lv)) fail(`${tag} not deterministic`);

    // start / exit
    if (sdfAt(lv, lv.start.x, lv.start.y) < 24) fail(`${tag} start tight`);
    if (sdfAt(lv, lv.exit.x, lv.exit.y) < 24) fail(`${tag} exit tight`);
    const ec = cellOf(lv, lv.exit.x, lv.exit.y);
    if (!(lv.startDist[ec] >= 0)) fail(`${tag} exit not reachable (nav S)`);
    if (lv.routeLength < 70) fail(`${tag} route too short (${lv.routeLength})`);
    const flood = fineFlood(lv, lv.start.x, lv.start.y, 9);
    if (!inFlood(lv, flood, lv.exit.x, lv.exit.y)) fail(`${tag} exit not reachable for the 9px player (fine field)`);

    // spawns
    const sp = lv.spawns, tbl = spawnTable(depth), haz = [], loot = [];
    for (const [key, type] of KINDS) {
      for (const p of sp[key]) {
        if (!isFinite(p.x + p.y)) { fail(`${tag} ${type} NaN`); continue; }
        if (sdfAt(lv, p.x, p.y) < NOM[type] + 4) fail(`${tag} ${type} too close to rock (${sdfAt(lv, p.x, p.y).toFixed(1)})`);
        if (!inFlood(lv, flood, p.x, p.y) && !(['urchin', 'angler', 'eel', 'jelly'].includes(type))) fail(`${tag} ${type} unreachable`);
        if (AVOID_START[type] && Math.hypot(p.x - lv.start.x, p.y - lv.start.y) < AVOID_START[type] - 0.5) fail(`${tag} ${type} too near the start`);
        (['urchin', 'angler', 'eel', 'jelly'].includes(type) ? haz : loot).push({ x: p.x, y: p.y, r: NOM[type], type });
      }
    }
    if (sp.leviathan) haz.push({ x: sp.leviathan.x, y: sp.leviathan.y, r: NOM.leviathan, type: 'leviathan' });
    if (depth >= 12 && !sp.leviathan) fail(`${tag} no leviathan`);
    if (depth < 12 && sp.leviathan) fail(`${tag} unexpected leviathan`);
    if (depth >= 12 && lv.xlCells.length < lv.reach * 0.3) fail(`${tag} leviathan sea too small (${lv.xlCells.length}/${lv.reach})`);
    for (let i = 0; i < haz.length; i++) for (let j = i + 1; j < haz.length; j++) if (Math.hypot(haz[i].x - haz[j].x, haz[i].y - haz[j].y) < haz[i].r + haz[j].r + 6) fail(`${tag} hazards overlap ${haz[i].type}/${haz[j].type}`);
    for (const l of loot) for (const h of haz) if (Math.hypot(l.x - h.x, l.y - h.y) < l.r + h.r + 12) { fail(`${tag} ${l.type} sits on a ${h.type}`); break; }
    for (const h of haz) if (h.type !== 'jelly' && Math.hypot(h.x - lv.exit.x, h.y - lv.exit.y) < h.r + 40) fail(`${tag} ${h.type} smothers the exit`);
    if (sp.patches.length < tbl.patches) fail(`${tag} missing repair patch`);
    if (sp.buoys.length < tbl.buoys) fail(`${tag} missing buoy`);
    // urchins must never wall off the exit (each blocks a 22 px disc for the player)
    if (sp.urchins.length) {
      const f = fineFlood(lv, lv.start.x, lv.start.y, 9, sp.urchins.map((p) => ({ x: p.x, y: p.y, r: 22 })));
      if (!inFlood(lv, f, lv.exit.x, lv.exit.y)) fail(`${tag} urchins block the exit`);
    }
    // flora and currents
    for (const fl of lv.flora) { const v = sdfAt(lv, fl.x, fl.y); if (v < -1.5 || v > 3.5) { fail(`${tag} flora off the wall (${v.toFixed(1)})`); break; } }
    for (const c of lv.currents) if (sdfAt(lv, c.x, c.y) < 50) fail(`${tag} current in a narrow spot`);

    // physics: a fast random body must never end up inside rock
    const rng = new RNG('gatefz' + s + depth);
    for (const r of [9, 15, 27]) {
      const e = { x: lv.start.x, y: lv.start.y, vx: 0, vy: 0 };
      for (let i = 0; i < 1500; i++) {
        if (i % 20 === 0) { const ang = rng.range(0, TAU), sp2 = rng.range(0, 520); e.vx = Math.cos(ang) * sp2; e.vy = Math.sin(ang) * sp2; }
        moveBody(lv, e, r, 1 / 60, 0.12);
        if (!isFinite(e.x + e.y) || sdfAt(lv, e.x, e.y) < r - 0.5) { fail(`${tag} body r=${r} inside rock at step ${i} (${sdfAt(lv, e.x, e.y).toFixed(2)})`); break; }
      }
    }
    // rayMarch vs brute force
    for (let k = 0; k < 40; k++) {
      let x, y;
      for (let tries = 0; tries < 100; tries++) { x = rng.range(30, lv.width - 30); y = rng.range(30, lv.height - 30); if (sdfAt(lv, x, y) > 9) break; }
      const ang = rng.range(0, TAU), dx = Math.cos(ang), dy = Math.sin(ang), maxD = 460;
      let truth = maxD;
      for (let t = 0; t <= maxD; t += 0.25) if (sdfAt(lv, x + dx * t, y + dy * t) < 0.6) { truth = t; break; }
      const m = rayMarch(lv, x, y, dx, dy, maxD);
      // a ray that merely brushes the surface (sdf dips under 0.6 px but stays above 0.25) may legitimately sail past: not an error
      let dip = 1e9;
      if (truth < maxD) for (let t = truth - 1; t <= truth + 2; t += 0.05) dip = Math.min(dip, sdfAt(lv, x + dx * t, y + dy * t));
      if (Math.abs(m - truth) >= 2 && dip < 0.25) { fail(`${tag} rayMarch off by ${(m - truth).toFixed(1)}px (from ${x.toFixed(1)},${y.toFixed(1)} angle ${ang.toFixed(4)} truth ${truth} march ${m.toFixed(1)})`); break; }
    }
    // navigation: an S-class agent follows the flow field from a random far cell to the exit
    {
      const nav = new NavField(lv);
      nav.compute(lv, 'S', lv.exit.x, lv.exit.y);
      const cells = [];
      for (let c = 0; c < lv.gw * lv.gh; c++) if (nav.dist[c] >= 12) cells.push(c);
      const c0 = cells[rng.int(0, cells.length - 1)];
      const e = { x: (c0 % lv.gw + 0.5) * COARSE, y: (((c0 / lv.gw) | 0) + 0.5) * COARSE, vx: 0, vy: 0 };
      const d = { x: 0, y: 0 };
      let ok = false;
      for (let i = 0; i < 60 * 80; i++) {
        if (Math.hypot(e.x - lv.exit.x, e.y - lv.exit.y) < 40) { ok = true; break; }
        if (nav.dir(lv, e.x, e.y, d)) { const f = 1 - Math.exp(-3.6 / 60); e.vx += (d.x * 150 - e.vx) * f; e.vy += (d.y * 150 - e.vy) * f; }
        moveBody(lv, e, 9.35, 1 / 60, 0.25);
      }
      if (!ok) fail(`${tag} nav agent never reached the exit`);
      if (!lineClear(lv, lv.start.x, lv.start.y, lv.start.x + 1, lv.start.y, 3)) fail(`${tag} lineClear broken at the start`);
    }
  }
}
console.log(`levels=${levels} fails=${fails} avgRetries=${(attempts / Math.max(1, levels)).toFixed(2)} maxGenMs=${maxMs.toFixed(0)} totalMs=${(performance.now() - t0).toFixed(0)}`);
if (process.argv.includes('--preview')) {
  const lv = generateLevel('preview', 6);
  console.log(asciiLevel(lv));
  console.log('route', lv.routeLength, 'reach', lv.reach, 'flora', lv.flora.length);
}
if (fails) { console.log('test-world: FAILED'); process.exit(1); }
console.log('test-world: ok');
