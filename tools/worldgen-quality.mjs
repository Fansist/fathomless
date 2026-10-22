// Level-quality survey: shape statistics + a blind "explorer bot" that estimates how long a first-time player needs.
//   node tools/worldgen-quality.mjs [--seeds 60] [--depths 1,2,3,4,6,8,10,12] [--workers 6] [--bot 1]
//   WORLD=../js/world.baseline.js node tools/worldgen-quality.mjs
// Explorer bot: pings (range 450 px, 1.3 s per ping incl. charge), keeps a memory map of revealed cells, walks to the nearest
// frontier at 110 px/s (stealthy cruising speed), heads for the exit the moment a ping reveals it. Reports seconds until arrival.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { RNG, TAU } from '../js/rng.js';
import { COARSE } from '../js/config.js';
import { shapeStats, traceRoute, pct, mean } from './worldgen-lib.mjs';

const WORLD = process.env.WORLD || '../js/world.js';
const { generateLevel, sdfAt, rayMarch, cellOf } = await import(WORLD);

const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

function exploreBot(lv, speed = 110, pingR = 450, pingCost = 1.3) {
  const gw = lv.gw, gh = lv.gh, n = gw * gh;
  const known = new Uint8Array(n); // 1 = seen (open or rock)
  const S = lv.nav.S;
  const exitC = cellOf(lv, lv.exit.x, lv.exit.y);
  let x = lv.start.x, y = lv.start.y, t = 0, exitSeen = false, pings = 0;
  const rays = 300;
  const mark = (px, py) => { const c = cellOf(lv, px, py); known[c] = 1; return c; };
  const ping = () => {
    pings++; t += pingCost;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * TAU, dx = Math.cos(a), dy = Math.sin(a);
      const d = rayMarch(lv, x, y, dx, dy, pingR);
      for (let s = 0; s <= d + 6; s += 8) mark(x + dx * s, y + dy * s);
      // exit disc visible if the ray passes within 26 px of it before the wall
      const ex = lv.exit.x - x, ey = lv.exit.y - y, proj = ex * dx + ey * dy;
      if (proj > 0 && proj < d + 26 && Math.abs(ex * dy - ey * dx) < 26 && Math.hypot(ex, ey) < pingR) exitSeen = true;
    }
  };
  for (let iter = 0; iter < 400 && t < 900; iter++) {
    ping();
    // BFS over known S cells from the current cell
    const here = cellOf(lv, x, y);
    const dist = new Int16Array(n).fill(-1), prev = new Int32Array(n).fill(-1), q = new Int32Array(n);
    let qh = 0, qt = 0; q[qt++] = here; dist[here] = 0;
    let goal = -1, near = -1;
    while (qh < qt) {
      const c = q[qh++], cx = c % gw, cy = (c / gw) | 0;
      if (exitSeen && Math.abs(cx - (exitC % gw)) + Math.abs(cy - ((exitC / gw) | 0)) <= 1) { goal = c; break; }
      let frontier = false;
      for (let k = 0; k < 8; k++) {
        const nx = cx + D8[k][0], ny = cy + D8[k][1];
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const m = ny * gw + nx;
        if (!known[m] && c !== here) frontier = true;
        if (!known[m] || !S[m] || dist[m] >= 0) continue;
        if (k >= 4 && !(S[cy * gw + nx] && S[ny * gw + cx])) continue;
        dist[m] = dist[c] + 1; prev[m] = c; q[qt++] = m;
      }
      if (!exitSeen && frontier && c !== here) { if (dist[c] >= 3) { goal = c; break; } if (near < 0) near = c; }
    }
    if (goal < 0) goal = near;
    if (goal < 0) return { t: 900, pings, stuck: true };
    // walk up to ~ 6 cells (or the whole way if the exit is the goal), then ping again
    const path = [];
    for (let c = goal; c !== -1; c = prev[c]) path.push(c);
    path.reverse();
    const stepsToGo = exitSeen ? path.length - 1 : Math.min(path.length - 1, 6);
    let travelled = 0;
    for (let i = 1; i <= stepsToGo; i++) {
      const nx = (path[i] % gw + 0.5) * COARSE, ny = (((path[i] / gw) | 0) + 0.5) * COARSE;
      travelled += Math.hypot(nx - x, ny - y); x = nx; y = ny;
    }
    t += travelled / speed;
    if (Math.hypot(x - lv.exit.x, y - lv.exit.y) < 40 || (exitSeen && path.length - 1 <= stepsToGo && cellOf(lv, x, y) === goal)) {
      t += Math.hypot(lv.exit.x - x, lv.exit.y - y) / speed;
      return { t, pings, stuck: false };
    }
  }
  return { t, pings, stuck: true };
}

