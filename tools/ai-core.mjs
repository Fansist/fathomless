// Engine-agnostic simulation core for creature-AI + balance testing.
// Runs identically in Node (stubbed DOM) and inside the game page (puppeteer), because it only
// touches the game through the modules handed to it. Deterministic: Math.random is re-seeded per run.
//
// Pilots (bots): all follow a cost-weighted shortest path to the exit.
//   naive   runs at full speed, pings every 2 s (alternating tap / full charge), no decoys or dashes.
//   careful models a good human with ground-truth creature positions: drifts (<70 px/s) near hunters, taps instead of
//           full pings near hunters / anglers / jellies, drops a decoy and backs off from an investigating eel, dashes
//           away from a chase or from an angler's wind-up, detours around creatures, picks up pearls and patches.
//   fog     careful, but only knows what a human could have noticed (sonar echoes for ~4.6 s, the lure glow, the
//           click of a hunting eel): a pessimistic human.
//   spam    naive that fires a full-power ping the moment it can (energy-economy probe).
//
//   const M = await loadModules(prefix)   // prefix: 'file:///.../js/' (node) or '/js/' (page)
//   const res = simulateLevel(M, { kind:'careful', seed:'s1', depth:6 })

export async function loadModules(prefix) {
  const names = ['game', 'world', 'config', 'entities', 'sonar', 'rng'];
  const mods = await Promise.all(names.map((n) => import(prefix + n + '.js')));
  const M = {};
  names.forEach((n, i) => { M[n] = mods[i]; });
  // AI_TUNE='{"eel":{"moveHear":1.5},"lev":{...},"player":{...},"ping":{...}}' overrides tunables for parameter sweeps
  const env = typeof process !== 'undefined' && process.env && process.env.AI_TUNE;
  if (env) {
    const t = JSON.parse(env);
    Object.assign(M.entities.EEL_CFG, t.eel || {}); Object.assign(M.entities.LEVIATHAN_CFG, t.lev || {});
    Object.assign(M.config.PLAYER, t.player || {}); Object.assign(M.config.PING, t.ping || {});
  }
  return M;
}

/* ------------------------------------------------------------------ */
/* determinism + stubs                                                 */
/* ------------------------------------------------------------------ */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function seedMath(label) { Math.random = mulberry(hashStr(label)); }

const noop = () => {};
function stub(extra = {}) {
  return new Proxy(extra, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
}
// OPTIONAL game.js tweak (AI_PATCH=1): creatures that are backing off after a bite (e.passive) are skipped by
// checkCollisions and afterBite(e) hands over to e.bitten(g). Off by default: the simulations then measure the game
// exactly as game.js has it (its own afterBite/calm logic + the creatures' own justBit() fallbacks).
export const GAME_PATCH = !!(typeof process !== 'undefined' && process.env && process.env.AI_PATCH);
export function makeGame(M, o = {}) {
  const audio = stub({ ok: false });
  const ui = stub();
  const input = stub({ moveX: 0, moveY: 0, pingHeld: false, pressed: () => false });
  const g = new M.game.Game({ input, audio, ui, settings: { shake: false, hints: false, bloom: false, reduceFlash: false } });
  if (o.patch !== undefined ? o.patch : GAME_PATCH) patchGame(g);
  return g;
}
export function patchGame(g) {
  g.checkCollisions = function () {
    const p = this.player;
    if (p.dead) return;
    for (const e of this.enemies) {
      if (e.passive) continue;
      const cs = e.circles();
      for (let k = 0; k < cs.length; k++) {
        const c = cs[k];
        if (Math.hypot(c.x - p.x, c.y - p.y) < c.r + p.r * 0.85) {
          const was = p.invul > 0;
          this.hurt(e.damage, c.x, c.y, e);
          if (!was && p.invul > 0) this.afterBite(e);
          break;
        }
      }
    }
  };
  g.afterBite = function (e) { if (e.bitten) e.bitten(this); };
  return g;
}

/* ------------------------------------------------------------------ */
/* Loadouts: a plausible set of upgrades for a run that reached depth d */
/* ------------------------------------------------------------------ */
const PRIORITY = ['fins', 'cell', 'hull', 'decoy', 'lens', 'burst', 'memory', 'dowse', 'capacitor'];
export function applyLoadout(M, g, depth, seed) {
  const { RNG } = M.rng, { pickUpgrades, computeStats } = M.config;
  const ups = {};
  const rng = new RNG(seed + ':ai:' + 1);
  for (let d = 1; d < depth; d++) {
    const choices = pickUpgrades(rng.sub('up' + d), ups, 3);
    if (!choices.length) break;
    let best = choices[0], bi = 99;
    for (const c of choices) { const i = PRIORITY.indexOf(c.id); if (i >= 0 && i < bi) { bi = i; best = c; } }
    ups[best.id] = (ups[best.id] || 0) + 1;
  }
  g.run.ups = ups;
  g.stats = computeStats(ups);
  g.player.buoys = 2 + (ups.decoy || 0) * 2;
  return ups;
}
export function pickChoice(choices) {
  let best = choices[0], bi = 99;
  for (const c of choices) { const i = PRIORITY.indexOf(c.id); if (i >= 0 && i < bi) { bi = i; best = c; } }
  return best;
}

/* ------------------------------------------------------------------ */
/* Cost-field path planner (Dijkstra on the coarse nav grid)           */
/* ------------------------------------------------------------------ */
class Heap {
  constructor(n) { this.k = new Float64Array(n); this.v = new Int32Array(n); this.n = 0; }
  push(key, val) {
    let i = this.n++; const k = this.k, v = this.v;
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], key = k[--this.n];
    const val = v[this.n]; let i = 0;
    for (;;) {
      let c = 2 * i + 1; if (c >= this.n) break;
      if (c + 1 < this.n && k[c + 1] < k[c]) c++;
      if (k[c] >= key) break;
      k[i] = k[c]; v[i] = v[c]; i = c;
    }
    k[i] = key; v[i] = val;
    return top;
  }
}
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

