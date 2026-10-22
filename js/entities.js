// Creatures of the deep. Each hunts by sound; none of them can see you.
import { clamp, TAU, angleDiff, noise2 } from './rng.js';
import { moveBody, sdfAt, gradAt, lineClear, cellOf, rayMarch, flowDir } from './world.js';

const _d = { x: 0, y: 0 };
const _g = { x: 0, y: 0 };

function ease(e, tx, ty, k, dt) {
  const f = 1 - Math.exp(-k * dt);
  e.vx += (tx - e.vx) * f;
  e.vy += (ty - e.vy) * f;
}

function turnToward(angle, target, rate, dt) {
  return angle + clamp(angleDiff(angle, target), -rate * dt, rate * dt);
}

// A flow field (same public surface as world.js NavField: compute / dir / steps / valid) whose BFS can stop a few
// rings after it has reached the agent ("focus"): a chase or a lure only ever needs the cells nearer to the target
// than the agent, which is a small fraction of the map (2.5 ms -> 0.6 ms per recompute on the biggest cave).
const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
class FocusNav {
  constructor(lv) {
    this.dist = new Int16Array(lv.gw * lv.gh); this.queue = new Int32Array(lv.gw * lv.gh);
    this.tx = 0; this.ty = 0; this.valid = false; this.cls = 'S';
  }
  // returns false (and leaves the previous field untouched) when the target is out of reach for this size class
  compute(lv, cls, tx, ty, fx, fy) {
    const nav = lv.nav[cls], gw = lv.gw, gh = lv.gh, dist = this.dist, q = this.queue;
    let c0 = cellOf(lv, tx, ty);
    if (!nav[c0]) {      // nearest open cell within 8 rings (a crack too narrow for me: I go as close as I can)
      const cx = c0 % gw, cy = (c0 / gw) | 0;
      let best = -1, bd = 1e9;
      for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
        const m = y * gw + x;
        if (nav[m] && dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = m; }
      }
      c0 = best;
    }
    if (c0 < 0) return false;
    this.cls = cls; this.tx = tx; this.ty = ty;
    dist.fill(-1);
    const cf = fx === undefined ? -1 : cellOf(lv, fx, fy);     // no focus: flood the whole map
    let limit = 32000, qh = 0, qt = 0;
    q[qt++] = c0; dist[c0] = 0;
    while (qh < qt) {
      const c = q[qh++], dc = dist[c];
      if (c === cf && limit === 32000) limit = dc + 12;
      if (dc >= limit) break;
      const x = c % gw, y = (c / gw) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + NB[k][0], ny = y + NB[k][1];
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const m = ny * gw + nx;
        if (!nav[m] || dist[m] >= 0) continue;
        if (k >= 4 && !(nav[y * gw + nx] && nav[ny * gw + x])) continue;
        dist[m] = dc + 1; q[qt++] = m;
      }
    }
    this.valid = true;
    return true;
  }
  dir(lv, x, y, out) { return this.valid && flowDir(lv, this.cls, this.dist, x, y, this.tx, this.ty, out); }
  steps(lv, x, y) { return this.valid ? this.dist[cellOf(lv, x, y)] : -1; }
}

let NEXT_ID = 1;

class Enemy {
  constructor(type, x, y, r) {
    this.type = type;
    this.id = NEXT_ID++;
    this.x = x; this.y = y; this.vx = 0; this.vy = 0; this.r = r;
    // creatures are fully determined by the level seed (no Math.random): daily runs and the AI tests replay exactly
    const hs = (a, b) => { const v = Math.sin(x * a + y * b) * 43758.5453; return v - Math.floor(v); };
    this.angle = hs(12.9898, 78.233) * TAU;
    this.phase = hs(39.3468, 11.135) * TAU;
    this.nz = hs(26.651, 53.397) * 100;     // per-creature noise offset
    this.state = 'idle';
    this.damage = 1;
    this.seen = -999;           // game time of last sonar illumination
    this.sx = x; this.sy = y; this.sa = this.angle; this.sPhase = 0; this.sSpine = null;
    this.cs = [{ x, y, r }];
    this.nav = null;
    this.pInv = 99;             // last seen player invulnerability: a sudden jump means somebody bit the player
    this.passive = false;       // true while backing off after a bite: game.checkCollisions may skip a passive creature
  }
  circles() {
    const c = this.cs[0];
    c.x = this.x; c.y = this.y; c.r = this.r;
    return this.cs;
  }
  // distance from the player's hull to the nearest part of this body (px, negative = overlapping)
  gap(p) {
    let d = 1e9;
    for (const c of this.circles()) d = Math.min(d, Math.hypot(c.x - p.x, c.y - p.y) - c.r - p.r);
    return d;
  }
  // true on the frame after this creature has hurt the player
  justBit(p) {
    const hit = p.invul > this.pInv + 0.5 && this.gap(p) < 16;
    this.pInv = p.invul;
    return hit;
  }
  snapshot(t) {
    this.seen = t;
    this.sx = this.x; this.sy = this.y; this.sa = this.angle; this.sPhase = this.phase;
    if (this.spine) this.sSpine = this.spine.map((p) => ({ x: p.x, y: p.y }));
  }
  hear() {}
  bitten() {}       // game.afterBite(e) calls this on the creature that has just hurt the player
  update() {}
}

