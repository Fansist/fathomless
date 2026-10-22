// Physics robustness suite for moveBody / resolveCircle (Node, multi-threaded).
//   node tools/worldgen-physics.mjs [--levels 100] [--steps 20000] [--workers 6] [--strict]
//   WORLD=../js/world.baseline.js node tools/worldgen-physics.mjs   (compare against another copy of world.js)
// Sections: A) random stress (all radii, speeds up to 520, knockbacks, currents)  B) sticky corners
//           C) wall-slide smoothness (jitter)  D) currents shoving a body into a wall.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { RNG, TAU } from '../js/rng.js';
import { PLAYER } from '../js/config.js';
import { mean, pct } from './worldgen-lib.mjs';

const WORLD = process.env.WORLD || '../js/world.js';
const { generateLevel, sdfAt, gradAt, moveBody } = await import(WORLD);
const RADII = [9, 11, 15, 17, 27];
const DT = 1 / 60;
const g = { x: 0, y: 0 };

// pick start points of a few flavours for radius r
function pickPoints(lv, r, rng, n) {
  const W = lv.W, H = lv.H, out = { free: [], wall: [], pocket: [] };
  for (let tries = 0; tries < 40000 && (out.free.length < n || out.wall.length < n || out.pocket.length < n); tries++) {
    const x = rng.range(40, lv.width - 40), y = rng.range(40, lv.height - 40);
    const s = sdfAt(lv, x, y);
    if (s < r) continue;
    if (out.free.length < n) out.free.push({ x, y });
    if (s < r + 1.5 && out.wall.length < n) out.wall.push({ x, y });
    if (s < r + 4 && out.pocket.length < n) {
      let blocked = 0;
      for (let k = 0; k < 16; k++) { const a = (k / 16) * TAU; if (sdfAt(lv, x + Math.cos(a) * (r + 5), y + Math.sin(a) * (r + 5)) < r) blocked++; }
      if (blocked >= 6) out.pocket.push({ x, y });
    }
  }
  return out;
}

// largest open neighbourhood sdf (can a body of radius r sit anywhere near here?)
function bestNearby(lv, x, y) {
  let best = sdfAt(lv, x, y);
  for (let rr = 4; rr <= 24; rr += 4) for (let k = 0; k < 12; k++) { const a = (k / 12) * TAU; best = Math.max(best, sdfAt(lv, x + Math.cos(a) * rr, y + Math.sin(a) * rr)); }
  return best;
}

function stressBody(lv, r, start, steps, rng, mode) {
  const e = { x: start.x, y: start.y, vx: 0, vy: 0 };
  const res = { n: 0, viol: 0, hardViol: 0, maxPen: 0, nan: 0, oob: 0, pops: 0, maxPop: 0, contacts: 0, steps };
  let tvx = 0, tvy = 0, k = 5;
  let px = e.x, py = e.y;
  for (let i = 0; i < steps; i++) {
    // random velocity changes every frame (as asked) + occasional knockbacks and dash-like bursts
    if (mode === 'chaos') {
      const a = rng.range(0, TAU), sp = rng.next() < 0.1 ? rng.range(300, 520) : rng.range(0, 260);
      e.vx = Math.cos(a) * sp; e.vy = Math.sin(a) * sp;
    } else {
      if (i % 30 === 0) { const a = rng.range(0, TAU), sp = rng.range(0, PLAYER.maxSpeed); tvx = Math.cos(a) * sp; tvy = Math.sin(a) * sp; k = rng.chance(0.5) ? PLAYER.accelK : PLAYER.dragK; }
      const f = 1 - Math.exp(-k * DT);
      e.vx += (tvx - e.vx) * f; e.vy += (tvy - e.vy) * f;
      if (rng.next() < 0.012) { const a = rng.range(0, TAU), sp = rng.range(150, 520); e.vx += Math.cos(a) * sp; e.vy += Math.sin(a) * sp; } // knockback / dash
      if (mode === 'wallpush' && i % 5 === 0) { gradAt(lv, e.x, e.y, g); e.vx -= g.x * 70; e.vy -= g.y * 70; } // current shoving into rock
    }
    const bounce = rng.chance(0.5) ? 0.12 : rng.chance(0.5) ? 0.35 : 0;
    if (moveBody(lv, e, r, DT, bounce)) res.contacts++;
    res.n++;
    if (!isFinite(e.x) || !isFinite(e.y) || !isFinite(e.vx) || !isFinite(e.vy)) { res.nan++; break; }
    if (e.x < 0 || e.y < 0 || e.x > lv.width || e.y > lv.height) { res.oob++; break; }
    const s = sdfAt(lv, e.x, e.y);
    const pen = r - s;
    if (pen > 0.5) {
      res.viol++;
      if (pen > res.maxPen) res.maxPen = pen;
      // genuinely unresolvable (no spot within 24 px where the body would fit) is not a physics bug, count apart
      if (bestNearby(lv, e.x, e.y) >= r) res.hardViol++;
    }
    const d = Math.hypot(e.x - px, e.y - py);
    const sp = Math.hypot(e.vx, e.vy);
    const expect = sp * DT + 2;
    if (d > expect + 10) { res.pops++; if (d - expect > res.maxPop) res.maxPop = d - expect; }
    px = e.x; py = e.y;
  }
  return res;
}