function costField(lv, W, tx, ty, extra, out, heap) {
  const gw = lv.gw, gh = lv.gh, nav = lv.nav.S;
  out.fill(-1);
  let c0 = W.cellOf(lv, tx, ty);
  if (!nav[c0]) {
    let best = -1, bd = 1e9;
    const cx = c0 % gw, cy = (c0 / gw) | 0;
    for (let r = 1; r < 8 && best < 0; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
      const m = y * gw + x; if (nav[m] && dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = m; }
    }
    if (best < 0) return false;
    c0 = best;
  }
  heap.n = 0; out[c0] = 0; heap.push(0, c0);
  while (heap.n) {
    const c = heap.pop();
    const x = c % gw, y = (c / gw) | 0, dc = out[c];
    for (let k = 0; k < 8; k++) {
      const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const m = ny * gw + nx;
      if (!nav[m]) continue;
      if (k >= 4 && !(nav[y * gw + nx] && nav[ny * gw + x])) continue;
      const nd = dc + (k < 4 ? 4 : 5.66) + (extra ? extra[m] : 0);
      if (out[m] < 0 || nd < out[m] - 1e-6) { out[m] = nd; heap.push(nd, m); }
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Pilots (bots)                                                        */
/* ------------------------------------------------------------------ */
const TAP_FRAMES = 6;      // ~0.1 s hold -> power ~0.1 (below eel minPower)
const bodyDist = (e, p) => { let d = 1e9; for (const c of e.circles()) d = Math.min(d, Math.hypot(c.x - p.x, c.y - p.y) - c.r); return d; };

export class Pilot {
  constructor(kind, M, g) {
    this.kind = kind; this.M = M; this.W = M.world; this.C = M.config; this.g = g;
    this.fog = kind === 'fog';                 // like 'careful' but only knows what sonar / sound has told it (a pessimistic human)
    this.careful = kind === 'careful' || this.fog;
    this.spam = kind === 'spam';
    this.px = new Map(); this.visL = []; this.visF = -1;
    this.lv = null; this.f = 0;
    this.out = { mx: 0, my: 0, ping: false, dash: false, buoy: false };
    this.d = { x: 0, y: 0 }; this.d2 = { x: 0, y: 0 };
    this.pingT = 1.2; this.pingHold = 0; this.pingTarget = 0; this.pingFull = false; this.nextFull = false;
    this.buoyCd = 0; this.waited = 0; this.waitState = 'go'; this.stats = { waits: 0, dashes: 0, buoys: 0, denied: 0, retreatTicks: 0, stuckTicks: 0 };
    this.lastPos = { x: 0, y: 0 }; this.progT = 0; this.unstick = 0;
    this.awayDist = null;
  }

  // the creatures this pilot knows about. 'careful' knows everything; 'fog' only what a human could have noticed
  vis(g) {
    if (!this.fog) return g.enemies;
    if (this.visF === this.f) return this.visL;
    this.visF = this.f;
    const out = this.visL; out.length = 0;
    const p = g.player, life = 4.6 * g.stats.ghostLife, t = g.time;
    for (const e of g.enemies) {
      const d = Math.hypot(e.x - p.x, e.y - p.y), hunter = e.type === 'eel' || e.type === 'leviathan';
      let x = e.x, y = e.y, state = 'patrol', known = false;
      if (e.type === 'urchin') known = e.seen > -900 || d < 90;
      else if (e.type === 'angler') { const l = e.lure(); known = e.seen > -900 || Math.hypot(l.x - p.x, l.y - p.y) < 600; state = e.state; }
      else if (hunter && (e.state === 'chase' || e.state === 'investigate' || e.state === 'recoil') && d < 900) { known = true; state = e.state; }   // it clicks while hunting
      else if (hunter && (e.state === 'patrol' || e.state === 'search') && d < 340) { known = true; state = 'patrol'; }               // ...and ticks faintly while patrolling
      else if (t >= e.seen && t - e.seen < life) { known = true; x = e.sx; y = e.sy; }
      if (!known) continue;
      let q = this.px.get(e);
      if (!q) { q = { type: e.type, state, x, y, r: e.r, timer: 0, cs: [{ x, y, r: e.r * (hunter ? 1.25 : 1) }], circles() { return this.cs; } }; this.px.set(e, q); }
      q.x = x; q.y = y; q.state = state; q.timer = e.timer || 0; q.cs[0].x = x; q.cs[0].y = y;
      out.push(q);
    }
    return out;
  }

  prepare(g) {
    const lv = this.lv = g.lv, n = lv.gw * lv.gh;
    this.n = n;
    this.heap = new Heap(n * 8 + 8);
    this.dist = new Float32Array(n);
    this.staticExtra = new Float32Array(n);
    this.extra = new Float32Array(n);
    this.eDist = new Int16Array(n); this.eQueue = new Int32Array(n);
    // urchins are static: make cells near them expensive (soft, so a path always exists)
    for (const e of this.vis(g)) {
      if (e.type !== 'urchin') continue;
      this.addDisc(this.staticExtra, e.x, e.y, 46, 60);
    }
    this.refresh(g, true);
    this.lastPos.x = g.player.x; this.lastPos.y = g.player.y; this.progT = 0;
    this.pingT = 1.2; this.pingHold = 0; this.waited = 0; this.waitState = 'go';
  }

  addDisc(arr, x, y, rad, peak) {
    const lv = this.lv, gw = lv.gw, gh = lv.gh;
    const x0 = Math.max(0, Math.floor((x - rad) / 16)), x1 = Math.min(gw - 1, Math.floor((x + rad) / 16));
    const y0 = Math.max(0, Math.floor((y - rad) / 16)), y1 = Math.min(gh - 1, Math.floor((y + rad) / 16));
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const d = Math.hypot((cx + 0.5) * 16 - x, (cy + 0.5) * 16 - y);
      if (d < rad) arr[cy * gw + cx] += peak * (1 - d / rad);
    }
  }

  refresh(g, force) {
    const lv = this.lv;
    this.extra.set(this.staticExtra);
    if (this.careful) {
      for (const e of this.vis(g)) {
        if (e.type === 'angler') { if (e.state === 'recover') this.addDisc(this.extra, e.x, e.y, 75, 70); else this.addDisc(this.extra, e.x, e.y, 190, 90); }   // while it is busy recovering the way past is open, at a respectful distance
        else if (e.type === 'eel') this.addDisc(this.extra, e.x, e.y, 210, 70);
        else if (e.type === 'leviathan') this.addDisc(this.extra, e.x, e.y, 300, 90);
        else if (e.type === 'jelly') this.addDisc(this.extra, e.x, e.y, 80, 40);
        else if (e.type === 'urchin' && this.fog) this.addDisc(this.extra, e.x, e.y, 46, 60);
      }
    }
    costField(lv, this.W, lv.exit.x, lv.exit.y, this.extra, this.dist, this.heap);
  }

  flow(x, y, out) { return this.W.flowDir(this.lv, 'S', this.dist, x, y, this.lv.exit.x, this.lv.exit.y, out); }

  // is the route ahead (next ~L px) close to this hunter?
  routeNear(e, p, L, r) {
    let x = p.x, y = p.y;
    const d = this.d2;
    for (let s = 0; s < L; s += 18) {
      if (!this.flow(x, y, d)) return false;
      x += d.x * 18; y += d.y * 18;
      if (bodyDist(e, { x, y }) < r) return true;
    }
    return false;
  }

  awayStep(e, p, out) {
    // BFS distance from the hunter, then climb it
    const W = this.W, lv = this.lv;
    W.bfsNav(lv, 'S', e.x, e.y, this.eDist, this.eQueue);
    const gw = lv.gw, gh = lv.gh, c = W.cellOf(lv, p.x, p.y);
    const cx = c % gw, cy = (c / gw) | 0;
    let best = -1, bv = this.eDist[c];
    for (let k = 0; k < 8; k++) {
      const nx = cx + DIRS[k][0], ny = cy + DIRS[k][1];
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const m = ny * gw + nx, v = this.eDist[m];
      if (v < 0 || !lv.nav.S[m]) continue;
      if (k >= 4 && !(lv.nav.S[cy * gw + nx] && lv.nav.S[ny * gw + cx])) continue;
      if (v > bv) { bv = v; best = m; }
    }
    if (best < 0) {
      // dead end (or unreachable from hunter): just move directly away
      const dx = p.x - e.x, dy = p.y - e.y, m = Math.hypot(dx, dy) || 1;
      out.x = dx / m; out.y = dy / m; return false;
    }
    const tx = (best % gw + 0.5) * 16, ty = (((best / gw) | 0) + 0.5) * 16;
    const dx = tx - p.x, dy = ty - p.y, m = Math.hypot(dx, dy) || 1;
    out.x = dx / m; out.y = dy / m; return true;
  }

  control(g) {
    if (g.lv !== this.lv) this.prepare(g);
    const p = g.player, o = this.out, st = g.stats, W = this.W, C = this.C;
    const dt = 1 / 60;
    this.f++;
    o.dash = false; o.buoy = false;
    this.buoyCd -= dt;
    const needRefresh = this.careful ? this.f % 20 === 0 : this.f % 120 === 0;
    if (needRefresh) this.refresh(g, false);

    /* ---- threat scan ---- */
    let nearAny = 1e9, nearHunter = null, nhd = 1e9, nearAngler = 1e9, nearJelly = 1e9, lungeAn = null;
    for (const e of this.vis(g)) {
      if (e.type === 'urchin') continue;
      const d = bodyDist(e, p);
      if (e.type === 'jelly') { if (d < nearJelly) nearJelly = d; continue; }   // jellies only hear pings and decoys, never swimming
      if (e.type === 'angler' && d < 260 && ((e.state === 'aim' && e.timer <= 0.12) || (e.state === 'lunge' && e.timer < 0.5))) lungeAn = e;   // ~0.18 s human reaction to the wind-up
      if (d < nearAny) nearAny = d;
      if (e.type === 'eel' || e.type === 'leviathan') { if (d < nhd) { nhd = d; nearHunter = e; } }
      if (e.type === 'angler' && d < nearAngler) nearAngler = d;
    }

    /* ---- base direction: path with urchin avoidance ---- */
    let dx = 0, dy = 0;
    const ok = this.flow(p.x, p.y, this.d);
    if (ok) { dx = this.d.x; dy = this.d.y; }
    // local urchin steering
    for (const e of this.vis(g)) {
      if (e.type !== 'urchin') continue;
      const ux = e.x - p.x, uy = e.y - p.y, ud = Math.hypot(ux, uy);
      if (ud > 62) continue;
      const along = (dx * ux + dy * uy) / (ud || 1);
      if (along > -0.2) {
        const cross = dx * uy - dy * ux;           // >0: urchin is counter-clockwise of our heading
        const k = (1 - ud / 62) * 2.2;
        const px = cross > 0 ? dy : -dy, py = cross > 0 ? -dx : dx; // perpendicular pointing away from it
        dx += px * k; dy += py * k;
      }
      const rep = Math.max(0, (36 - ud) / 36) * 2.5;
      dx -= (ux / (ud || 1)) * rep; dy -= (uy / (ud || 1)) * rep;
    }
    if (this.careful && nearJelly < 90) {
      for (const e of this.vis(g)) {
        if (e.type !== 'jelly') continue;
        const ux = e.x - p.x, uy = e.y - p.y, ud = Math.hypot(ux, uy) || 1;
        if (ud > 95) continue;
        const along = (dx * ux + dy * uy) / ud;
        const cross = dx * uy - dy * ux;
        const k = (1 - ud / 95) * 2.4;
        const px = cross > 0 ? dy : -dy, py = cross > 0 ? -dx : dx;
        if (along > -0.3) { dx += px * k; dy += py * k; }
        dx -= (ux / ud) * Math.max(0, (70 - ud) / 70) * 2.0; dy -= (uy / ud) * Math.max(0, (70 - ud) / 70) * 2.0;
      }
    }
    let m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
    let speed = 1;
    if (this.careful && lungeAn) {
      // an angler is striking: dash straight away from it, then keep backing off until it has spent its lunge
      if (p.dashCd <= 0 && p.energy >= st.dashCost + 1) { o.dash = true; this.stats.dashes++; }
      this.fleeFrom = lungeAn; this.fleeUntil = this.f + 50;
    }
    if (this.careful && this.fleeFrom && this.f < this.fleeUntil) {
      const ax = p.x - this.fleeFrom.x, ay = p.y - this.fleeFrom.y, am = Math.hypot(ax, ay) || 1;
      dx = ax / am; dy = ay / am;
    }

    if (this.careful) {
      /* ---- quiet drift near anything alive ---- */
      if (nhd < 340) speed = Math.min(speed, 62 / 172);          // only hunters hear swimming; jellies and anglers do not

      /* ---- hunters ---- */
      if (nearHunter) {
        const e = nearHunter;
        const away = this.d2;
        if (e.state === 'chase' && nhd < 420) {
          // run, dash when it is on our heels
          this.awayStep(e, p, away);
          const toExit = ok ? 0.6 : 0;
          let fx = away.x + dx * toExit, fy = away.y + dy * toExit;
          // prefer the exit route if it does not run into the hunter
          if (ok && !this.routeNear(e, p, 150, 70)) { fx = dx; fy = dy; }
          m = Math.hypot(fx, fy) || 1; dx = fx / m; dy = fy / m; speed = 1;
          if (nhd < 120 && p.dashCd <= 0 && p.energy >= st.dashCost + 2) { o.dash = true; this.stats.dashes++; }
        } else if (e.state === 'investigate' && nhd < 460) {
          if (g.player.buoys > 0 && this.buoyCd <= 0 && nhd > 110) { o.buoy = true; this.buoyCd = 9; this.stats.buoys++; }
          this.awayStep(e, p, away); dx = away.x; dy = away.y; speed = Math.min(speed, 62 / 172);
          this.stats.retreatTicks++;
        } else if (nhd < 300 && this.routeNear(e, p, 260, 125) && this.waited < 40) {
          // an eel sits on our route: back off and let it pass
          this.awayStep(e, p, away); dx = away.x; dy = away.y; speed = Math.min(speed, 55 / 172);
          this.waited += dt; this.stats.retreatTicks++;
        }
        if (nhd > 420) this.waited = Math.max(0, this.waited - dt * 0.5);
      }
      /* ---- dash through an angler's zone is not modelled: the cost field routes around it ---- */
    }

    /* ---- pearls near the route (careful only) ---- */
    if (this.careful && nearAny > 300 && (!nearHunter || nhd > 400)) {
      let best = null, bd = 95;
      for (const pk of g.pickups) {
        if (pk.taken || (pk.type !== 'pearl' && pk.type !== 'buoy' && !(pk.type === 'patch' && p.hull < p.maxHull))) continue;
        const d = Math.hypot(pk.x - p.x, pk.y - p.y);
        if (d < bd && W.lineClear(this.lv, p.x, p.y, pk.x, pk.y, 10)) {
          // stay away from urchins
          let bad = false;
          for (const e of this.vis(g)) if ((e.type === 'urchin' || e.type === 'angler') && Math.hypot(e.x - pk.x, e.y - pk.y) < 70) bad = true;
          if (!bad) { bd = d; best = pk; }
        }
      }
      if (best) { const ux = best.x - p.x, uy = best.y - p.y, um = Math.hypot(ux, uy) || 1; dx = ux / um; dy = uy / um; }
    }

    /* ---- anti-stick: if no progress for 4 s, wiggle ---- */
    this.progT += dt;
    if (this.progT > 4) {
      const moved = Math.hypot(p.x - this.lastPos.x, p.y - this.lastPos.y);
      if (moved < 20 && speed > 0.5) { this.unstick = 1.2; this.stats.stuckTicks += 240; }
      this.lastPos.x = p.x; this.lastPos.y = p.y; this.progT = 0;
    }
    if (this.unstick > 0) { this.unstick -= dt; const a = Math.sin(this.f * 0.05) * 1.6; const c = Math.cos(a), s = Math.sin(a); const nx = dx * c - dy * s, ny = dx * s + dy * c; dx = nx; dy = ny; }

    o.mx = dx * speed; o.my = dy * speed;

    /* ---- sonar ---- */
    this.pingLogic(g, p, nearHunter, nhd, nearAny, nearAngler, nearJelly);
    return o;
  }

  pingLogic(g, p, nearHunter, nhd, nearAny, nearAngler, nearJelly) {
    const o = this.out, st = g.stats, C = this.C;
    const dt = 1 / 60;
    // currently holding
    if (this.pingHold > 0) {
      this.pingHold--;
      o.ping = this.pingHold > 0;
      return;
    }
    if (this.pingFull) {
      // hold until charged to the target (or energy cap), then release
      const maxP = Math.max(0, Math.min(1, (p.energy - C.PING.costMin) / (C.PING.costMax - C.PING.costMin)));
      const want = Math.min(this.pingTarget, maxP);
      if (p.charging && p.charge >= want - 1e-3) { this.pingFull = false; o.ping = false; return; }
      if (!p.charging && p.energy < C.PING.costMin) { this.pingFull = false; o.ping = false; this.stats.denied++; return; }
      // the press is ignored while the ping is cooling down: let go for a frame to make a fresh edge
      if (!p.charging) { this.holdWait = (this.holdWait || 0) + 1; if (this.holdWait > 12) { this.holdWait = 0; o.ping = false; return; } } else this.holdWait = 0;
      o.ping = true; return;
    }
    o.ping = false;
    this.pingT -= dt;
    if (this.pingT > 0) return;
    if (this.spam) {            // fires a full-power ping the moment it can
      this.pingT = 0.05; this.pingFull = true; this.pingTarget = 1; o.ping = true;
    } else if (this.careful) {
      this.pingT = 2.4;
      const quiet = (nearHunter && nhd < 750) || nearAngler < 420 || nearAny < 260 || nearJelly < 230;
      if (p.energy < 22 && !quiet) { this.pingT = 1.5; return; }
      if (quiet || p.energy < 45) { this.pingHold = TAP_FRAMES; o.ping = true; }
      else { this.pingFull = true; this.pingTarget = 0.55; o.ping = true; }
    } else {
      this.pingT = 2.0;
      if (p.energy < C.PING.costMin) this.stats.denied++;
      if (this.nextFull) { this.pingFull = true; this.pingTarget = 1; o.ping = true; }
      else { this.pingHold = TAP_FRAMES; o.ping = true; }
      this.nextFull = !this.nextFull;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Enemy health monitor                                                */
/* ------------------------------------------------------------------ */
const MOVING = new Set(['patrol', 'investigate', 'chase', 'attract']);
export class Health {
  constructor(M) { this.M = M; this.rec = new Map(); this.states = {}; this.nan = 0; this.rock = 0; this.clip = 0; this.spineRock = 0; this.minSdf = 1e9; this.stuck = []; this.chases = []; this.ticks = 0; this.maxSpeed = {}; }
  tick(g) {
    const W = this.M.world;
    const T = g.levelTime;
    this.ticks++;
    for (const e of g.enemies) {
      let r = this.rec.get(e);
      if (!r) { r = { x0: e.x, y0: e.y, t0: T, mov: 0, n: 0, chase0: null, fx: e.x, fy: e.y, lx: e.x, ly: e.y, trav: 0 }; this.rec.set(e, r); }
      if (!(Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.vx) && Number.isFinite(e.vy))) { this.nan++; continue; }
      const s = W.sdfAt(g.lv, e.x, e.y);
      if (s < this.minSdf) this.minSdf = s;
      if (s < 0) this.rock++;
      if (e.type !== 'urchin' && s < e.r * 0.5) this.clip++;
      if (e.spine) {
        let sr = 0;
        for (const q of e.spine) if (W.sdfAt(g.lv, q.x, q.y) < 0) sr++;
        if (sr) this.spineRock++;
      }
      const sp = Math.hypot(e.vx, e.vy);
      if (!(this.maxSpeed[e.type] > sp)) this.maxSpeed[e.type] = sp;
      const bucket = this.states[e.type] || (this.states[e.type] = {});
      bucket[e.state] = (bucket[e.state] || 0) + 1;
      if (e.type === 'eel' || e.type === 'leviathan') {
        if (e.state === 'chase') { if (r.chase0 == null) r.chase0 = T; }
        else if (r.chase0 != null) { this.chases.push({ type: e.type, dur: T - r.chase0 }); r.chase0 = null; }
      }
      // stuck windows (15 s): net displacement < 20 px AND hardly any distance swum (an out-and-back trip is not "stuck")
      r.trav += Math.hypot(e.x - r.lx, e.y - r.ly); r.lx = e.x; r.ly = e.y;
      r.n++; if (MOVING.has(e.state)) r.mov++;
      if (T - r.t0 >= 15) {
        const disp = Math.hypot(e.x - r.x0, e.y - r.y0);
        if (disp < 20 && r.trav < 150 && r.mov / r.n > 0.9 && e.type !== 'urchin') this.stuck.push({ type: e.type, state: e.state, x: Math.round(e.x), y: Math.round(e.y), t: Math.round(T), disp: Math.round(disp) });
        r.x0 = e.x; r.y0 = e.y; r.t0 = T; r.mov = 0; r.n = 0; r.trav = 0;
      }
    }
  }
  summary() {
    return { nan: this.nan, rockTicks: this.rock, clipTicks: this.clip, spineRockTicks: this.spineRock, minSdf: Math.round(this.minSdf * 10) / 10, stuck: this.stuck, chases: this.chases, states: this.states, maxSpeed: this.maxSpeed, ticks: this.ticks };
  }
}

/* ------------------------------------------------------------------ */
/* One level run                                                        */
/* ------------------------------------------------------------------ */
export function simulateLevel(M, o) {
  const { kind = 'careful', seed = 's1', depth = 1, maxT = 240, god = false, profile = false, loadout = true } = o;
  seedMath(kind + '|' + seed + '|' + depth);
  const g = o.game || makeGame(M);
  g.startRun({ seed });
  if (loadout) applyLoadout(M, g, depth, seed);
  g.loadLevel(depth);
  const p = g.player;
  p.hull = g.stats.maxHull;
  g.god = god;
  const lv = g.lv;
  const pilot = new Pilot(kind, M, g);
  g.bot = (gg) => pilot.control(gg);
  const mon = new Health(M);
  const res = {
    kind, seed, depth, outcome: 'timeout', t: 0, hits: 0, hitsBy: {}, deathBy: null, pings: 0, dashes: 0, buoys: 0, pearls: 0,
    starveSec: 0, lowEnergySec: 0, minEnergy: 100, route: lv.routeLength, ups: g.run.ups, enemies: {},
  };
  for (const e of g.enemies) res.enemies[e.type] = (res.enemies[e.type] || 0) + 1;
  const origHurt = g.hurt.bind(g);
  res.hitLog = [];
  g.hurt = function (dmg, sx, sy, e) {
    const before = p.hull;
    const st = e ? e.state : '?';
    const sp0 = Math.hypot(p.vx, p.vy) || 1; const ah0 = e ? ((e.x - p.x) * p.vx + (e.y - p.y) * p.vy) / (sp0 * (Math.hypot(e.x - p.x, e.y - p.y) || 1)) : 0;
    origHurt(dmg, sx, sy, e);
    if (p.hull < before) {
      const t = e ? e.type : '?';
      res.hits++; res.hitsBy[t] = (res.hitsBy[t] || 0) + 1;
      const k = t + ':' + st; res.hitsByState = res.hitsByState || {}; res.hitsByState[k] = (res.hitsByState[k] || 0) + 1;
      if (res.hitLog.length < 12) res.hitLog.push([Math.round(g.levelTime * 10) / 10, k, Math.round(sp0), +ah0.toFixed(2)]);
      if (p.hull <= 0) res.deathBy = t;
    }
  };
  let prof = null;
  if (profile) {
    prof = {};
    for (const e of g.enemies) {
      const orig = e.update.bind(e);
      e.update = function (gg, dt) { const t0 = performance.now(); orig(gg, dt); const dtm = performance.now() - t0; const b = prof[e.type] || (prof[e.type] = { n: 0, sum: 0, max: 0 }); b.n++; b.sum += dtm; if (dtm > b.max) b.max = dtm; };
    }
  }
  const maxSteps = Math.round(maxT * 60);
  let step = 0;
  for (; step < maxSteps; step++) {
    g.update(1 / 60);
    mon.tick(g);
    if (g.state === 'play') {
      if (p.energy < M.config.PING.costMin) res.starveSec += 1 / 60;
      if (p.energy < 25) res.lowEnergySec += 1 / 60;
      if (p.energy < res.minEnergy) res.minEnergy = p.energy;
    }
    if (g.state === 'levelend') { res.outcome = 'clear'; break; }
    if (g.state === 'dying' || g.state === 'gameover') { res.outcome = 'dead'; break; }
  }
  res.t = Math.round(step / 6) / 10;
  res.pings = g.run.pings; res.dashes = g.run.dashes; res.buoys = g.run.buoysUsed; res.pearls = g.run.pearls;
  res.health = mon.summary();
  res.pilot = pilot.stats;
  res.hull = p.hull;
  if (prof) res.prof = prof;
  if (res.outcome === 'dead' && !res.deathBy) res.deathBy = '?';
  delete g.hurt; g.bot = null;
  return res;
}

/* ------------------------------------------------------------------ */
/* Full campaign: depth 1 -> 12 with upgrade picks and hull carry-over  */
/* ------------------------------------------------------------------ */
export function simulateCampaign(M, o) {
  const { kind = 'careful', seed = 's1', maxLevelT = 300, endDepth = M.config.MAX_DEPTH } = o;
  seedMath('camp|' + kind + '|' + seed);
  const g = o.game || makeGame(M);
  g.startRun({ seed });
  const out = { kind, seed, levels: [], outcome: 'alive', depth: 1, totalT: 0 };
  let pilot = new Pilot(kind, M, g);
  g.bot = (gg) => pilot.control(gg);
  const origHurt = g.hurt.bind(g);
  let cur = null;
  const newLevel = () => { cur = { depth: g.run.depth, t: 0, hits: 0, hitsBy: {}, hullIn: g.player.hull, pings: g.run.pings, pearls: g.run.pearls }; out.levels.push(cur); };
  g.hurt = function (dmg, sx, sy, e) {
    const before = g.player.hull; const stB = e ? e.state : "?"; origHurt(dmg, sx, sy, e);
    if (g.player.hull < before && cur) { cur.hits++; const t = e ? e.type : '?'; cur.hitsBy[t] = (cur.hitsBy[t] || 0) + 1; const k = t + ':' + stB; out.hitState = out.hitState || {}; out.hitState[k] = (out.hitState[k] || 0) + 1; if (g.player.hull <= 0) { out.deathBy = t; out.deathState = k; out.deathDepth = g.run.depth; } }
  };
  newLevel();
  let lastLv = g.lv, lt = 0;
  for (let step = 0; step < 60 * 3600 * 2; step++) {
    g.update(1 / 60);
    lt += 1 / 60; cur.t = lt;
    if (g.state === 'upgrade') {
      cur.hullOut = g.player.hull;
      g.chooseUpgrade(pickChoice(g.upgradeChoices).id);
      newLevel(); lt = 0;
      if (g.run.depth > endDepth) break;
    } else if (g.state === 'dying' || g.state === 'gameover') { out.outcome = 'dead'; break; }
    else if (g.state === 'victory') { out.outcome = 'won'; break; }
    else if (g.state === 'levelend' && g.run.depth >= endDepth) { out.outcome = 'won'; cur.hullOut = g.player.hull; break; }
    else if (g.state === 'play' && lt > maxLevelT) { out.outcome = 'timeout'; break; }
  }
  out.depth = g.run.depth;
  out.totalT = out.levels.reduce((a, l) => a + l.t, 0);
  out.ups = g.run.ups;
  delete g.hurt; g.bot = null;
  return out;
}