/* ------------------------------------------------------------------ */
/* Drifter: a translucent jelly that wanders and is lured by sound.     */
/* ------------------------------------------------------------------ */
export class Jelly extends Enemy {
  constructor(x, y) {
    super('jelly', x, y, 15);
    this.heading = this.angle;
    this.state = 'drift';
    this.tx = x; this.ty = y; this.attractT = 0; this.navT = 0; this.stun = 0;
  }
  hear(g, x, y, loud, kind) {
    if (kind !== 'ping' && kind !== 'buoy') return;
    if (this.stun > 0 || Math.hypot(x - this.x, y - this.y) > loud * 0.5) return;
    if (!this.nav) this.nav = new FocusNav(g.lv);
    if (!this.nav.compute(g.lv, 'L', x, y, this.x, this.y)) return;       // out of my reach (a crack too narrow for me): ignore it
    this.state = 'attract';
    this.tx = x; this.ty = y; this.attractT = 8; this.navT = 1.2;
  }
  // after a sting the jelly recoils and ignores sound for a while, so one touch is never a chain of stings
  bitten(g) {
    const p = g.player, d = Math.hypot(this.x - p.x, this.y - p.y) || 1;
    this.stun = 4.5; this.passive = true; this.state = 'drift'; this.heading = Math.atan2(this.y - p.y, this.x - p.x);
    this.vx += ((this.x - p.x) / d) * 120; this.vy += ((this.y - p.y) / d) * 120;
  }
  update(g, dt) {
    const lv = g.lv, p = g.player;
    this.stun -= dt; this.passive = this.stun > 0;
    if (this.justBit(p) && this.stun <= 0) this.bitten(g);
    this.phase += dt * (this.state === 'attract' ? 3.1 : 2.2);
    const pulse = Math.max(0, Math.sin(this.phase));
    let dx = Math.cos(this.heading), dy = Math.sin(this.heading), speed = 36;
    if (this.state === 'attract') {
      this.attractT -= dt; this.navT -= dt;
      if (!this.nav) this.nav = new FocusNav(lv);
      if (this.navT <= 0) { this.nav.compute(lv, 'L', this.tx, this.ty, this.x, this.y); this.navT = 1.2; }
      const dd = Math.hypot(this.tx - this.x, this.ty - this.y), st = this.nav.steps(lv, this.x, this.y);
      if (this.nav.dir(lv, this.x, this.y, _d)) { dx = _d.x; dy = _d.y; }
      else if (dd > 1) { dx = (this.tx - this.x) / dd; dy = (this.ty - this.y) / dd; }
      speed = 72;
      // arrived: at the spot, or as close as the cave lets me get
      if (dd < 34 || (st >= 0 && st <= 1) || this.attractT <= 0) { this.state = 'drift'; this.heading = Math.atan2(this.vy, this.vx); }
    } else {
      this.heading += (noise2(g.time * 0.35 + this.nz, this.nz * 0.37) - 0.5) * 2.4 * dt;
      // veer away from nearby rock
      const ax = this.x + dx * (this.r + 38), ay = this.y + dy * (this.r + 38);
      if (sdfAt(lv, ax, ay) < this.r + 8) {
        gradAt(lv, ax, ay, _g);
        this.heading = turnToward(this.heading, Math.atan2(_g.y, _g.x), 2.6, dt);
      }
    }
    const thrust = speed * (0.28 + 1.0 * pulse);
    ease(this, dx * thrust, dy * thrust, 2.6, dt);
    g.applyCurrents(this, dt, 0.8);
    moveBody(lv, this, this.r * 0.8, dt, 0.35);
    const sp = Math.hypot(this.vx, this.vy);
    if (sp > 6) this.angle = turnToward(this.angle, Math.atan2(this.vy, this.vx), 3, dt);
  }
}

