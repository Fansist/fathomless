// Targeted creature-behaviour scenario tests (deterministic, headless, stubbed DOM).
//   node tools/ai-scenarios.mjs [--only name,name] [--json out.json] [--seeds 4]
// Each scenario builds a controlled scene inside a real generated level, steps game.update(1/60) and
// prints PASS/FAIL checks with the measured numbers.
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { loadModules, makeGame, seedMath } from './ai-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const only = opt('only', '') ? opt('only', '').split(',') : null;
const SEEDS = +opt('seeds', 4);

const M = await loadModules(pathToFileURL(path.resolve(process.env.AI_JSROOT || root) + '/js/').href);
const { world: W, entities: E, config: C } = M;

/* ------------------------------ helpers ------------------------------ */
const IDLE = { mx: 0, my: 0, ping: false, dash: false, buoy: false };
const rnd = () => Math.random();
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function scene(seed, depth, { god = true, ghost = false } = {}) {
  seedMath('scn|' + seed + '|' + depth);
  const g = makeGame(M);
  g.startRun({ seed });
  g.loadLevel(depth);
  g.enemies = []; g.pickups = []; g.buoys = []; g.pings = [];
  g.god = god;
  g.bot = () => IDLE;
  const p = g.player;
  p.invul = 0; p.dead = ghost; p.hull = p.maxHull = g.stats.maxHull; p.energy = 100;
  return g;
}
function put(g, x, y) { const p = g.player; p.x = x; p.y = y; p.vx = 0; p.vy = 0; }
function add(g, type, x, y, a) { const e = E.makeEnemy(type, { x, y, a: a === undefined ? 0 : a }, g.run.depth); g.enemies.push(e); return e; }
function run(g, sec, cb) {
  const n = Math.round(sec * 60);
  for (let i = 0; i < n; i++) { g.update(1 / 60); if (cb && cb(i / 60, i) === false) return (i + 1) / 60; }
  return sec;
}
// random open spot: dist from (cx,cy) in [r0,r1], optional line of sight, clearance
function spotNear(g, cx, cy, r0, r1, { los = true, clear = 22, tries = 4000, losR = 8 } = {}) {
  const lv = g.lv;
  for (let i = 0; i < tries; i++) {
    const a = rnd() * Math.PI * 2, r = r0 + rnd() * (r1 - r0);
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (W.sdfAt(lv, x, y) < clear) continue;
    if (los && !W.lineClear(lv, cx, cy, x, y, losR)) continue;
    return { x, y };
  }
  return null;
}
// an open place with lots of room around it (so both ends of a 400 px line are free)
function bigRoom(g, clear = 40) {
  const lv = g.lv;
  const cells = [];
  for (let c = 0; c < lv.gw * lv.gh; c++) if (lv.startDist[c] >= 0 && lv.clear[c] >= clear) cells.push(c);
  if (!cells.length) return { x: lv.start.x, y: lv.start.y };
  const c = cells[Math.floor(rnd() * cells.length)];
  return { x: (c % lv.gw + 0.5) * 16, y: (((c / lv.gw) | 0) + 0.5) * 16 };
}
const results = [];
function check(scn, name, ok, info) { results.push({ scn, name, ok: !!ok, info }); console.log(`${ok ? 'PASS' : 'FAIL'}  [${scn}] ${name}${info !== undefined ? '  ' + (typeof info === 'string' ? info : JSON.stringify(info)) : ''}`); }
const wanted = (n) => !only || only.includes(n);
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const inRock = (g, e) => { let n = 0; if (e.spine) for (const q of e.spine) if (W.sdfAt(g.lv, q.x, q.y) < 0) n++; return n; };

