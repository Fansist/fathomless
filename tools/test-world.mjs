import { generateLevel, sdfAt, rayMarch, moveBody, lineClear } from '../js/world.js';
import { RNG } from '../js/rng.js';

const t0 = performance.now();
let fails = 0, maxMs = 0, total = 0, attempts = 0;
for (let depth = 1; depth <= 14; depth++) {
  for (let s = 0; s < 12; s++) {
    const a = performance.now();
    let lv;
    try { lv = generateLevel('seed' + s, depth); } catch (e) { console.log('FAIL gen', depth, s, e.message); fails++; continue; }
    const ms = performance.now() - a; maxMs = Math.max(maxMs, ms); total++; attempts += lv.attempt;
    // spawns not in walls
    const all = [];
    for (const k of ['urchins','anglers','eels','jellies','pearls','buoys','patches']) for (const p of lv.spawns[k]) all.push([k,p]);
    for (const [k,p] of all) if (sdfAt(lv,p.x,p.y) < 10) { console.log('BAD spawn in wall', k, depth, s, sdfAt(lv,p.x,p.y)); fails++; }
    if (depth >= 12 && !lv.spawns.leviathan) { console.log('no leviathan', depth, s); fails++; }
    if (sdfAt(lv, lv.start.x, lv.start.y) < 24) { console.log('start tight', depth, s, sdfAt(lv, lv.start.x, lv.start.y)); fails++; }
    // collision fuzz
    const rng = new RNG('fz' + s + depth);
    const e = { x: lv.start.x, y: lv.start.y, vx: 0, vy: 0 };
    for (let i = 0; i < 4000; i++) {
      if (i % 40 === 0) { const a2 = rng.range(0, 6.283); e.vx = Math.cos(a2) * rng.range(50, 400); e.vy = Math.sin(a2) * rng.range(50, 400); }
      moveBody(lv, e, 9, 1/60);
      if (sdfAt(lv, e.x, e.y) < 8.5 || !isFinite(e.x)) { console.log('INSIDE WALL', depth, s, i, sdfAt(lv,e.x,e.y)); fails++; break; }
    }
  }
}
console.log(`levels=${total} fails=${fails} avgAttempt=${(attempts/total).toFixed(2)} maxGenMs=${maxMs.toFixed(0)} totalMs=${(performance.now()-t0).toFixed(0)}`);

// ascii preview
const lv = generateLevel('preview', 6);
const step = 6;
let out = '';
for (let y = 0; y < lv.height; y += step * 2) {
  let row = '';
  for (let x = 0; x < lv.width; x += step) {
    const s = sdfAt(lv, x, y);
    let ch = s < 0 ? '#' : s < 14 ? '+' : s < 30 ? '.' : ' ';
    row += ch;
  }
  out += row + '\n';
}
console.log(out);
console.log('route', lv.routeLength, 'reach', lv.reach, 'flora', lv.flora.length, 'spawns', Object.fromEntries(Object.entries(lv.spawns).map(([k,v])=>[k, Array.isArray(v)?v.length:!!v])));
