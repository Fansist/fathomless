// Extended level-generation fuzz + level-quality survey (Node, multi-threaded).
//   node tools/worldgen-fuzz.mjs [--seeds 500] [--from 1] [--to 14] [--workers 6] [--out file.json] [--strict]
// Hard checks (issues) make the process exit 1 with --strict; quality warnings are reported but never fail.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
const { generateLevel, sdfAt, gradAt, rayMarch, cellOf } = await import(process.env.WORLD || '../js/world.js'); // WORLD=../js/other.js to test a variant
import { CELL, COARSE, spawnTable } from '../js/config.js';
import { fineFlood, inFlood, traceRoute, shapeStats, pct, mean } from './worldgen-lib.mjs';

const NOM = { pearl: 8, buoy: 10, patch: 11, jelly: 15, urchin: 13, angler: 17, eel: 11, leviathan: 27 };
const AVOID_START = { urchin: 180, angler: 300, eel: 380, jelly: 300 };
const KINDS = [['urchins', 'urchin'], ['anglers', 'angler'], ['eels', 'eel'], ['jellies', 'jelly'], ['pearls', 'pearl'], ['buoys', 'buoy'], ['patches', 'patch']];

function analyze(lv, ms, depth, seed) {
  const issues = [], warns = [];
  const add = (k) => issues.push(k), warn = (k) => warns.push(k);
  const sp = lv.spawns;
  const cpu = {};
  // ---- start / exit
  if (sdfAt(lv, lv.start.x, lv.start.y) < 24) add('START_TIGHT');
  if (sdfAt(lv, lv.exit.x, lv.exit.y) < 24) add('EXIT_TIGHT');
  const ec = cellOf(lv, lv.exit.x, lv.exit.y);
  if (!(lv.startDist[ec] >= 0)) add('EXIT_NOT_S_REACHABLE');
  const flood9 = fineFlood(lv, lv.start.x, lv.start.y, 9);
  if (!inFlood(lv, flood9, lv.exit.x, lv.exit.y)) add('EXIT_UNREACH_FINE');
  // ---- spawn margins / reachability / start distance
  for (const [key, type] of KINDS) {
    for (const p of sp[key]) {
      if (!isFinite(p.x) || !isFinite(p.y)) { add('SPAWN_NAN:' + type); continue; }
      if (p.x < 0 || p.y < 0 || p.x > lv.width || p.y > lv.height) add('SPAWN_OOB:' + type);
      if (sdfAt(lv, p.x, p.y) < NOM[type] + 4) add('SPAWN_SDF:' + type);
      const c = cellOf(lv, p.x, p.y);
      if (type === 'pearl' || type === 'buoy' || type === 'patch') {
        if (!inFlood(lv, flood9, p.x, p.y)) add('SPAWN_UNREACH:' + type);
      } else if (!(lv.startDist[c] >= 0)) {
        // hunters may sit in L-only cells; they still must be inside the S-reachable component's neighbourhood
        let near = false;
        for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2 && !near; dx++) {
          const x = (c % lv.gw) + dx, y = ((c / lv.gw) | 0) + dy;
          if (x >= 0 && y >= 0 && x < lv.gw && y < lv.gh && lv.startDist[y * lv.gw + x] >= 0) near = true;
        }
        if (!near) add('SPAWN_UNREACH:' + type);
      }
      if (AVOID_START[type] && Math.hypot(p.x - lv.start.x, p.y - lv.start.y) < AVOID_START[type] - 0.5) add('HUNTER_NEAR_START:' + type);
    }
  }
  if (sp.leviathan) {
    const p = sp.leviathan;
    if (sdfAt(lv, p.x, p.y) < NOM.leviathan + 4) add('SPAWN_SDF:leviathan');
    if (Math.hypot(p.x - lv.start.x, p.y - lv.start.y) < 380) add('HUNTER_NEAR_START:leviathan');
  }
  if (sp.anglers.length) for (const a of sp.anglers) {
    const lx = a.x + Math.cos(a.a) * 38, ly = a.y + Math.sin(a.a) * 38;
    if (sdfAt(lv, lx, ly) < 12) add('ANGLER_LURE_IN_ROCK');
  }
  // ---- hazard overlap
  const haz = [];
  for (const [key, type] of KINDS.slice(0, 4)) for (const p of sp[key]) haz.push({ x: p.x, y: p.y, r: NOM[type], type });
  if (sp.leviathan) haz.push({ x: sp.leviathan.x, y: sp.leviathan.y, r: NOM.leviathan, type: 'leviathan' });
  for (let i = 0; i < haz.length; i++) for (let j = i + 1; j < haz.length; j++) {
    if (Math.hypot(haz[i].x - haz[j].x, haz[i].y - haz[j].y) < haz[i].r + haz[j].r + 6) add('HAZARD_OVERLAP:' + haz[i].type + '+' + haz[j].type);
  }
  const loot = [];
  for (const [key, type] of KINDS.slice(4)) for (const p of sp[key]) loot.push({ x: p.x, y: p.y, r: NOM[type], type });
  for (const l of loot) for (const h of haz) {
    if (Math.hypot(l.x - h.x, l.y - h.y) < l.r + h.r + 12) { add('LOOT_ON_HAZARD:' + l.type + '+' + h.type); break; }
  }
  // exit not smothered by a hazard
  for (const h of haz) if (h.type !== 'jelly' && Math.hypot(h.x - lv.exit.x, h.y - lv.exit.y) < h.r + 40) add('HAZARD_ON_EXIT:' + h.type);
  // ---- urchins can't wall off the level
  const urchins = sp.urchins.map((p) => ({ x: p.x, y: p.y, r: 22 }));
  if (urchins.length) {
    const f22 = fineFlood(lv, lv.start.x, lv.start.y, 9, urchins);
    if (!inFlood(lv, f22, lv.exit.x, lv.exit.y)) add('URCHIN_BLOCKS_EXIT');
    else {
      const f30 = fineFlood(lv, lv.start.x, lv.start.y, 9, urchins.map((u) => ({ x: u.x, y: u.y, r: 31 })));
      if (!inFlood(lv, f30, lv.exit.x, lv.exit.y)) warn('URCHIN_PINCH');
    }
    for (const l of loot) if (l.type !== 'pearl' && !inFlood(lv, f22, l.x, l.y)) add('URCHIN_BLOCKS_' + l.type.toUpperCase());
  }
  // ---- leviathan / patrol
  let levFrac = null, levOverlap = null;
  const route = traceRoute(lv);
  if (depth >= 12) {
    if (!sp.leviathan) add('LEV_MISSING');
    else {
      levFrac = lv.xlCells.length / lv.reach;
      if (levFrac < 0.3) warn('LEV_XL_SMALL');
      const xl = new Uint8Array(lv.gw * lv.gh);
      for (const c of lv.xlCells) xl[c] = 1;
      let hit = 0;
      for (const c of route.path) {
        const cx = c % lv.gw, cy = (c / lv.gw) | 0;
        let h = false;
        for (let dy = -3; dy <= 3 && !h; dy++) for (let dx = -3; dx <= 3 && !h; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && y >= 0 && x < lv.gw && y < lv.gh && xl[y * lv.gw + x]) h = true;
        }
        if (h) hit++;
      }
      levOverlap = hit / route.path.length;
      if (levOverlap < 0.25) warn('LEV_NO_ROUTE_OVERLAP');
    }
  } else if (sp.leviathan) add('LEV_UNEXPECTED');
  // ---- flora
  let inRock = 0, poke = 0, noFace = 0;
  const gt = { x: 0, y: 0 };
  for (const f of lv.flora) {
    const s0 = sdfAt(lv, f.x, f.y);
    if (s0 < -1.5 || s0 > 3.5 || !isFinite(s0)) inRock++;
    if (Math.abs(Math.hypot(f.nx, f.ny) - 1) > 1e-3) noFace++;
    const free = rayMarch(lv, f.x + f.nx * 2, f.y + f.ny * 2, f.nx, f.ny, f.len + 6);
    if (free < f.len * 0.97) poke++;
  }
  if (inRock) add('FLORA_IN_ROCK');
  if (noFace) add('FLORA_BAD_NORMAL');
  if (poke) warn('FLORA_POKES');
  // ---- currents
  for (const c of lv.currents) {
    if (sdfAt(lv, c.x, c.y) < 50) add('CURRENT_NARROW');
    if (Math.hypot(c.x - lv.start.x, c.y - lv.start.y) < c.r) warn('CURRENT_ON_START');
  }
  // ---- quality
  const sh = shapeStats(lv);
  if (lv.routeLength < 70) warn('ROUTE_SHORT');
  if (lv.routeLength > 400 && depth <= 6) warn('ROUTE_LONG');
  if (sh.biggestChamberFrac > 0.45) warn('ONE_BIG_CAVERN');
  // counts
  const tbl = spawnTable(depth);
  for (const [key, tkey] of [['jellies', 'jelly'], ['urchins', 'urchin'], ['eels', 'eel'], ['anglers', 'angler']]) {
    if (sp[key].length < tbl[tkey] && !(key === 'anglers')) warn('SHORT_COUNT:' + tkey);
  }
  if (sp.pearls.length < tbl.pearls) warn('SHORT_COUNT:pearl');
  if (sp.buoys.length < tbl.buoys) warn('SHORT_COUNT:buoy');
  if (sp.patches.length < tbl.patches) warn('SHORT_COUNT:patch');
  return {
    depth, seed, ms, attempt: lv.attempt, issues, warns,
    route: lv.routeLength, routePx: Math.round(route.px), reach: lv.reach, ...sh,
    levFrac, levOverlap, flora: lv.flora.length, poke,
    counts: { j: sp.jellies.length, u: sp.urchins.length, e: sp.eels.length, a: sp.anglers.length, p: sp.pearls.length },
  };
}