/* --------------------------- 1. jelly --------------------------- */
if (wanted('jelly')) {
  const moved = [], toPing = [], noRock = [];
  let attractedNear = 0, attractedFar = 0, nearN = 0, farN = 0, tapNear = 0, tapN = 0;
  for (let s = 0; s < SEEDS; s++) {
    const g = scene('j' + s, 3, { ghost: true });
    const room = bigRoom(g, 40);
    const j = add(g, 'jelly', room.x, room.y);
    const x0 = j.x, y0 = j.y;
    let minS = 1e9, maxD = 0;
    run(g, 40, () => { minS = Math.min(minS, W.sdfAt(g.lv, j.x, j.y)); maxD = Math.max(maxD, Math.hypot(j.x - x0, j.y - y0)); });
    moved.push(maxD); noRock.push(minS);
    // ping response: loud ping at 150 and 400 px
    for (const [r, big] of [[150, true], [400, true], [90, false]]) {
      const g2 = scene('j2' + s + r + big, 3, { ghost: true });
      const rm = bigRoom(g2, 40);
      const jj = add(g2, 'jelly', rm.x, rm.y);
      const sp = spotNear(g2, rm.x, rm.y, r, r + 6, { clear: 20 });
      if (!sp) continue;
      const pw = big ? 1 : 0.1;
      const maxR = (C.PING.minR + (C.PING.maxR - C.PING.minR) * pw) * g2.stats.rangeMult;
      g2.noiseEvent(sp.x, sp.y, maxR * g2.stats.pingLoud * 0.9, 'ping', pw);
      const att = jj.state === 'attract';
      if (big && r === 150) { nearN++; if (att) attractedNear++; const d0 = Math.hypot(jj.x - sp.x, jj.y - sp.y); run(g2, 6); toPing.push(d0 - Math.hypot(jj.x - sp.x, jj.y - sp.y)); }
      if (big && r === 400) { farN++; if (att) attractedFar++; }
      if (!big) { tapN++; if (att) tapNear++; }
    }
  }
  check('jelly', 'wanders (max displacement in 40 s >= 150 px)', mean(moved) >= 150 && Math.min(...moved) >= 60, { mean: Math.round(mean(moved)), min: Math.round(Math.min(...moved)) });
  check('jelly', 'never inside rock', Math.min(...noRock) > 0, { minSdf: Math.round(Math.min(...noRock)) });
  check('jelly', 'loud ping at 150 px attracts it', attractedNear === nearN, `${attractedNear}/${nearN}`);
  check('jelly', 'loud ping at 400 px does not', attractedFar === 0, `${attractedFar}/${farN}`);
  check('jelly', 'tap at 90 px attracts (quiet range ~150)', true, `${tapNear}/${tapN} (informational)`);
  check('jelly', 'attracted jelly closes on the ping', mean(toPing) > 40, { meanCloseBy: Math.round(mean(toPing)) });
}

/* --------------------------- 2. urchin --------------------------- */
if (wanted('urchin')) {
  const g = scene('u1', 8, { ghost: true });
  const u = g.enemies.length ? null : null;
  for (const s of g.lv.spawns.urchins) add(g, 'urchin', s.x, s.y);
  const p0 = g.enemies.map((e) => [e.x, e.y]);
  run(g, 120);
  const drift = Math.max(...g.enemies.map((e, i) => Math.hypot(e.x - p0[i][0], e.y - p0[i][1])));
  check('urchin', `static over 120 s (${g.enemies.length} urchins)`, drift < 0.01, { maxDrift: drift });
  // touching one hurts exactly once per invulnerability window
  const g2 = scene('u2', 8, { god: false });
  const sp = g2.lv.spawns.urchins[0]; const e2 = add(g2, 'urchin', sp.x, sp.y);
  put(g2, sp.x + 14, sp.y);
  let hits = 0; const oh = g2.hurt.bind(g2); g2.hurt = (...a) => { const h = g2.player.hull; oh(...a); if (g2.player.hull < h) hits++; };
  run(g2, 1.0);
  check('urchin', 'touch costs 1 hull then invulnerability', hits === 1 && g2.player.hull === g2.player.maxHull - 1, { hits, hull: g2.player.hull });
}

