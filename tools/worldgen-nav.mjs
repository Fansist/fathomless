// Navigation robustness: agents of every nav class follow flowDir with real physics from random cells to random targets.
//   node tools/worldgen-nav.mjs [--levels 60] [--pairs 24] [--workers 6] [--strict]
//   WORLD=../js/world.baseline.js node tools/worldgen-nav.mjs
// Agent models mirror js/entities.js (eel/leviathan ease + serpentine wiggle, jelly pulse thrust, angler homing).
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { RNG } from '../js/rng.js';
import { COARSE } from '../js/config.js';
import { mean, pct } from './worldgen-lib.mjs';

const WORLD = process.env.WORLD || '../js/world.js';
const { generateLevel, sdfAt, moveBody, NavField, cellOf } = await import(WORLD);
const DT = 1 / 60;
const d = { x: 0, y: 0 };

// cls: nav class, r: collision radius used with moveBody, speed px/s, k: ease constant, wig: serpentine amplitude, pulse: jelly pulse
const MODELS = [
  { name: 'eel-patrol  S  r9.35', cls: 'S', r: 9.35, speed: 66, k: 3.6, wig: 0.22, wigRate: 4.5 * 1.6 },
  { name: 'eel-chase   S  r9.35', cls: 'S', r: 9.35, speed: 162, k: 3.6, wig: 0.22, wigRate: 9 * 1.6 },
  { name: 'jelly       L  r12.0', cls: 'L', r: 12, speed: 72, k: 2.6, pulse: 3.1, bounce: 0.35 },
  { name: 'angler      L  r15.3', cls: 'L', r: 15.3, speed: 62, k: 3, wig: 0, bounce: 0.1 },
  { name: 'leviathan   XL r22.95', cls: 'XL', r: 22.95, speed: 105, k: 1.7, wig: 0.22, wigRate: 4.5 * 1.6 },
  { name: 'leviathan-chase XL', cls: 'XL', r: 22.95, speed: 140, k: 1.7, wig: 0.22, wigRate: 9 * 1.6 },
];

function runAgent(lv, m, nav, sx, sy, tx, ty, budget, rng) {
  const e = { x: sx, y: sy, vx: 0, vy: 0 };
  let ph = rng.range(0, 6.28);
  const hist = [];
  let incr = 0, lastCell = -1, lastD = 1e9, maxOver = 0, penetr = 0;
  for (let i = 0; i < budget; i++) {
    ph += DT;
    const dd = Math.hypot(tx - e.x, ty - e.y);
    if (dd < 40) return { ok: true, steps: i, incr, penetr };
    let dx, dy;
    if (nav.dir(lv, e.x, e.y, d)) { dx = d.x; dy = d.y; } else { dx = (tx - e.x) / dd; dy = (ty - e.y) / dd; }
    let vtx, vty;
    if (m.pulse) {
      const thrust = m.speed * (0.28 + 1.0 * Math.max(0, Math.sin(ph * m.pulse)));
      vtx = dx * thrust; vty = dy * thrust;
    } else {
      const wig = m.wig ? Math.sin(ph * (m.wigRate || 7)) * m.wig : 0;
      vtx = (dx - dy * wig) * m.speed; vty = (dy + dx * wig) * m.speed;
    }
    const f = 1 - Math.exp(-m.k * DT);
    e.vx += (vtx - e.vx) * f; e.vy += (vty - e.vy) * f;
    moveBody(lv, e, m.r, DT, m.bounce === undefined ? 0.25 : m.bounce);
    if (sdfAt(lv, e.x, e.y) < m.r - 1) penetr++;
    const c = cellOf(lv, e.x, e.y);
    if (c !== lastCell) { lastCell = c; const sd = nav.dist[c]; if (sd >= 0 && sd > lastD) incr++; if (sd >= 0) lastD = sd; }
    if (i % 60 === 59) {
      hist.push([e.x, e.y]);
      // stuck: 4 s without moving 25 px while still far
      if (hist.length > 4) { const o = hist[hist.length - 5]; if (Math.hypot(e.x - o[0], e.y - o[1]) < 25 && dd > 60) return { ok: false, stuck: true, steps: i, x: e.x, y: e.y, incr, penetr }; }
    }
  }
  return { ok: false, steps: budget, x: e.x, y: e.y, incr, penetr };
}