function hashLevel(lv) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < lv.sdf.length; i += 7) h = Math.imul(h ^ ((lv.sdf[i] * 16) | 0), 16777619) >>> 0;
  h = Math.imul(h ^ ((lv.spawns.pearls.length * 31 + lv.spawns.jellies.length) | 0), 16777619) >>> 0;
  return h;
}

if (!isMainThread) {
  const { tasks } = workerData;
  const out = [];
  const cpu = () => performance.now(); // wall clock inside a worker (process.cpuUsage is process-wide, so it would count the other workers)
  for (const [depth, s] of tasks) {
    const seed = workerData.rand ? 'r' + (Math.imul(s + 1, 2654435761) >>> 0).toString(36) : 'fz' + s;
    let lv, ms = 0;
    try {
      const c0 = cpu();
      lv = generateLevel(seed, depth);
      ms = cpu() - c0;
    } catch (e) { out.push({ depth, seed, ms: 0, issues: ['GEN_THROW:' + e.message], warns: [] }); continue; }
    let r;
    try { r = analyze(lv, ms, depth, seed); } catch (e) { r = { depth, seed, ms, issues: ['ANALYZE_THROW:' + e.stack.split('\n').slice(0, 3).join(' | ')], warns: [] }; }
    if (s % 25 === 0) { // determinism spot check
      const lv2 = generateLevel(seed, depth);
      if (hashLevel(lv) !== hashLevel(lv2)) r.issues.push('NONDETERMINISTIC');
    }
    out.push(r);
  }
  parentPort.postMessage(out);
} else {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
  const seeds = +arg('seeds', 500), from = +arg('from', 1), to = +arg('to', 14), nW = +arg('workers', 6);
  const outFile = arg('out', null), strict = process.argv.includes('--strict'), rand = process.argv.includes('--rand'), extras = process.argv.includes('--extras');
  const tasks = [];
  for (let s = 0; s < seeds; s++) for (let d = from; d <= to; d++) tasks.push([d, s]);
  if (extras) for (let s = 0; s < seeds; s += 5) for (const d of [15, 20, 33, 50]) tasks.push([d, s]); // endless-mode depths
  const shards = Array.from({ length: nW }, () => []);
  tasks.forEach((t, i) => shards[i % nW].push(t));
  const t0 = Date.now();
  const results = [];
  let done = 0;
  await Promise.all(shards.map((tk) => new Promise((res, rej) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { tasks: tk, rand } });
    w.on('message', (m) => { results.push(...m); done++; res(); });
    w.on('error', rej);
  })));
  const wall = ((Date.now() - t0) / 1000).toFixed(1);

  const bands = [['d1', 1, 1], ['d2', 2, 2], ['d3', 3, 3], ['d4-6', 4, 6], ['d7-9', 7, 9], ['d10-11', 10, 11], ['d12', 12, 12], ['d13-14', 13, 14], ['d15+', 15, 999]];
  console.log(`levels=${results.length} wall=${wall}s workers=${nW}`);
  console.log('\n== generation time (worker wall ms; machine may be contended - use worldgen-bench.mjs for clean CPU numbers) ==');
  for (const [name, a, b] of bands) {
    const r = results.filter((x) => x.depth >= a && x.depth <= b && x.ms);
    if (!r.length) continue;
    const ms = r.map((x) => x.ms);
    console.log(`${name.padEnd(7)} n=${String(r.length).padStart(5)} mean ${mean(ms).toFixed(0).padStart(4)}  p95 ${pct(ms, 0.95).toFixed(0).padStart(4)}  p99 ${pct(ms, 0.99).toFixed(0).padStart(4)}  max ${Math.max(...ms).toFixed(0).padStart(4)}   attempts mean ${mean(r.map((x) => x.attempt || 0)).toFixed(2)} max ${Math.max(...r.map((x) => x.attempt || 0))}`);
  }
  const tally = (key) => {
    const m = new Map();
    for (const r of results) for (const k of r[key] || []) { const e = m.get(k) || { n: 0, ex: [] }; e.n++; if (e.ex.length < 3) e.ex.push(`${r.seed}@${r.depth}`); m.set(k, e); }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  };
  const iss = tally('issues'), wrn = tally('warns');
  console.log('\n== HARD ISSUES ==' + (iss.length ? '' : ' none'));
  for (const [k, v] of iss) console.log(`${String(v.n).padStart(5)}  ${k}   e.g. ${v.ex.join(', ')}`);
  console.log('\n== quality warnings (per level count) ==' + (wrn.length ? '' : ' none'));
  for (const [k, v] of wrn) console.log(`${String(v.n).padStart(5)}  ${k}   e.g. ${v.ex.join(', ')}`);
  console.log('\n== level shape per band ==');
  console.log('band     route(cells) mean [p5..p95]   routePx  reach%  open%  chambers  bigCav%  tunnel%  deadEnds');
  for (const [name, a, b] of bands) {
    const r = results.filter((x) => x.depth >= a && x.depth <= b && x.route);
    if (!r.length) continue;
    const rt = r.map((x) => x.route);
    console.log(`${name.padEnd(7)} ${mean(rt).toFixed(0).padStart(6)} [${pct(rt, 0.05)}..${pct(rt, 0.95)}] max ${Math.max(...rt)}   ${mean(r.map((x) => x.routePx)).toFixed(0).padStart(6)}  ${(100 * mean(r.map((x) => x.reachFrac))).toFixed(0).padStart(4)}  ${(100 * mean(r.map((x) => x.openFrac))).toFixed(0).padStart(4)}  ${mean(r.map((x) => x.chambers)).toFixed(1).padStart(7)}  ${(100 * mean(r.map((x) => x.biggestChamberFrac))).toFixed(0).padStart(6)}  ${(100 * mean(r.map((x) => x.tunnelFrac))).toFixed(0).padStart(6)}  ${mean(r.map((x) => x.deadEnds)).toFixed(1).padStart(6)}`);
  }
  const lev = results.filter((x) => x.levFrac != null);
  if (lev.length) console.log(`\nleviathan (depth>=12, n=${lev.length}): xlCells/reach mean ${(100 * mean(lev.map((x) => x.levFrac))).toFixed(0)}%  p5 ${(100 * pct(lev.map((x) => x.levFrac), 0.05)).toFixed(0)}%  min ${(100 * Math.min(...lev.map((x) => x.levFrac))).toFixed(0)}%   route-overlap mean ${(100 * mean(lev.map((x) => x.levOverlap))).toFixed(0)}% p5 ${(100 * pct(lev.map((x) => x.levOverlap), 0.05)).toFixed(0)}%`);
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(results));
  if (strict && iss.length) process.exit(1);
}