/* ------------------------------------------------------------------ */
/* Urchin: a spiny sentry. Just don't touch it.                         */
/* ------------------------------------------------------------------ */
export class Urchin extends Enemy {
  constructor(x, y) {
    super('urchin', x, y, 13);
    this.state = 'still';
  }
  update(g, dt) { this.phase += dt * 0.6; }
}

/* ------------------------------------------------------------------ */
/* Angler: lies in wait behind a glowing lure and lunges at what comes. */
/* ------------------------------------------------------------------ */
const AIM_T = 0.3;

export class Angler extends Enemy {
  constructor(x, y, a) {
    super('angler', x, y, 17);
    this.homeX = x; this.homeY = y; this.angle = a; this.homeA = a;
    this.state = 'idle'; this.timer = 0; this.alertT = 0; this.ldx = 0; this.ldy = 0; this.cool = 0; this.homeNav = false; this.passiveT = 0;
  }
  bitten() { this.state = 'recover'; this.timer = 2.2; this.passiveT = 2.2; }     // lunge landed: back to the lair, harmless for a moment
  // the glowing bait. flare (0..1) climbs during the wind-up that precedes every lunge: a visual/audible tell
  lure() {
    const a = this.state === 'lunge' || this.state === 'aim' ? this.angle : this.homeA;
    const bob = Math.sin(this.phase * 1.7) * 5;
    let reach = 38, x = 0, y = 0;
    for (let i = 0; i < 4; i++) {   // keep the bait in open water, even mid-lunge against a wall
      x = this.x + Math.cos(a) * reach + Math.cos(a + 1.57) * bob; y = this.y + Math.sin(a) * reach + Math.sin(a + 1.57) * bob - 6;
      if (!this.lvRef || sdfAt(this.lvRef, x, y) > 4) break;
      reach *= 0.55;
    }
    return { x, y, flare: this.state === 'aim' ? clamp(1 - this.timer / AIM_T, 0, 1) : 0 };
  }
  hear(g, x, y, loud, kind, power = 1) {
    if (kind !== 'ping' && kind !== 'buoy') return;
    // a tap is a whisper: only a close angler notices it; a full ping carries 330 px
    if (Math.hypot(x - this.x, y - this.y) < (kind === 'buoy' ? 240 : 150 + 180 * power)) this.alertT = 3.2;
  }
  update(g, dt) {
    const lv = g.lv, p = g.player;
    this.lvRef = lv;
    this.phase += dt;
    this.alertT -= dt; this.cool -= dt; this.passiveT -= dt; this.passive = this.passiveT > 0;
    const dx = p.x - this.x, dy = p.y - this.y, d = Math.hypot(dx, dy);
    if (this.state === 'idle') {
      this.angle = turnToward(this.angle, this.homeA, 1.5, dt);
      const hx = this.homeX - this.x, hy = this.homeY - this.y, hd = Math.hypot(hx, hy);
      if (hd > 1.5) { const k = Math.min(30, hd * 4) / hd; ease(this, hx * k, hy * k, 3, dt); moveBody(lv, this, this.r * 0.9, dt, 0.1); } else ease(this, 0, 0, 3, dt);
      const trigger = this.alertT > 0 ? 235 : 150;
      if (!p.dead && this.cool <= 0 && d < trigger && lineClear(lv, this.x, this.y, p.x, p.y, 3)) {
        this.state = 'aim'; this.timer = AIM_T;          // wind-up: the lure flares and it growls, then it strikes
        this.ldx = dx / d; this.ldy = dy / d;
        g.snd('alert2', this.x, this.y, 1);
      }
    } else if (this.state === 'aim') {
      this.timer -= dt;
      this.angle = turnToward(this.angle, Math.atan2(dy, dx), 9, dt);
      ease(this, 0, 0, 6, dt);
      if (this.timer <= 0) {
        if (p.dead) { this.state = 'recover'; this.timer = 1.0; }
        else { this.state = 'lunge'; this.timer = 0.62; this.ldx = Math.cos(this.angle); this.ldy = Math.sin(this.angle); g.snd('lunge', this.x, this.y, 1); }
      }
    } else if (this.state === 'lunge') {
      this.timer -= dt;
      const want = Math.atan2(dy, dx);
      const cur = Math.atan2(this.ldy, this.ldx);
      const na = turnToward(cur, want, 1.7, dt);
      this.ldx = Math.cos(na); this.ldy = Math.sin(na);
      ease(this, this.ldx * 350, this.ldy * 350, 9, dt);
      this.angle = na;
      if (moveBody(lv, this, this.r * 0.9, dt, 0.1) || this.timer <= 0) { this.state = 'recover'; this.timer = 2.0; }
    } else {
      this.timer -= dt;
      const hx = this.homeX - this.x, hy = this.homeY - this.y, hd = Math.hypot(hx, hy);
      if (hd > 6) {
        let ux = hx / hd, uy = hy / hd;
        if (!lineClear(lv, this.x, this.y, this.homeX, this.homeY, this.r * 0.8)) {
          if (!this.homeNav) { this.nav = new FocusNav(lv); this.nav.compute(lv, 'S', this.homeX, this.homeY); this.homeNav = true; }   // home never moves: one flow field per angler (size class S: its lair is a tight alcove)
          if (this.nav.dir(lv, this.x, this.y, _d)) { ux = _d.x; uy = _d.y; }
        }
        ease(this, ux * 62, uy * 62, 3, dt);
        this.angle = turnToward(this.angle, Math.atan2(uy, ux), 3, dt);
      } else if (this.timer <= 0) { this.state = 'idle'; this.cool = 1.4; ease(this, 0, 0, 4, dt); }
      moveBody(lv, this, this.r * 0.9, dt, 0.1);
      if (this.state !== 'idle' && this.timer <= 0 && (hd <= 40 || this.timer < -2.5)) { this.state = 'idle'; this.cool = 1.4; }   // (never stay stuck in recover)
    }
  }
}

