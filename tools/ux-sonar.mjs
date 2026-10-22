// UX lens: sonar.js correctness + cost (node, DOM-free).  Usage: node tools/ux-sonar.mjs
import { generateLevel, rayMarch, sdfAt, lineClear } from '../js/world.js';
import { createPing, updatePing, HK } from '../js/sonar.js';
import { PING } from '../js/config.js';
import { makeEnemy } from '../js/entities.js';
let fails = 0, total = 0;
const check = (name, ok, info) => {
  total++;
  if (!ok) { fails++; console.log('  FAIL  ' + name + (info !== undefined ? '  -> ' + JSON.stringify(info) : '')); }
  else console.log('  ok    ' + name);
};
const lv = generateLevel('sonar-ux', 6);
const free = (x, y) => sdfAt(lv, x, y) > 30;
// find an open spot with a long free ray east
let ox = lv.start.x, oy = lv.start.y;
const dirFree = (x, y, a, d) => rayMarch(lv, x, y, Math.cos(a), Math.sin(a), d) >= d - 0.5;
console.log('== A. ray vs circle');
{
  let bad = 0, hits = 0, misses = 0, wallHits = 0, checked = 0;
  for (let trial = 0; trial < 40; trial++) {
    const a = trial * 0.157;
    let d = 0; const free0 = rayMarch(lv, ox, oy, Math.cos(a), Math.sin(a), 400);
    if (free0 < 150) continue;
    const dist = Math.min(free0 - 40, 60 + (trial % 5) * 40), r = 9 + (trial % 4) * 5;
    const tx = ox + Math.cos(a) * dist, ty = oy + Math.sin(a) * dist;
    const ref = { trial };
    const p = createPing(lv, ox, oy, 1, { targets: [{ kind: HK.THREAT, x: tx, y: ty, r, ref }], offset: 0 });
    checked++;
    // expected angular half width
    const half = Math.asin(Math.min(1, r / dist));
    let nHit = 0;
    for (let i = 0; i < p.n; i++) {
      const ang = Math.atan2(p.sinA[i], p.cosA[i]);
      let da = Math.atan2(Math.sin(ang - a), Math.cos(ang - a));
      if (p.hk[i] === HK.THREAT) {
        nHit++;
        const dd = Math.hypot(p.hx[i] - tx, p.hy[i] - ty);
        if (Math.abs(dd - r) > 0.6) bad++;                                   // hit point lies on the circle
        if (Math.abs(Math.hypot(p.hx[i] - ox, p.hy[i] - oy) - p.hd[i]) > 0.6) bad++;
        const fd = rayMarch(lv, ox, oy, p.cosA[i], p.sinA[i], p.hd[i]);       // nothing solid before the hit
        if (fd < p.hd[i] - 1) wallHits++;
      } else if (Math.abs(da) < half * 0.9 && p.hk[i] !== HK.THREAT) misses++;   // a ray clearly inside the cone that did not hit
    }
    const expect = (2 * half) / (Math.PI * 2 / p.n);
    if (Math.abs(nHit - expect) > 3) bad++;
    hits += nHit;
  }
  check(`threat hits sit on the circle edge, have clear line of sight, and match the angular size (${checked} circles, ${hits} hits)`, bad === 0 && wallHits === 0 && misses === 0, { bad, wallHits, misses });
}
console.log('== B. marks: once per entity per ping, never through walls');
{
  // an entity behind rock: find a spot with sdf<0 between
  let behind = null;
  for (let k = 0; k < 4000 && !behind; k++) {
    const ang = (k * 2.399963) % 6.2832, d = 90 + (k * 37) % 230;
    const x = ox + Math.cos(ang) * d, y = oy + Math.sin(ang) * d;
    if (x > 0 && y > 0 && x < lv.width && y < lv.height && sdfAt(lv, x, y) > 25 && !lineClear(lv, ox, oy, x, y, 2)) behind = { x, y };
  }
  const visible = (() => { for (let a = 0; a < 6.28; a += 0.1) { const d = Math.min(120, rayMarch(lv, ox, oy, Math.cos(a), Math.sin(a), 200) - 30); if (d > 60) return { x: ox + Math.cos(a) * d, y: oy + Math.sin(a) * d }; } return null; })();
  check('test geometry found (visible spot + spot behind rock)', !!visible && !!behind, { visible, behind });
  const eel = makeEnemy('eel', { x: visible.x, y: visible.y }, 6);
  const wall = { snapshot: 0 };
  const hidden = makeEnemy('jelly', { x: behind.x, y: behind.y }, 6);
  const targets = [];
  for (const e of [eel, hidden]) for (const c of e.circles()) targets.push({ kind: HK.THREAT, x: c.x, y: c.y, r: c.r, ref: e });
  const p = createPing(lv, ox, oy, 1, { targets, rangeMult: 1.6 });
  const refs = p.marks.map((m) => m.ref);
  check('one mark for the 3-circle eel (closest circle wins)', refs.filter((r) => r === eel).length === 1, p.marks.length);
  check('no mark for the creature behind rock', !refs.includes(hidden), p.marks.map((m) => m.kind));
  // drive the wave: snapshot fires exactly once even over a long life, and ghosts record the position at arrival time
  let snaps = 0; const origSnap = eel.snapshot.bind(eel); eel.snapshot = (t) => { snaps++; origSnap(t); };
  for (let i = 0; i < 600; i++) { updatePing(p, 1 / 60); for (const m of p.marks) if (!m.done && p.r >= m.d) { m.done = true; m.ref.snapshot(i); } if (p.dead) break; }
  check('snapshot fires exactly once per ping', snaps === 1, snaps);
  check('the ping dies after its life', p.dead === true, p.age);
  // two pings -> two snapshots
  snaps = 0;
  for (let k = 0; k < 2; k++) { const q = createPing(lv, ox, oy, 0.6, { targets, rangeMult: 1 }); for (let i = 0; i < 600 && !q.dead; i++) { updatePing(q, 1 / 60); for (const m of q.marks) if (!m.done && q.r >= m.d) { m.done = true; m.ref.snapshot(i); } } }
  check('each ping marks the creature once (2 pings -> 2 snapshots)', snaps === 2, snaps);
  // out of range: no mark
  const far = makeEnemy('urchin', { x: visible.x, y: visible.y }, 6);
  const q = createPing(lv, ox - 0, oy, 0, { targets: [{ kind: HK.THREAT, x: ox + 2000, y: oy, r: 13, ref: far }] });
  check('target beyond the ping radius gets no mark', q.marks.length === 0);
}
console.log('== C. echoes list');
{
  let ok = true, worst = null;
  for (let t = 0; t < 30; t++) {
    const pw = (t % 6) / 5;
    const p = createPing(lv, ox + (t % 5) * 6, oy + (t % 3) * 6, pw, {});
    const e = p.echoes;
    const sorted = e.every((x, i) => i === 0 || e[i - 1].gain >= x.gain);
    if (!(e.length <= 14 && sorted && e.every((x) => x.t >= 0 && x.gain > 0 && x.gain <= 1.0001 && Math.abs(x.pan) <= 1.0001 && Number.isFinite(x.t + x.gain + x.pan)))) { ok = false; worst = e.slice(0, 3); }
  }
  check('echoes: <= 14, sorted by gain, t >= 0, 0 < gain <= 1, |pan| <= 1', ok, worst);
}
console.log('== D. cost');
{
  const lv12 = generateLevel('sonar-cost', 12);
  const targets = [];
  const cx = lv12.start.x, cy = lv12.start.y;
  // worst case: every creature, pearl and buoy circle in range
  for (let i = 0; i < 60; i++) targets.push({ kind: i % 3 === 0 ? HK.THREAT : HK.PEARL, x: cx + Math.cos(i) * (40 + i * 6), y: cy + Math.sin(i) * (40 + i * 6), r: 10, ref: { i } });
  for (const [name, o] of [['max power, 60 targets', { targets, rangeMult: 1.6 }], ['max power, no targets', { rangeMult: 1.6 }], ['half power', { targets, rangeMult: 1 }]]) {
    const pw = name.startsWith('half') ? 0.5 : 1;
    for (let i = 0; i < 30; i++) createPing(lv12, cx, cy, pw, o);   // warm
    const ts = [];
    for (let i = 0; i < 200; i++) { const t0 = performance.now(); createPing(lv12, cx + (i % 7) * 3, cy + (i % 5) * 3, pw, o); ts.push(performance.now() - t0); }
    ts.sort((a, b) => a - b);
    console.log(`   ${name}: median ${ts[100].toFixed(2)} ms, p95 ${ts[190].toFixed(2)} ms, max ${ts[199].toFixed(2)} ms`);
    if (name.startsWith('max power, 60')) check('createPing at max power (60 targets, 1.6x range): median < 4 ms', ts[100] < 4, ts[100]);
  }
}
console.log(`\n${total - fails}/${total} checks passed`);
process.exit(fails ? 1 : 0);