/* --------------------------- 3. angler --------------------------- */
if (wanted('angler')) {
  const rows = [];
  for (let s = 0; s < SEEDS; s++) {
    const probe = scene('a' + s, 8, { god: true });
    const sp = probe.lv.spawns.anglers[0];
    if (!sp) continue;
    const test = (R, alerted) => {
      const g = scene('a' + s, 8, { god: true });
      const an = add(g, 'angler', sp.x, sp.y, sp.a);
      // player straight ahead of the angler if the line is clear, else search a clear ring spot
      let pos = { x: sp.x + Math.cos(sp.a) * R, y: sp.y + Math.sin(sp.a) * R };
      if (W.sdfAt(g.lv, pos.x, pos.y) < 14 || !W.lineClear(g.lv, sp.x, sp.y, pos.x, pos.y, 3)) pos = spotNear(g, sp.x, sp.y, R - 2, R + 2, { clear: 14, losR: 3 });
      if (!pos) return null;
      put(g, pos.x, pos.y);
      if (alerted) g.noiseEvent(pos.x, pos.y, 600, 'ping', 1);
      let lunged = false;
      run(g, 0.2, () => { if (an.state === 'lunge' || an.state === 'aim') { lunged = true; return false; } });
      return lunged;
    };
    rows.push({ s, d120: test(120), d140: test(140), d165: test(165), d200: test(200), d200a: test(200, true), d230a: test(230, true), d260a: test(260, true) });
  }
  const all = (k, v) => rows.filter((r) => r[k] !== null).every((r) => r[k] === v);
  const cnt = (k) => rows.filter((r) => r[k] !== null).length;
  check('angler', 'lunges at <=140 px (quiet)', all('d120', true) && all('d140', true), rows.map((r) => [r.d120, r.d140]));
  check('angler', 'does not lunge at 165-200 px (quiet)', all('d165', false) && all('d200', false), rows.map((r) => [r.d165, r.d200]));
  check('angler', 'after a nearby ping: lunges at 200 and 230, not at 260', all('d200a', true) && all('d230a', true) && all('d260a', false), rows.map((r) => [r.d200a, r.d230a, r.d260a]));
  // full lunge cycle: lunge, recover, return home, idle again, lure visible
  const homeErr = [], cycle = [], lureOk = [], lureGap = [];
  for (let s = 0; s < SEEDS; s++) {
    const probe = scene('a' + s, 8, { god: true });
    const sp = probe.lv.spawns.anglers[0]; if (!sp) continue;
    const g = scene('a' + s, 8, { god: true });
    const an = add(g, 'angler', sp.x, sp.y, sp.a);
    const pos = spotNear(g, sp.x, sp.y, 100, 120, { clear: 14, losR: 3 }); if (!pos) continue;
    put(g, pos.x, pos.y);
    let t0 = -1, tIdle = -1, maxFromHome = 0, lureBad = 0, ln = 0, minLureSdf = 1e9;
    run(g, 14, (t) => {
      if ((an.state === 'lunge' || an.state === 'aim') && t0 < 0) { t0 = t; put(g, pos.x, pos.y); }
      if (t0 >= 0) maxFromHome = Math.max(maxFromHome, Math.hypot(an.x - sp.x, an.y - sp.y));
      if (t0 >= 0 && an.state === 'idle' && t > t0 + 0.8 && tIdle < 0) tIdle = t;
      const l = an.lure(); ln++; const ls = W.sdfAt(g.lv, l.x, l.y); minLureSdf = Math.min(minLureSdf, ls); if (ls < 0) lureBad++;
      if (tIdle >= 0) g.player.dead = true;   // the lunge is over: take the player out of the picture so it cannot trigger another one
    });
    // after settling the angler should be within a few px of its home
    run(g, 6);
    homeErr.push(Math.hypot(an.x - sp.x, an.y - sp.y));
    cycle.push(tIdle >= 0 ? tIdle - t0 : 99);
    lureOk.push(lureBad === 0); lureGap.push(minLureSdf);
  }
  check('angler', 'lunge -> recover -> idle within 6 s', cycle.length && Math.max(...cycle) <= 6, cycle.map((x) => +x.toFixed(1)));
  check('angler', 'ends back at home (<=12 px)', homeErr.length && Math.max(...homeErr) <= 12, homeErr.map((x) => Math.round(x)));
  check('angler', 'lure always in open water', lureOk.every(Boolean), lureGap.map((x) => Math.round(x)));
}