function workerMain() {
  const { jobs, pairs } = workerData;
  const out = [];
  for (const job of jobs) {
    const lv = generateLevel('nav' + job.idx, job.depth);
    const rng = new RNG('navrng' + job.idx);
    const nav = new NavField(lv);
    const rec = { idx: job.idx, depth: job.depth, models: {}, fails: [] };
    for (const m of MODELS) {
      if (m.cls === 'XL' && !(lv.spawns.leviathan)) continue;
      const cells = [];
      for (let c = 0; c < lv.gw * lv.gh; c++) if (lv.nav[m.cls][c] && (m.cls !== 'XL' || lv.xlCells.includes(c))) cells.push(c);
      if (cells.length < 30) continue;
      const agg = { n: 0, ok: 0, stuck: 0, ratio: [], incr: 0, pen: 0 };
      for (let p = 0; p < pairs; p++) {
        const tc = cells[rng.int(0, cells.length - 1)];
        const tx = (tc % lv.gw + 0.5) * COARSE, ty = (((tc / lv.gw) | 0) + 0.5) * COARSE;
        if (!nav.compute(lv, m.cls, tx, ty)) continue;
        // start: random cell with BFS distance >= 10 steps
        let sc = -1;
        for (let t = 0; t < 60; t++) { const c = cells[rng.int(0, cells.length - 1)]; if (nav.dist[c] >= 10) { sc = c; break; } }
        if (sc < 0) continue;
        const sx = (sc % lv.gw + 0.5) * COARSE, sy = (((sc / lv.gw) | 0) + 0.5) * COARSE;
        const ideal = nav.dist[sc] * COARSE * 1.1 / m.speed * 60;
        const budget = Math.ceil(ideal * 2.2 + 420);
        const r = runAgent(lv, m, nav, sx, sy, tx, ty, budget, rng);
        agg.n++; if (r.ok) { agg.ok++; agg.ratio.push(r.steps / ideal); } else if (r.stuck) agg.stuck++;
        agg.incr += r.incr; agg.pen += r.penetr;
        if (!r.ok && rec.fails.length < 6) rec.fails.push({ model: m.name, depth: job.depth, seed: 'nav' + job.idx, from: [Math.round(sx), Math.round(sy)], to: [Math.round(tx), Math.round(ty)], at: [Math.round(r.x), Math.round(r.y)], stuck: !!r.stuck, steps: nav.dist[sc] });
      }
      rec.models[m.name] = agg;
    }
    out.push(rec);
  }
  parentPort.postMessage(out);
}

async function main() {
  const arg = (k, dflt) => { const i = process.argv.indexOf('--' + k); return i < 0 ? dflt : process.argv[i + 1]; };
  const levels = +arg('levels', 60), pairs = +arg('pairs', 24), nW = +arg('workers', 6);
  // depth mix: make sure depth 12+ (leviathan) is well represented
  const depths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 13];
  const jobs = Array.from({ length: levels }, (_, i) => ({ idx: i, depth: depths[i % depths.length] }));
  const shards = Array.from({ length: nW }, () => []);
  jobs.forEach((j, i) => shards[i % nW].push(j));
  const t0 = Date.now();
  const all = [];
  await Promise.all(shards.map((jb) => new Promise((res, rej) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { jobs: jb, pairs } });
    w.on('message', (m) => { all.push(...m); res(); });
    w.on('error', rej);
  })));
  console.log(`world=${WORLD} levels=${all.length} pairs/level/model=${pairs} wall=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('model                     runs   arrive%  stuck  time/ideal(med,p95)  cell-dist increases/run  penetration frames');
  let worst = 100;
  for (const m of MODELS) {
    const a = all.map((x) => x.models[m.name]).filter(Boolean);
    const n = a.reduce((s, v) => s + v.n, 0), ok = a.reduce((s, v) => s + v.ok, 0), st = a.reduce((s, v) => s + v.stuck, 0);
    const ratios = a.flatMap((v) => v.ratio);
    const pctOk = 100 * ok / Math.max(1, n);
    worst = Math.min(worst, pctOk);
    console.log(`${m.name.padEnd(24)} ${String(n).padStart(5)}   ${pctOk.toFixed(1).padStart(6)}  ${String(st).padStart(5)}   ${pct(ratios, 0.5).toFixed(2)} / ${pct(ratios, 0.95).toFixed(2)}          ${(a.reduce((s, v) => s + v.incr, 0) / Math.max(1, n)).toFixed(2)}                  ${a.reduce((s, v) => s + v.pen, 0)}`);
  }
  const fails = all.flatMap((x) => x.fails);
  if (fails.length) { console.log('\nsample failures:'); for (const f of fails.slice(0, 12)) console.log('  ' + JSON.stringify(f)); }
  // leviathan structure (depth >= 12)
  const lv12 = all.filter((x) => x.depth >= 12).length;
  console.log(`\n(depth>=12 levels simulated: ${lv12})`);
  if (process.argv.includes('--strict') && worst < 99) process.exit(1);
}

if (isMainThread) await main(); else workerMain();