// Section B: sticky corners. Jam the body into a pocket, find the way out from where it ended up, then thrust out
// (straight and +-30 degrees off, like a human would); the body must leave: >= 15 px of progress along the exit direction in 1.2 s (a full-speed run makes ~170).
function bestExit(lv, x, y, r) {
  let bestA = 0, bestRun = -1;
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * TAU;
    let run = 0;
    // the way out needs real slack: a gap of exactly 2r is not an exit
    for (let t = 4; t <= 120; t += 4) { if (sdfAt(lv, x + Math.cos(a) * t, y + Math.sin(a) * t) < r + 0.5) break; run = t; }
    if (run > bestRun) { bestRun = run; bestA = a; }
  }
  return { a: bestA, run: bestRun };
}
function stickyTest(lv, r, rng, count) {
  const pts = pickPoints(lv, r, rng, count).pocket;
  const out = { tried: 0, stuck: 0, worst: 1e9, cases: [], straight: [], tried0: 0, stuck0: 0 };
  const f = 1 - Math.exp(-PLAYER.accelK * DT);
  for (const p of pts) {
    const ex0 = bestExit(lv, p.x, p.y, r);
    if (ex0.run < 90) continue;
    for (const off of [0, 0.52, -0.52]) {
      const e = { x: p.x, y: p.y, vx: 0, vy: 0 };
      // 0.5 s pressing the opposite way (into the corner)
      for (let i = 0; i < 30; i++) { e.vx += (-Math.cos(ex0.a) * PLAYER.maxSpeed - e.vx) * f; e.vy += (-Math.sin(ex0.a) * PLAYER.maxSpeed - e.vy) * f; moveBody(lv, e, r, DT, 0.12); }
      const x0 = e.x, y0 = e.y;
      const ex = bestExit(lv, x0, y0, r);
      if (ex.run < 90) continue;
      const ux = Math.cos(ex.a), uy = Math.sin(ex.a), tx = Math.cos(ex.a + off), ty = Math.sin(ex.a + off);
      for (let i = 0; i < 72; i++) { e.vx += (tx * PLAYER.maxSpeed - e.vx) * f; e.vy += (ty * PLAYER.maxSpeed - e.vy) * f; moveBody(lv, e, r, DT, 0.12); }
      const prog = (e.x - x0) * ux + (e.y - y0) * uy;
      out.tried++; if (off === 0) out.tried0++;
      out.worst = Math.min(out.worst, prog);
      if (prog < 15) { out.stuck++; if (off === 0) { out.stuck0++; if (out.straight.length < 3) out.straight.push({ r, start: [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100], afterPress: [x0, y0], exitDir: ex.a, run: ex.run, end: [e.x, e.y], prog: +prog.toFixed(1) }); } if (out.cases.length < 3) out.cases.push({ r, off, start: [Math.round(p.x), Math.round(p.y)], afterPress: [Math.round(x0), Math.round(y0)], sdfAfterPress: +sdfAt(lv, x0, y0).toFixed(2), exitDir: +ex.a.toFixed(2), run: ex.run, end: [Math.round(e.x), Math.round(e.y)], sdfEnd: +sdfAt(lv, e.x, e.y).toFixed(2), prog: +prog.toFixed(1) }); }
    }
  }
  return out;
}