/* --------------------------- 4. eel patrol --------------------------- */
if (wanted('eelpatrol')) {
  for (const depth of [4, 9]) {
    const cov = [], stuck = [], states = {}, reversals = [], wps = [], minS = [], spineRock = [], maxSp = [];
    for (let s = 0; s < SEEDS; s++) {
      const g = scene('e' + s, depth, { ghost: true });
      const sp = g.lv.spawns.eels[0] || g.lv.patrol && { x: (g.lv.patrol[0] % g.lv.gw + 0.5) * 16, y: (((g.lv.patrol[0] / g.lv.gw) | 0) + 0.5) * 16 };
      const e = add(g, 'eel', sp.x, sp.y);
      const lv = g.lv, bw = 6;
      const blocks = new Set(), allBlocks = new Set();
      for (const c of lv.patrol) allBlocks.add(((c % lv.gw / bw) | 0) + ',' + (((c / lv.gw) | 0) / bw | 0));
      let lastT = { x: e.tx, y: e.ty }, nWp = 0, wx = e.x, wy = e.y, wt = 0, lpx = e.x, lpy = e.y, trav = 0, st = 0, rev = 0, pvx = 0, pvy = 0, rt = 0, ms = 1e9, sr = 0, mx = 0;
      const T = 240;
      run(g, T, (t) => {
        const cx = (e.x / 16) | 0, cy = (e.y / 16) | 0;
        blocks.add(((cx / bw) | 0) + ',' + ((cy / bw) | 0));
        states[e.state] = (states[e.state] || 0) + 1;
        if (Math.hypot(e.tx - lastT.x, e.ty - lastT.y) > 1) { nWp++; lastT = { x: e.tx, y: e.ty }; }
        trav += Math.hypot(e.x - lpx, e.y - lpy); lpx = e.x; lpy = e.y;
        if (t - wt >= 15) { if (Math.hypot(e.x - wx, e.y - wy) < 20 && trav < 150 && e.state === 'patrol') st++; wx = e.x; wy = e.y; wt = t; trav = 0; }
        rt += 1 / 60;
        if (rt >= 0.25) { rt = 0; const sp2 = Math.hypot(e.vx, e.vy); if (sp2 > 30 && pvx * e.vx + pvy * e.vy < -0.5 * sp2 * Math.hypot(pvx, pvy)) rev++; pvx = e.vx; pvy = e.vy; }
        ms = Math.min(ms, W.sdfAt(lv, e.x, e.y)); sr += inRock(g, e) ? 1 : 0; mx = Math.max(mx, Math.hypot(e.vx, e.vy));
      });
      cov.push(blocks.size / allBlocks.size); stuck.push(st); reversals.push(rev / (T / 60)); wps.push(nWp); minS.push(ms); spineRock.push(sr); maxSp.push(mx);
    }
    check('eelpatrol', `d${depth}: visits many areas (>=14% of 96px blocks in 240 s, >=5 waypoints)`, mean(cov) >= 0.14 && Math.min(...wps) >= 5, { coverage: cov.map((x) => +x.toFixed(2)), waypoints: wps });
    check('eelpatrol', `d${depth}: never stuck (no 15 s window with <20 px travel)`, stuck.every((x) => x === 0), stuck);
    check('eelpatrol', `d${depth}: no jitter (velocity reversals per min < 3)`, mean(reversals) < 3, reversals.map((x) => +x.toFixed(1)));
    check('eelpatrol', `d${depth}: head never in rock`, Math.min(...minS) > 0, minS.map((x) => Math.round(x)));
    check('eelpatrol', `d${depth}: no spine node in rock`, spineRock.every((x) => x === 0), spineRock);
    check('eelpatrol', `d${depth}: patrol speed sane (max <= 110: patrol 70 plus ocean currents)`, Math.max(...maxSp) <= 110, maxSp.map((x) => Math.round(x)));
  }
}

/* --------------------------- 5. eel hearing --------------------------- */
if (wanted('eelhear')) {
  const out = { tapIgnored: 0, tapN: 0, midHeard: 0, midN: 0, midFarHeard: 0, midFarN: 0, fullHeard: 0, fullN: 0, fullFarHeard: 0, fullFarN: 0, arrive: [], searchThenPatrol: 0, searchN: 0 };
  for (let s = 0; s < SEEDS; s++) {
    for (const [pw, R, key] of [[0.1, 120, 'tap'], [0.3, 200, 'mid'], [0.3, 450, 'midFar'], [1, 450, 'full'], [1, 700, 'fullFar']]) {
      const g = scene('h' + s + key, 7, { god: true });
      const room = bigRoom(g, 34);
      const pos = room;
      const sp = spotNear(g, pos.x, pos.y, R - 4, R + 4, { los: false, clear: 24 });
      if (!sp) continue;
      const e = add(g, 'eel', sp.x, sp.y);
      put(g, pos.x, pos.y);
      g.player.energy = 100;
      g.firePing(pw);
      const heard = e.state === 'investigate';
      if (key === 'tap') { out.tapN++; if (!heard) out.tapIgnored++; }
      if (key === 'mid') { out.midN++; if (heard) out.midHeard++; }
      if (key === 'midFar') { out.midFarN++; if (heard) out.midFarHeard++; }
      if (key === 'full') { out.fullN++; if (heard) out.fullHeard++; if (heard) { g.player.dead = true; let t0 = -1, tSearch = -1, tPatrol = -1; const tEnd = run(g, 40, (t) => { if (e.state === 'search' && tSearch < 0) tSearch = t; if (tSearch >= 0 && e.state === 'patrol' && tPatrol < 0) tPatrol = t; if (tPatrol >= 0) return false; }); if (tSearch >= 0) out.arrive.push(tSearch); out.searchN++; if (tPatrol >= 0) out.searchThenPatrol++; } }
      if (key === 'fullFar') { out.fullFarN++; if (heard) out.fullFarHeard++; }
    }
  }
  check('eelhear', 'tap (power 0.1) is ignored', out.tapIgnored === out.tapN, `${out.tapIgnored}/${out.tapN}`);
  check('eelhear', 'power-0.3 ping at 200 px is heard', out.midHeard === out.midN, `${out.midHeard}/${out.midN}`);
  check('eelhear', 'power-0.3 ping at 450 px is NOT heard', out.midFarHeard === 0, `${out.midFarHeard}/${out.midFarN}`);
  check('eelhear', 'full ping at 450 px is heard', out.fullHeard === out.fullN, `${out.fullHeard}/${out.fullN}`);
  check('eelhear', 'full ping at 700 px is NOT heard', out.fullFarHeard === 0, `${out.fullFarHeard}/${out.fullFarN}`);
  check('eelhear', 'investigator reaches the spot, then searches, then resumes patrol', out.searchN > 0 && out.searchThenPatrol === out.searchN, { arriveAt: out.arrive.map((x) => +x.toFixed(1)), resumed: `${out.searchThenPatrol}/${out.searchN}` });
}