function workerMain() {
  const { tasks, bot } = workerData;
  const out = [];
  for (const [depth, s] of tasks) {
    const lv = generateLevel('q' + s, depth);
    const sh = shapeStats(lv);
    const rt = traceRoute(lv);
    const r = { depth, seed: s, attempt: lv.attempt, route: lv.routeLength, routePx: Math.round(rt.px), reach: lv.reach, ...sh, flora: lv.flora.length, xl: depth >= 12 && lv.xlCells.length ? lv.xlCells.length / lv.reach : null, cur: lv.currents.length };
    if (bot) { const b = exploreBot(lv); r.tExplore = b.t; r.stuck = b.stuck; r.pings = b.pings; }
    out.push(r);
  }
  parentPort.postMessage(out);
}

async function main() {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
  const seeds = +arg('seeds', 60), nW = +arg('workers', 6), bot = +arg('bot', 1);
  const depths = String(arg('depths', '1,2,3,4,6,8,10,12')).split(',').map(Number);
  const tasks = [];
  for (let s = 0; s < seeds; s++) for (const d of depths) tasks.push([d, s]);
  const shards = Array.from({ length: nW }, () => []);
  tasks.forEach((t, i) => shards[i % nW].push(t));
  const res = [];
  const t0 = Date.now();
  await Promise.all(shards.map((tk) => new Promise((rs, rj) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { tasks: tk, bot } });
    w.on('message', (m) => { res.push(...m); rs(); });
    w.on('error', rj);
  })));
  console.log(`world=${WORLD} levels=${res.length} wall=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('depth  route cells mean [p5..p95] max | routePx | reach% open% | chambers bigCav% tunnel% deadEnds | explore s median [p10..p90] stuck | xl%  currents');
  for (const d of depths) {
    const r = res.filter((x) => x.depth === d);
    const rt = r.map((x) => x.route);
    const te = r.filter((x) => x.tExplore !== undefined && !x.stuck).map((x) => x.tExplore);
    const xl = r.filter((x) => x.xl != null).map((x) => x.xl);
    console.log(`${String(d).padStart(3)}   ${mean(rt).toFixed(0).padStart(5)} [${pct(rt, 0.05)}..${pct(rt, 0.95)}] max ${Math.max(...rt)} | ${mean(r.map((x) => x.routePx)).toFixed(0).padStart(5)} | ${(100 * mean(r.map((x) => x.reachFrac))).toFixed(0).padStart(3)} ${(100 * mean(r.map((x) => x.openFrac))).toFixed(0).padStart(3)} | ${mean(r.map((x) => x.chambers)).toFixed(1).padStart(5)} ${(100 * mean(r.map((x) => x.biggestChamberFrac))).toFixed(0).padStart(6)} ${(100 * mean(r.map((x) => x.tunnelFrac))).toFixed(0).padStart(6)} ${mean(r.map((x) => x.deadEnds)).toFixed(1).padStart(6)} | ${te.length ? pct(te, 0.5).toFixed(0).padStart(4) + ' [' + pct(te, 0.1).toFixed(0) + '..' + pct(te, 0.9).toFixed(0) + '] ' + r.filter((x) => x.stuck).length : '-'} | ${xl.length ? (100 * mean(xl)).toFixed(0) + '% (min ' + (100 * Math.min(...xl)).toFixed(0) + '%)' : '-'}  ${mean(r.map((x) => x.cur)).toFixed(1)}  att ${mean(r.map((x) => x.attempt || 0)).toFixed(2)}`);
  }
  const all = res;
  console.log(`overall: ONE_BIG_CAVERN(>45%) ${all.filter((x) => x.biggestChamberFrac > 0.45).length}/${all.length}  route<70: ${all.filter((x) => x.route < 70).length}  route>400: ${all.filter((x) => x.route > 400).length}  chambers<3: ${all.filter((x) => x.chambers < 3).length}`);
}

if (isMainThread) await main(); else workerMain();