// Section C: slide along a straight wall while pushing 35 degrees into it. A smooth slide hugs the wall (contact offset ~0),
// keeps a steady heading (no frame-to-frame zig-zag) and a steady speed.
function slideTest(lv, r, rng, count) {
  const pts = pickPoints(lv, r, rng, count * 3).wall;
  const res = { n: 0, contact: [], cstd: [], noise: [], spikes: 0, frames: 0, stalls: 0, cv: [], px: [] };
  for (const p of pts) {
    if (res.n >= count) break;
    gradAt(lv, p.x, p.y, g);
    const nx = g.x, ny = g.y, tx = -ny, ty = nx;
    // straight stretch: wall normals 90 px away (both ways) agree with the local one
    gradAt(lv, p.x + tx * 90, p.y + ty * 90, g); const d1 = g.x * nx + g.y * ny;
    gradAt(lv, p.x - tx * 90, p.y - ty * 90, g); const d2 = g.x * nx + g.y * ny;
    if (d1 < 0.985 || d2 < 0.985) continue;
    // start 70 px "behind" so the body has reached steady sliding by the time it is on the straight part
    const e = { x: p.x - tx * 70, y: p.y - ty * 70, vx: 0, vy: 0 };
    if (sdfAt(lv, e.x, e.y) < r) continue;
    const ang = 35 * Math.PI / 180;
    const dirx = tx * Math.cos(ang) - nx * Math.sin(ang), diry = ty * Math.cos(ang) - ny * Math.sin(ang);
    const f = 1 - Math.exp(-PLAYER.accelK * DT);
    const hd = [], sp = [], off = [], pos = [];
    for (let i = 0; i < 70; i++) {
      e.vx += (dirx * PLAYER.maxSpeed - e.vx) * f; e.vy += (diry * PLAYER.maxSpeed - e.vy) * f;
      const x0 = e.x, y0 = e.y;
      moveBody(lv, e, r, DT, 0.12);
      if (i >= 25) { pos.push([e.x, e.y]); const dx = e.x - x0, dy = e.y - y0; hd.push(Math.atan2(dy, dx)); sp.push(Math.hypot(dx, dy)); off.push(sdfAt(lv, e.x, e.y) - r); }
    }
    const mm = mean(sp);
    if (mm < 0.4) { res.stalls++; res.n++; continue; }
    res.n++;
    const inC = off.filter((o) => o < 1.0);
    res.contact.push(inC.length / off.length);
    if (inC.length > 5) { const mo = mean(inC); res.cstd.push(Math.sqrt(mean(inC.map((o) => (o - mo) ** 2)))); }
    // heading noise: deviation from the mean of the neighbours (+-2 frames), degrees
    let sq = 0, cnt = 0;
    for (let i = 2; i < hd.length - 2; i++) {
      const nb = (hd[i - 2] + hd[i - 1] + hd[i + 1] + hd[i + 2]) / 4;
      let dlt = hd[i] - nb; if (dlt > Math.PI) dlt -= TAU; if (dlt < -Math.PI) dlt += TAU;
      const dd = Math.abs(dlt) * 180 / Math.PI;
      sq += dd * dd; cnt++; res.frames++; if (dd > 8) res.spikes++;
    }
    for (let i = 1; i < pos.length - 1; i++) res.px.push(Math.hypot(pos[i][0] - (pos[i - 1][0] + pos[i + 1][0]) / 2, pos[i][1] - (pos[i - 1][1] + pos[i + 1][1]) / 2)); // px off the straight line through the neighbours
    res.noise.push(Math.sqrt(sq / Math.max(1, cnt)));
    res.cv.push(Math.sqrt(mean(sp.map((v) => (v - mm) ** 2))) / mm);
  }
  return res;
}

function workerMain() {
  const { jobs, steps } = workerData;
  const out = [];
  for (const job of jobs) {
    const { idx, depth } = job;
    const seed = 'phys' + idx;
    const lv = generateLevel(seed, depth);
    const rng = new RNG('physrng' + idx);
    const rec = { idx, depth, seed, stress: {}, sticky: {}, slide: {} };
    for (const r of RADII) {
      const pts = pickPoints(lv, r, rng, 4);
      const starts = [...pts.free.slice(0, 2), ...pts.wall.slice(0, 1), ...pts.pocket.slice(0, 1)];
      if (!starts.length) starts.push({ x: lv.start.x, y: lv.start.y });
      const agg = { n: 0, viol: 0, hardViol: 0, maxPen: 0, nan: 0, oob: 0, pops: 0, maxPop: 0, contacts: 0 };
      let si = 0;
      for (const st of starts) {
        const mode = ['normal', 'chaos', 'wallpush', 'normal'][si++ % 4];
        const rs = stressBody(lv, r, st, Math.floor(steps / starts.length), rng, mode);
        for (const k of Object.keys(agg)) agg[k] = k.startsWith('max') ? Math.max(agg[k], rs[k]) : agg[k] + rs[k];
      }
      rec.stress[r] = agg;
      rec.sticky[r] = stickyTest(lv, r, rng, 10);
      const sl = slideTest(lv, r, rng, 6);
      rec.slide[r] = { n: sl.n, contact: sl.contact, cstd: sl.cstd, noise: sl.noise, spikes: sl.spikes, frames: sl.frames, stalls: sl.stalls, cv: sl.cv, px: sl.px };
    }
    out.push(rec);
  }
  parentPort.postMessage(out);
}