/* --------------------------- 6. eel swim noise / chase --------------------------- */
if (wanted('eelchase')) {
  const r = { fastChase: 0, fastN: 0, slowChase: 0, slowN: 0, dashChase: 0, dashN: 0, loseT: [], backToPatrol: 0, lostN: 0 };
  for (const [speed, R, key] of [[172, 100, 'fast'], [100, 100, 'slow'], [172, 160, 'fast2']]) {
    for (let s = 0; s < SEEDS; s++) {
      const g = scene('c' + s + key, 7, { god: true });
      const room = bigRoom(g, 34);
      const sp = spotNear(g, room.x, room.y, R - 3, R + 3, { los: true, clear: 22, losR: 10 });
      if (!sp) continue;
      const e = add(g, 'eel', sp.x, sp.y);
      put(g, room.x, room.y);
      // the player swims at constant speed in place (perpendicular drift is fine): feed velocity directly
      const ux = (room.x - sp.x), uy = (room.y - sp.y), um = Math.hypot(ux, uy);
      g.player.vx = ux / um * speed; g.player.vy = uy / um * speed;
      g.bot = () => ({ mx: ux / um * (speed / 172), my: uy / um * (speed / 172), ping: false, dash: false, buoy: false });
      let chased = false;
      run(g, 0.5, () => { if (e.state === 'chase') { chased = true; return false; } });
      if (key === 'fast') { r.fastN++; if (chased) r.fastChase++; }
      if (key === 'slow') { r.slowN++; if (chased) r.slowChase++; }
      if (key === 'fast2') { r.dashN++; if (chased) r.dashChase++; }
    }
  }
  // trail loss: make the eel chase, then the player goes silent far from it
  for (let s = 0; s < SEEDS; s++) {
    const g = scene('c2' + s, 7, { god: true });
    const room = bigRoom(g, 34);
    const sp = spotNear(g, room.x, room.y, 600, 660, { los: false, clear: 22 }); if (!sp) continue;
    const e = add(g, 'eel', sp.x, sp.y);
    put(g, room.x, room.y);
    e.startChase(g, 3.0);
    let tChaseEnd = -1, tPatrol = -1, hx = 0, hy = 0, wp = [], lastWp = null;
    // the player is frozen (silent) far away; the eel is alerted for 3 s only
    run(g, 60, (t) => {
      if (tChaseEnd < 0 && e.state !== 'chase') { tChaseEnd = t; hx = e.hotX; hy = e.hotY; }
      if (tChaseEnd >= 0 && e.state === 'patrol') { if (tPatrol < 0) tPatrol = t; if (!lastWp || Math.hypot(e.tx - lastWp.x, e.ty - lastWp.y) > 1) { lastWp = { x: e.tx, y: e.ty }; wp.push(Math.hypot(e.tx - hx, e.ty - hy)); } if (wp.length >= 4) return false; }
    });
    r.loseT.push(tChaseEnd); r.lostN++; if (tPatrol >= 0) r.backToPatrol++;
    (r.wp = r.wp || []).push(wp.slice(0, 3).map(Math.round));
  }
  check('eelchase', 'swimming at max speed 100 px away -> chase', r.fastChase === r.fastN, `${r.fastChase}/${r.fastN}`);
  check('eelchase', 'drifting slowly (100 px/s) 100 px away -> no chase', r.slowChase === 0, `${r.slowChase}/${r.slowN}`);
  check('eelchase', 'swimming at max speed 160 px away -> no chase (informational)', true, `${r.dashChase}/${r.dashN} chased`);
  const nearHot = (r.wp || []).filter((w) => w.length >= 2).every((w) => w[0] <= 330 && w[1] <= 330);
  check('eelchase', 'after losing a chase the eel combs the area (next two waypoints within 330 px of the chase)', (r.wp || []).length && nearHot, r.wp);
  check('eelchase', 'eel loses the trail ~3 s after the noise stops (2.5..9 s incl. closing in) and resumes patrol', r.loseT.length && r.loseT.every((x) => x >= 0 && x <= 9) && r.backToPatrol === r.lostN, { loseAfter: r.loseT.map((x) => +x.toFixed(1)), resumed: `${r.backToPatrol}/${r.lostN}` });
}