/* ------------------------------------------------------------------ */
/* Eel / Leviathan: blind hunters that follow sound.                    */
/* ------------------------------------------------------------------ */
export const EEL_CFG = {
  type: 'eel', r: 11, segs: 10, segLen: 11, cls: 'S', damage: 1,
  patrol: 70, investigate: 146, chase: 152, search: 38, hear: 1.0, minPower: 0.2, ease: 3.6,
  moveHear: 1.2, sense: 66, moveAlert: 3.0, dashAlert: 4.2, investigateT: 14,
};
export const LEVIATHAN_CFG = {
  type: 'leviathan', r: 27, segs: 22, segLen: 21, cls: 'XL', damage: 2,
  patrol: 66, investigate: 112, chase: 134, search: 44, hear: 1.5, minPower: 0.0, ease: 1.7,
  moveHear: 1.2, sense: 72, moveAlert: 3.0, dashAlert: 4.2, investigateT: 14,
};

export class Eel extends Enemy {
  constructor(x, y, cfg, depth = 3) {
    super(cfg.type, x, y, cfg.r);
    this.cfg = cfg; this.damage = cfg.damage; this.depth = depth;
    this.state = 'patrol';
    this.tx = x; this.ty = y; this.timer = 0; this.alert = 0; this.navT = 0;
    this.spine = [];
    this.segLen = cfg.segLen;
    for (let i = 0; i < cfg.segs; i++) this.spine.push({ x, y });
    // the body follows the exact path the head has swum (a ring buffer of head positions), so it can never cut
    // a corner through the rock; initBody() lays the first trail out along the most open direction
    this.trS = cfg.segLen < 15 ? 3 : 5;      // px between recorded head positions
    this.trN = Math.ceil((cfg.segs - 1) * cfg.segLen / this.trS) + 14;
    this.trX = new Float32Array(this.trN); this.trY = new Float32Array(this.trN);
    this.trH = this.trN - 1; this.trC = 0; this.bodyInit = false; this.grace = 0;
    this.rdx = 1; this.rdy = 0;                    // retreat direction while recoiling
    this.wdT = 0; this.wdX = x; this.wdY = y; this.unstick = 0;   // stuck watchdog
    this.hotX = x; this.hotY = y; this.hotN = 0;   // last place something interesting was heard: patrol sweeps it before roaming on
    this.pushTrail(x, y);
    // collision circles along the body
    this.hitIdx = [];
    if (cfg.type === 'leviathan') for (let i = 0; i < cfg.segs; i += 2) this.hitIdx.push([i, cfg.r * (1 - 0.62 * (i / cfg.segs))]);
    else this.hitIdx.push([0, cfg.r], [1, cfg.r * 0.85], [3, cfg.r * 0.7]);
    this.cs = this.hitIdx.map(([i, r]) => ({ x, y, r }));
  }
  circles() {
    for (let k = 0; k < this.hitIdx.length; k++) {
      const [i, r] = this.hitIdx[k], c = this.cs[k], s = this.spine[i];
      c.x = s.x; c.y = s.y; c.r = r;
    }
    return this.cs;
  }
  chaseSpeed() { return this.cfg.chase + Math.min(this.depth, 12) * 1.1; }
  hear(g, x, y, loud, kind, power = 1) {
    const cfg = this.cfg;
    if (this.state === 'recoil') return;      // busy backing off after a bite
    const d = Math.hypot(x - this.x, y - this.y);
    if (kind === 'ping' || kind === 'buoy') {
      if (kind === 'ping' && power < cfg.minPower) return;
      if (d > loud * cfg.hear || this.state === 'chase') return;
      const ptx = this.tx, pty = this.ty;
      this.tx = x; this.ty = y;
      if (!this.computeNav(g)) { this.tx = ptx; this.ty = pty; return; }    // out of my reach: ignore it
      if (this.state !== 'investigate') g.snd('alert2', this.x, this.y, 0.6);
      this.state = 'investigate'; this.timer = cfg.investigateT; this.navT = 0;
    } else if (kind === 'move' || kind === 'dash') {
      if (d > loud * cfg.moveHear) return;
      this.startChase(g, kind === 'dash' ? cfg.dashAlert : cfg.moveAlert);
    }
  }
  // called when this creature has just hurt the player: back off for a while so a bite is a setback, not a death spiral
  bitten(g) {
    this.state = 'recoil'; this.timer = 2.6; this.alert = 0; this.grace = 4.2; this.navT = 0;
    this.passive = true;
    this.pickRetreat(g);
  }
  // swim away from the player along the freest direction (re-evaluated while retreating)
  pickRetreat(g) {
    const p = g.player, lv = g.lv, r = this.r;
    const base = Math.atan2(this.y - p.y, this.x - p.x), reach = r * 5 + 60;
    let best = base, bs = -1;
    for (let k = -6; k <= 6; k++) {
      const a = base + k * 0.3;
      const free = rayMarch(lv, this.x, this.y, Math.cos(a), Math.sin(a), reach) - r * 1.2;
      const sc = Math.max(0, free) * (0.5 + 0.5 * Math.cos(k * 0.3));
      if (sc > bs) { bs = sc; best = a; }
    }
    this.rdx = Math.cos(best); this.rdy = Math.sin(best);
  }
  startChase(g, t) {
    if (this.state !== 'chase') {
      this.state = 'chase'; this.navT = 0;
      g.snd(this.cfg.type === 'leviathan' ? 'roar' : 'alert', this.x, this.y, 1);
    }
    this.alert = Math.max(this.alert, t);
  }
  computeNav(g) {
    if (!this.nav) this.nav = new FocusNav(g.lv);
    return this.nav.compute(g.lv, this.cfg.cls, this.tx, this.ty, this.x, this.y);
  }
  pushTrail(x, y) {
    const h = (this.trH + 1) % this.trN;
    this.trX[h] = x; this.trY[h] = y; this.trH = h;
    if (this.trC < this.trN) this.trC++;
  }
  initBody(lv) {
    this.bodyInit = true;
    const need = (this.cfg.segs - 1) * this.segLen + 8;
    let ba = this.angle + Math.PI, bd = -1;
    for (let k = 0; k < 16; k++) {     // longest free ray behind me becomes the tail
      const a = this.angle + Math.PI + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * TAU / 16;
      const d = rayMarch(lv, this.x, this.y, Math.cos(a), Math.sin(a), need);
      if (d > bd + 0.5) { bd = d; ba = a; if (d >= need) break; }
    }
    this.angle = ba + Math.PI;
    const steps = Math.min(this.trN - 2, Math.floor(Math.max(0, bd - this.r - 4) / this.trS));
    this.trC = 0; this.trH = this.trN - 1;
    for (let j = steps; j >= 1; j--) this.pushTrail(this.x + Math.cos(ba) * j * this.trS, this.y + Math.sin(ba) * j * this.trS);
    this.pushTrail(this.x, this.y);
    this.updateBody();
  }
  updateBody() {
    const s = this.spine, n = s.length, L = this.segLen, N = this.trN, X = this.trX, Y = this.trY;
    let h = this.trH;
    if (Math.hypot(this.x - X[h], this.y - Y[h]) >= this.trS) { this.pushTrail(this.x, this.y); h = this.trH; }
    s[0].x = this.x; s[0].y = this.y;
    let px = this.x, py = this.y, acc = 0, want = L, node = 1;
    for (let k = 0; k < this.trC && node < n; k++) {
      const i = (h - k + N) % N, qx = X[i], qy = Y[i];
      const sl = Math.hypot(qx - px, qy - py);
      while (node < n && acc + sl >= want) {
        const f = sl > 1e-6 ? (want - acc) / sl : 0;
        s[node].x = px + (qx - px) * f; s[node].y = py + (qy - py) * f;
        node++; want += L;
      }
      acc += sl; px = qx; py = qy;
    }
    for (; node < n; node++) { s[node].x = px; s[node].y = py; }
  }
  setHot(x, y) { this.hotX = x; this.hotY = y; this.hotN = 2; }
  pickWaypoint(g) {
    const lv = g.lv;
    const list = this.cfg.type === 'leviathan' && lv.xlCells.length ? lv.xlCells : lv.patrol;
    const near = this.hotN > 0;      // after a noise, comb the neighbourhood for a couple of hops first
    if (near) this.hotN--;
    const need = this.cfg.cls === 'XL' ? 40 : 20;
    for (let tries = 0; tries < 24; tries++) {
      let x, y;
      if (near && tries < 16) {      // a random open spot around the place where the noise was (the search radius widens with every miss)
        const a = g.rng.next() * TAU, rr = 50 + g.rng.next() * (160 + tries * 8);
        x = this.hotX + Math.cos(a) * rr; y = this.hotY + Math.sin(a) * rr;
        if (x < 0 || y < 0 || x >= lv.width || y >= lv.height || sdfAt(lv, x, y) < need) continue;
      } else {
        const c = list[Math.floor(g.rng.next() * list.length)];
        x = (c % lv.gw + 0.5) * 16; y = (((c / lv.gw) | 0) + 0.5) * 16;
      }
      this.tx = x; this.ty = y;
      // reachable: the flow field reaches my cell, or at least a neighbour of it (I may be hugging a wall)
      if (this.computeNav(g) && this.nav.valid && (this.nav.steps(lv, this.x, this.y) >= 0 || this.nav.dir(lv, this.x, this.y, _d))) break;
    }
    this.timer = near ? 12 : 25;
  }
  update(g, dt) {
    const lv = g.lv, cfg = this.cfg, p = g.player;
    if (!this.nav) this.nav = new FocusNav(lv);
    if (!this.bodyInit) this.initBody(lv);
    this.timer -= dt; this.navT -= dt; this.grace -= dt;
    this.phase += dt * (this.state === 'chase' ? 9 : 4.5);
    if (this.calm > 0) this.grace = 1.8;      // game.js has just let me bite (it sets calm and feeds me a "deaf" game): once it ends I still keep my distance for a moment
    else if (this.justBit(p) && this.state !== 'recoil') this.bitten(g);
    const pd = Math.hypot(p.x - this.x, p.y - this.y);
    if (!p.dead && pd < cfg.sense && this.state !== 'chase' && this.state !== 'recoil' && this.grace <= 0) this.startChase(g, cfg.moveAlert * 0.85);
    let speed = 0, moving = true;
    const dist = Math.hypot(this.tx - this.x, this.ty - this.y);
    switch (this.state) {
      case 'patrol':
        speed = cfg.patrol;
        if (this.timer <= 0 || !this.nav.valid || dist < 40) this.pickWaypoint(g);
        break;
      case 'investigate':
        speed = cfg.investigate;
        // arrived: at the spot, or at the nearest place I can reach (the player may be hiding in a crack I cannot enter)
        if (dist < 44 || this.timer <= 0 || (this.nav.valid && this.nav.steps(lv, this.x, this.y) >= 0 && this.nav.steps(lv, this.x, this.y) <= 1)) { this.state = 'search'; this.timer = 3.4; this.heading = this.angle; this.setHot(this.tx, this.ty); }
        break;
      case 'chase':
        speed = this.chaseSpeed();
        this.alert -= dt;
        this.tx = p.x; this.ty = p.y;
        if (this.navT <= 0) { this.computeNav(g); this.navT = 0.26; }
        if (this.alert <= 0) { this.state = 'search'; this.timer = 3.2; this.heading = this.angle; this.setHot(p.x, p.y); }
        break;
      case 'recoil':
        speed = cfg.investigate;
        if (this.navT <= 0) { this.pickRetreat(g); this.navT = 0.35; }
        if (this.timer <= 0) { this.state = 'search'; this.timer = 1.4; this.heading = this.angle; this.passive = false; }
        break;
      case 'search':
        speed = cfg.search; moving = false;
        this.angle += Math.sin(this.phase * 0.4) * 1.1 * dt + 0.8 * dt;
        if (this.timer <= 0) { this.state = 'patrol'; this.timer = 0; }
        break;
    }
    let dx = Math.cos(this.angle), dy = Math.sin(this.angle);
    if (moving) {
      const dd = Math.hypot(this.tx - this.x, this.ty - this.y);
      if (this.state === 'recoil') {
        dx = this.rdx; dy = this.rdy;
      } else if (this.state === 'chase' && dd < 150 && dd > 1 && lineClear(lv, this.x, this.y, this.tx, this.ty, this.r * 0.8)) {
        dx = (this.tx - this.x) / dd; dy = (this.ty - this.y) / dd;
      } else if (this.nav.dir(lv, this.x, this.y, _d)) {
        dx = _d.x; dy = _d.y;
      } else if (dd > 1) {
        dx = (this.tx - this.x) / dd; dy = (this.ty - this.y) / dd;
      }
    } else {
      dx *= 0.6; dy *= 0.6;
    }
    // watchdog: pinned against rock for 1.5 s while ordered to swim (a bite recoil or a current can shove a hunter into a crack
    // the flow field does not cover): back out along the wall normal until the flow field takes over again
    this.wdT += dt;
    if (this.wdT >= 1.5) {
      if (moving && dt > 0 && !(this.state === 'chase' && dist < 120) && Math.hypot(this.x - this.wdX, this.y - this.wdY) < 14) this.unstick = 1.2;
      this.wdX = this.x; this.wdY = this.y; this.wdT = 0;
    }
    if (this.unstick > 0) { this.unstick -= dt; gradAt(lv, this.x, this.y, _g); dx = _g.x; dy = _g.y; }
    // serpentine wiggle
    const wig = Math.sin(this.phase * 1.6) * 0.22;
    const wx = dx - dy * wig, wy = dy + dx * wig;
    ease(this, wx * speed, wy * speed, cfg.ease, dt);
    g.applyCurrents(this, dt, cfg.type === 'leviathan' ? 0.25 : 0.7);
    moveBody(lv, this, this.r * 0.85, dt, 0.25);
    const sp = Math.hypot(this.vx, this.vy);
    if (moving && sp > 8) this.angle = turnToward(this.angle, Math.atan2(this.vy, this.vx), 5, dt);
    this.updateBody();
    // click while hunting; a faint, slow click (rumble for the leviathan) while it merely patrols, so a listener in the
    // dark can tell that something is moving out there and roughly where (the pan carries the direction)
    this.clickT = (this.clickT || 0) - dt;
    if (this.clickT <= 0) {
      if (this.state === 'chase' || this.state === 'investigate') {
        this.clickT = this.state === 'chase' ? 0.34 : 0.7;
        g.snd(cfg.type === 'leviathan' ? 'thrum' : 'click', this.x, this.y, 0.7);
      } else if (this.state === 'patrol' || this.state === 'search') {
        this.clickT = 1.5 + (Math.sin(this.phase * 0.37) * 0.5 + 0.5) * 1.3;
        g.snd(cfg.type === 'leviathan' ? 'thrum' : 'click', this.x, this.y, cfg.type === 'leviathan' ? 0.4 : 0.5);
      }
    }
  }
}

export function makeEnemy(type, s, depth) {
  switch (type) {
    case 'jelly': return new Jelly(s.x, s.y);
    case 'urchin': return new Urchin(s.x, s.y);
    case 'angler': return new Angler(s.x, s.y, s.a);
    case 'eel': return new Eel(s.x, s.y, EEL_CFG, depth);
    case 'leviathan': return new Eel(s.x, s.y, LEVIATHAN_CFG, depth);
  }
  return null;
}