async function main() {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
  const levels = +arg('levels', 100), steps = +arg('steps', 20000), nW = +arg('workers', 6);
  const jobs = Array.from({ length: levels }, (_, i) => ({ idx: i, depth: 1 + (i % 13) }));
  const shards = Array.from({ length: nW }, () => []);
  jobs.forEach((j, i) => shards[i % nW].push(j));
  const t0 = Date.now();
  const all = [];
  await Promise.all(shards.map((jb) => new Promise((res, rej) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { jobs: jb, steps } });
    w.on('message', (m) => { all.push(...m); res(); });
    w.on('error', rej);
  })));
  console.log(`world=${WORLD} levels=${all.length} stepsPerBodyLevel=${steps} wall=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  let bad = 0;
  console.log('\nA) stress (total steps, steps with pen>0.5px, of which resolvable, max penetration px, NaN, out-of-map, pops>10px, max pop)');
  for (const r of RADII) {
    const a = all.map((x) => x.stress[r]);
    const sum = (k) => a.reduce((s, v) => s + v[k], 0);
    const mx = (k) => Math.max(...a.map((v) => v[k]));
    console.log(`  r=${String(r).padStart(2)} steps=${sum('n')} wall-contact-steps=${sum('contacts')} viol=${sum('viol')} resolvable=${sum('hardViol')} maxPen=${mx('maxPen').toFixed(2)} nan=${sum('nan')} oob=${sum('oob')} pops=${sum('pops')} maxPop=${mx('maxPop').toFixed(1)}`);
    bad += sum('hardViol') + sum('nan') + sum('oob');
  }
  console.log('\nB) sticky corners (pockets tried, stuck = <15px progress toward the exit in 1.2 s of thrust (3 thrust angles per pocket), worst progress px)');
  for (const r of RADII) {
    const a = all.map((x) => x.sticky[r]);
    const tried = a.reduce((s, v) => s + v.tried, 0), stuck = a.reduce((s, v) => s + v.stuck, 0);
    const t0 = a.reduce((s, v) => s + v.tried0, 0), s0 = a.reduce((s, v) => s + v.stuck0, 0);
    console.log(`  r=${String(r).padStart(2)} tried=${tried} stuck=${stuck} (${(100 * stuck / Math.max(1, tried)).toFixed(1)}%)   straight-out thrust: tried=${t0} stuck=${s0}   worst progress=${Math.min(...a.map((v) => v.worst)).toFixed(0)}px`);
    bad += s0;
  }
  console.log('\nC) wall slide, 35 deg into a straight wall (slides, time in contact %, contact-offset std px, heading noise RMS / p95 deg, frames with >8deg zig-zag, speed CV, stalls)');
  for (const r of RADII) {
    const a = all.map((x) => x.slide[r]);
    const n = a.reduce((s, v) => s + v.n, 0), fr = a.reduce((s, v) => s + v.frames, 0), sp = a.reduce((s, v) => s + v.spikes, 0);
    const noise = a.flatMap((v) => v.noise), cs = a.flatMap((v) => v.cstd);
    console.log(`  r=${String(r).padStart(2)} slides=${n} contact=${(100 * mean(a.flatMap((v) => v.contact))).toFixed(0)}% offsetStd=${mean(cs).toFixed(3)}px heading=${mean(noise).toFixed(2)}/${pct(noise, 0.95).toFixed(2)}deg zigzag=${sp}/${fr} lateralWobble mean/p95/max=${mean(a.flatMap((v) => v.px)).toFixed(3)}/${pct(a.flatMap((v) => v.px), 0.95).toFixed(3)}/${Math.max(...a.flatMap((v) => v.px)).toFixed(2)}px cv=${mean(a.flatMap((v) => v.cv)).toFixed(3)} stalls=${a.reduce((s, v) => s + v.stalls, 0)}`);
  }
  const cs = all.flatMap((x) => RADII.flatMap((r) => (x.sticky[r].straight || []).map((c) => ({ seed: x.seed, depth: x.depth, straightOut: true, ...c }))));
  if (cs.length) { console.log('\nstuck cases:'); for (const c of cs.slice(0, 8)) console.log('  ' + JSON.stringify(c)); }
  if (process.argv.includes('--strict') && bad) process.exit(1);
}

if (isMainThread) await main(); else workerMain();