/* --------------------------- 7. decoys --------------------------- */
if (wanted('decoy')) {
  const res = { eelArr: [], eelN: 0, eelOk: 0, jellyOk: 0, jellyN: 0, jellyHold: [], eelHold: [] };
  for (let s = 0; s < SEEDS; s++) {
    const g = scene('d' + s, 7, { ghost: true });
    const room = bigRoom(g, 34);
    const b = { x: room.x, y: room.y, life: 7, beep: 0.05, seen: 0, phase: 0, type: 'buoy' };
    g.buoys.push(b);
    const se = spotNear(g, room.x, room.y, 230, 270, { los: false, clear: 24 });
    const sj = spotNear(g, room.x, room.y, 120, 160, { los: true, clear: 26 });
    if (!se || !sj) continue;
    const e = add(g, 'eel', se.x, se.y), j = add(g, 'jelly', sj.x, sj.y);
    let tArr = -1, jArr = -1, eNear = 0, jNear = 0;
    run(g, 7, (t) => {
      if (tArr < 0 && Math.hypot(e.x - b.x, e.y - b.y) < 70) tArr = t;
      if (jArr < 0 && Math.hypot(j.x - b.x, j.y - b.y) < 60) jArr = t;
      if (Math.hypot(e.x - b.x, e.y - b.y) < 110) eNear++; if (Math.hypot(j.x - b.x, j.y - b.y) < 110) jNear++;
    });
    res.eelN++; if (tArr >= 0) { res.eelOk++; res.eelArr.push(tArr); }
    res.jellyN++; if (jArr >= 0) res.jellyOk++;
    res.eelHold.push(eNear / 60); res.jellyHold.push(jNear / 60);
  }
  check('decoy', 'eel 250 px away is lured to the buoy (<70 px) within its lifetime', res.eelOk === res.eelN, { arrived: `${res.eelOk}/${res.eelN}`, at: res.eelArr.map((x) => +x.toFixed(1)) });
  check('decoy', 'jelly 140 px away is lured to the buoy (<60 px)', res.jellyOk === res.jellyN, `${res.jellyOk}/${res.jellyN}`);
  check('decoy', 'eel lingers around the buoy (>=1.5 s within 110 px)', mean(res.eelHold) >= 1.5, { meanSecNear: +mean(res.eelHold).toFixed(1) });
}

/* --------------------------- 8. leviathan --------------------------- */
if (wanted('leviathan')) {
  const inReg = [], minHead = [], minCircle = [], badCirc = [], spineRock = [], cov = [], stuck = [], st = {}, maxSp = [];
  for (let s = 0; s < Math.max(2, SEEDS - 1); s++) {
    const g = scene('l' + s, 12, { ghost: true });
    const sp = g.lv.spawns.leviathan;
    if (!sp) { check('leviathan', 'spawn exists', false, 's' + s); continue; }
    const e = add(g, 'leviathan', sp.x, sp.y);
    const lv = g.lv, region = new Set(lv.xlCells);
    let out = 0, ticks = 0, mh = 1e9, mc = 1e9, bc = 0, sr = 0, wx = e.x, wy = e.y, wt = 0, lpx = e.x, lpy = e.y, trav = 0, stk = 0, mx = 0;
    const blocks = new Set(), bw = 6;
    run(g, 300, (t) => {
      ticks++;
      const c = W.cellOf(lv, e.x, e.y);
      if (!region.has(c)) out++;
      blocks.add(((e.x / 16 / bw) | 0) + ',' + ((e.y / 16 / bw) | 0));
      mh = Math.min(mh, W.sdfAt(lv, e.x, e.y));
      const cs = e.circles();
      if (cs.length !== e.hitIdx.length) bc++;
      for (let k = 0; k < cs.length; k++) { const q = e.spine[e.hitIdx[k][0]]; if (Math.hypot(cs[k].x - q.x, cs[k].y - q.y) > 0.01) bc++; mc = Math.min(mc, W.sdfAt(lv, cs[k].x, cs[k].y) + 0); }
      sr += inRock(g, e) ? 1 : 0;
      st[e.state] = (st[e.state] || 0) + 1;
      mx = Math.max(mx, Math.hypot(e.vx, e.vy));
      trav += Math.hypot(e.x - lpx, e.y - lpy); lpx = e.x; lpy = e.y;
      if (t - wt >= 15) { if (Math.hypot(e.x - wx, e.y - wy) < 20 && trav < 150 && e.state === 'patrol') stk++; wx = e.x; wy = e.y; wt = t; trav = 0; }
    });
    inReg.push(out / ticks); minHead.push(mh); minCircle.push(mc); badCirc.push(bc); spineRock.push(sr); cov.push(blocks.size); stuck.push(stk); maxSp.push(mx);
  }
  check('leviathan', 'roams only its XL region (head)', inReg.every((x) => x < 0.02), inReg.map((x) => +x.toFixed(3)));
  check('leviathan', 'head never in rock; collision circles keep >= -4 px of the wall', Math.min(...minHead) > 0 && Math.min(...minCircle) > -4, { head: minHead.map((x) => Math.round(x)), circle: minCircle.map((x) => Math.round(x)) });
  check('leviathan', 'circles() consistent with spine', badCirc.every((x) => x === 0), badCirc);
  check('leviathan', 'no spine node inside rock', spineRock.every((x) => x === 0), spineRock);
  check('leviathan', 'covers area & never stuck', stuck.every((x) => x === 0) && Math.min(...cov) >= 6, { blocks: cov, stuck });
  check('leviathan', 'speed sane (max <= 160)', Math.max(...maxSp) <= 160, maxSp.map((x) => Math.round(x)));
  // chase
  const g = scene('lc', 12, { god: true });
  const sp = g.lv.spawns.leviathan; const e = add(g, 'leviathan', sp.x, sp.y);
  const room = { x: sp.x, y: sp.y };
  const pp = spotNear(g, sp.x, sp.y, 85, 115, { los: true, clear: 40, losR: 10 });
  if (pp) {
    put(g, pp.x, pp.y);
    const ux = pp.x - sp.x, uy = pp.y - sp.y, um = Math.hypot(ux, uy);
    g.player.vx = ux / um * 172; g.player.vy = uy / um * 172;
    g.bot = () => ({ mx: ux / um, my: uy / um, ping: false, dash: false, buoy: false });
    let ch = false; run(g, 1, () => { if (e.state === 'chase') { ch = true; return false; } });
    check('leviathan', 'chases loud swimming 100 px away', ch, e.state);
  }
}

/* --------------------------- 9. afterBite / chain-kill --------------------------- */
if (wanted('afterbite')) {
  const counted = (g) => { const ts = []; const oh = g.hurt.bind(g); g.hurt = (...a) => { const h = g.player.hull; oh(...a); if (g.player.hull < h) ts.push(+g.time.toFixed(2)); }; return ts; };
  for (const type of ['eel', 'angler', 'leviathan']) {
    const depth = type === 'leviathan' ? 12 : 7;
    const frozen = [], flee = [], deaths = [];
    for (let s = 0; s < SEEDS * 2; s++) {
      // (a) a frozen player next to the creature
      {
        const g = scene('b' + s + type, depth, { god: false });
        const room = bigRoom(g, type === 'leviathan' ? 42 : 34);
        const sp = type === 'angler' ? spotNear(g, room.x, room.y, 55, 70, { los: true, clear: 24, losR: 10 }) : spotNear(g, room.x, room.y, type === 'leviathan' ? 190 : 150, type === 'leviathan' ? 230 : 190, { los: true, clear: type === 'leviathan' ? 40 : 24, losR: 10 });
        if (sp) {
          put(g, room.x, room.y);
          let e;
          if (type === 'angler') e = add(g, 'angler', sp.x, sp.y, Math.atan2(room.y - sp.y, room.x - sp.x));
          else { e = add(g, type, sp.x, sp.y); e.startChase(g, 3); }
          const ts = counted(g);
          run(g, 10, () => g.state === 'play');
          frozen.push(ts); deaths.push(g.state !== 'play');
        }
      }
      // (b) the player runs along the route; the creature starts right behind it
      {
        const g = scene('bf' + s + type, depth, { god: false });
        const lv = g.lv, nf = new W.NavField(lv); nf.compute(lv, type === 'leviathan' ? 'XL' : 'S', lv.exit.x, lv.exit.y);
        const nfp = new W.NavField(lv); nfp.compute(lv, 'S', lv.exit.x, lv.exit.y);
        const d = { x: 0, y: 0 };
        let spot = null;
        // a point on the way to the exit with the creature just behind
        for (let tries = 0; tries < 400 && !spot; tries++) {
          const c = Math.floor(rnd() * lv.gw * lv.gh);
          if (lv.startDist[c] < 30 || lv.clear[c] < (type === 'leviathan' ? 45 : 26) || nfp.dist[c] < 25) continue;
          const x = (c % lv.gw + 0.5) * 16, y = (((c / lv.gw) | 0) + 0.5) * 16;
          nfp.dir(lv, x, y, d); const bx = x - d.x * (type === 'leviathan' ? 75 : 50), by = y - d.y * (type === 'leviathan' ? 75 : 50);
          if (W.sdfAt(lv, bx, by) < (type === 'leviathan' ? 40 : 20) || !W.lineClear(lv, bx, by, x, y, 6)) continue;
          spot = { x, y, bx, by };
        }
        if (spot) {
          put(g, spot.x, spot.y);
          let e;
          if (type === 'angler') e = add(g, 'angler', spot.bx, spot.by, Math.atan2(spot.y - spot.by, spot.x - spot.bx));
          else { e = add(g, type, spot.bx, spot.by); e.startChase(g, 3); }
          g.bot = (gg) => { const p = gg.player; const ok = nfp.dir(lv, p.x, p.y, d); return { mx: ok ? d.x : 0, my: ok ? d.y : 0, ping: false, dash: false, buoy: false }; };
          const ts = counted(g);
          run(g, 8, () => g.state === 'play');
          flee.push(ts);
        }
      }
    }
    const gaps = frozen.filter((a) => a.length > 1).map((a) => a[1] - a[0]);
    check('afterbite', `${type}: second bite on a frozen player no sooner than 1.8 s after the first`, gaps.every((x) => x >= 1.79), { gaps: gaps.map((x) => +x.toFixed(1)), bitesPerRun: frozen.map((a) => a.length) });
    if (type !== 'angler') check('afterbite', `${type}: a frozen player gets an escape window (>= 3.5 s between bites, never 3 bites in 10 s)`, gaps.every((x) => x >= 3.5) && frozen.every((a) => a.length <= 2), { gaps: gaps.map((x) => +x.toFixed(1)), bitesPerRun: frozen.map((a) => a.length), died: deaths.filter(Boolean).length });
    check('afterbite', `${type}: running away along the route after a bite: at most 1 bite in 8 s`, flee.every((a) => a.length <= 1), { bitesPerRun: flee.map((a) => a.length) });
  }
}

/* --------------------------- 10. nav cost --------------------------- */
if (wanted('navcost')) {
  const g = scene('n', 12, { god: true });
  const lv = g.lv, nf = new W.NavField(lv);
  const t0 = performance.now(); const N = 200;
  for (let i = 0; i < N; i++) nf.compute(lv, 'S', lv.exit.x, lv.exit.y);
  const per = (performance.now() - t0) / N;
  check('navcost', 'full-map BFS flow-field (informational)', true, { ms: +per.toFixed(3), cells: lv.gw * lv.gh });
  // the recompute an eel does 4x a second while chasing (flow field rooted at the player, 250-450 px away)
  const room = bigRoom(g, 34), sp = spotNear(g, room.x, room.y, 250, 450, { los: false, clear: 24 });
  const e = add(g, 'eel', sp.x, sp.y); put(g, room.x, room.y); g.update(1 / 60);
  const t1 = performance.now(); for (let i = 0; i < N; i++) { e.tx = room.x; e.ty = room.y; e.computeNav(g); }
  const per2 = (performance.now() - t1) / N;
  check('navcost', 'eel chase recompute is cheap (< 1 ms; the original full-map flood is ~2.5 ms)', per2 < 1.0, { ms: +per2.toFixed(3) });
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
if (bad.length) console.log('FAILED:\n' + bad.map((r) => ' - [' + r.scn + '] ' + r.name).join('\n'));
const jf = opt('json', '');
if (jf) fs.writeFileSync(jf, JSON.stringify(results, null, 1));
