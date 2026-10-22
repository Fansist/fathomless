// Creatures of the deep. Each hunts by sound; none of them can see you.
import { clamp, TAU, angleDiff, noise2 } from './rng.js';
import { NavField, moveBody, sdfAt, gradAt, lineClear } from './world.js';

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

let NEXT_ID = 1;

class Enemy {
  constructor(type, x, y, r) {
    this.type = type;
    this.id = NEXT_ID++;
    this.x = x; this.y = y; this.vx = 0; this.vy = 0; this.r = r;
    this.angle = Math.random() * TAU;
    this.phase = Math.random() * TAU;
    this.state = 'idle';
    this.damage = 1;
    this.seen = -999;           // game time of last sonar illumination
    this.sx = x; this.sy = y; this.sa = this.angle; this.sPhase = 0; this.sSpine = null;
    this.cs = [{ x, y, r }];
    this.nav = null;
  }
  circles() {
    const c = this.cs[0];
    c.x = this.x; c.y = this.y; c.r = this.r;
    return this.cs;
  }
  snapshot(t) {
    this.seen = t;
    this.sx = this.x; this.sy = this.y; this.sa = this.angle; this.sPhase = this.phase;
    if (this.spine) this.sSpine = this.spine.map((p) => ({ x: p.x, y: p.y }));
  }
  hear() {}
  update() {}
}

/* ------------------------------------------------------------------ */
/* Drifter: a translucent jelly that wanders and is lured by sound.     */
/* ------------------------------------------------------------------ */
export class Jelly extends Enemy {
  constructor(x, y) {
    super('jelly', x, y, 15);
    this.heading = Math.random() * TAU;
    this.state = 'drift';
    this.tx = x; this.ty = y; this.attractT = 0; this.navT = 0;
  }
  hear(g, x, y, loud, kind) {
    if (kind !== 'ping' && kind !== 'buoy') return;
    if (Math.hypot(x - this.x, y - this.y) > loud * 0.62) return;
    this.state = 'attract';
    this.tx = x; this.ty = y; this.attractT = 8; this.navT = 0;
  }
  update(g, dt) {
    const lv = g.lv;
    this.phase += dt * (this.state === 'attract' ? 3.1 : 2.2);
    const pulse = Math.max(0, Math.sin(this.phase));
    let dx = Math.cos(this.heading), dy = Math.sin(this.heading), speed = 36;
    if (this.state === 'attract') {
      this.attractT -= dt; this.navT -= dt;
      if (!this.nav) this.nav = new NavField(lv);
      if (this.navT <= 0) { this.nav.compute(lv, 'L', this.tx, this.ty); this.navT = 1.2; }
      const dd = Math.hypot(this.tx - this.x, this.ty - this.y);
      if (this.nav.dir(lv, this.x, this.y, _d)) { dx = _d.x; dy = _d.y; }
      speed = 72;
      if (dd < 34 || this.attractT <= 0) { this.state = 'drift'; this.heading = Math.atan2(this.vy, this.vx); }
    } else {
      this.heading += (noise2(g.time * 0.35 + this.id * 7.1, this.id) - 0.5) * 2.4 * dt;
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
export class Angler extends Enemy {
  constructor(x, y, a) {
    super('angler', x, y, 17);
    this.homeX = x; this.homeY = y; this.angle = a; this.homeA = a;
    this.state = 'idle'; this.timer = 0; this.alertT = 0; this.ldx = 0; this.ldy = 0;
  }
  lure() {
    const a = this.state === 'lunge' ? this.angle : this.homeA;
    const bob = Math.sin(this.phase * 1.7) * 5;
    return { x: this.x + Math.cos(a) * 38 + Math.cos(a + 1.57) * bob, y: this.y + Math.sin(a) * 38 + Math.sin(a + 1.57) * bob - 6 };
  }
  hear(g, x, y, loud, kind) {
    if (kind !== 'ping' && kind !== 'buoy') return;
    if (Math.hypot(x - this.x, y - this.y) < 330) this.alertT = 3.2;
  }
  update(g, dt) {
    const lv = g.lv, p = g.player;
    this.phase += dt;
    this.alertT -= dt;
    const dx = p.x - this.x, dy = p.y - this.y, d = Math.hypot(dx, dy);
    if (this.state === 'idle') {
      this.angle = turnToward(this.angle, this.homeA, 1.5, dt);
      ease(this, 0, 0, 3, dt);
      const trigger = this.alertT > 0 ? 235 : 150;
      if (!p.dead && d < trigger && lineClear(lv, this.x, this.y, p.x, p.y, 3)) {
        this.state = 'lunge'; this.timer = 0.62;
        this.ldx = dx / d; this.ldy = dy / d;
        g.snd('lunge', this.x, this.y, 1);
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
      if (!this.nav) this.nav = new NavField(lv);
      const hx = this.homeX - this.x, hy = this.homeY - this.y, hd = Math.hypot(hx, hy);
      if (hd > 6) {
        let ux = hx / hd, uy = hy / hd;
        if (!lineClear(lv, this.x, this.y, this.homeX, this.homeY, this.r * 0.8)) {
          this.nav.compute(lv, 'L', this.homeX, this.homeY);
          if (this.nav.dir(lv, this.x, this.y, _d)) { ux = _d.x; uy = _d.y; }
        }
        ease(this, ux * 62, uy * 62, 3, dt);
        this.angle = turnToward(this.angle, Math.atan2(uy, ux), 3, dt);
      } else if (this.timer <= 0) { this.state = 'idle'; ease(this, 0, 0, 4, dt); }
      moveBody(lv, this, this.r * 0.9, dt, 0.1);
      if (this.timer <= 0 && hd <= 40) this.state = 'idle';
    }
  }
}

/* ------------------------------------------------------------------ */
/* Eel / Leviathan: blind hunters that follow sound.                    */
/* ------------------------------------------------------------------ */
export const EEL_CFG = {
  type: 'eel', r: 11, segs: 10, segLen: 11, cls: 'S', damage: 1,
  patrol: 66, investigate: 138, chase: 150, search: 38, hear: 1.0, minPower: 0.14, ease: 3.6,
};
export const LEVIATHAN_CFG = {
  type: 'leviathan', r: 27, segs: 22, segLen: 21, cls: 'XL', damage: 2,
  patrol: 62, investigate: 105, chase: 128, search: 44, hear: 1.35, minPower: 0.0, ease: 1.7,
};

export class Eel extends Enemy {
  constructor(x, y, cfg, depth = 3) {
    super(cfg.type, x, y, cfg.r);
    this.cfg = cfg; this.damage = cfg.damage; this.depth = depth;
    this.state = 'patrol';
    this.tx = x; this.ty = y; this.timer = 0; this.alert = 0; this.navT = 0;
    this.spine = [];
    this.segLen = cfg.segLen;
    for (let i = 0; i < cfg.segs; i++) this.spine.push({ x: x - Math.cos(this.angle) * i * cfg.segLen, y: y - Math.sin(this.angle) * i * cfg.segLen });
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
    const d = Math.hypot(x - this.x, y - this.y);
    if (kind === 'ping' || kind === 'buoy') {
      if (kind === 'ping' && power < cfg.minPower) return;
      if (d > loud * cfg.hear || this.state === 'chase') return;
      this.state = 'investigate'; this.tx = x; this.ty = y; this.timer = 14; this.navT = 0;
      this.computeNav(g);
      g.snd('alert2', this.x, this.y, 0.6);
    } else if (kind === 'move' || kind === 'dash') {
      if (d > loud) return;
      this.startChase(g, kind === 'dash' ? 4.2 : 3.0);
    }
  }
  startChase(g, t) {
    if (this.state !== 'chase') {
      this.state = 'chase'; this.navT = 0;
      g.snd(this.cfg.type === 'leviathan' ? 'roar' : 'alert', this.x, this.y, 1);
    }
    this.alert = Math.max(this.alert, t);
  }
  computeNav(g) {
    if (!this.nav) this.nav = new NavField(g.lv);
    this.nav.compute(g.lv, this.cfg.cls, this.tx, this.ty);
  }
  pickWaypoint(g) {
    const lv = g.lv;
    const list = this.cfg.type === 'leviathan' && lv.xlCells.length ? lv.xlCells : lv.patrol;
    for (let tries = 0; tries < 4; tries++) {
      const c = list[Math.floor(g.rng.next() * list.length)];
      this.tx = (c % lv.gw + 0.5) * 16; this.ty = (((c / lv.gw) | 0) + 0.5) * 16;
      this.computeNav(g);
      if (this.nav.valid && this.nav.steps(lv, this.x, this.y) >= 0) break;
    }
    this.timer = 25;
  }
  update(g, dt) {
    const lv = g.lv, cfg = this.cfg, p = g.player;
    if (!this.nav) this.nav = new NavField(lv);
    this.timer -= dt; this.navT -= dt;
    this.phase += dt * (this.state === 'chase' ? 9 : 4.5);
    const pd = Math.hypot(p.x - this.x, p.y - this.y);
    if (!p.dead && pd < 62 && this.state !== 'chase') this.startChase(g, 2.5);
    let speed = 0, moving = true;
    const dist = Math.hypot(this.tx - this.x, this.ty - this.y);
    switch (this.state) {
      case 'patrol':
        speed = cfg.patrol;
        if (this.timer <= 0 || !this.nav.valid || dist < 40) this.pickWaypoint(g);
        break;
      case 'investigate':
        speed = cfg.investigate;
        if (dist < 44 || this.timer <= 0) { this.state = 'search'; this.timer = 3.4; this.heading = this.angle; }
        break;
      case 'chase':
        speed = this.chaseSpeed();
        this.alert -= dt;
        this.tx = p.x; this.ty = p.y;
        if (this.navT <= 0) { this.computeNav(g); this.navT = 0.26; }
        if (this.alert <= 0) { this.state = 'search'; this.timer = 3.2; this.heading = this.angle; }
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
      if (this.state === 'chase' && dd < 150 && lineClear(lv, this.x, this.y, this.tx, this.ty, this.r * 0.8)) {
        dx = (this.tx - this.x) / dd; dy = (this.ty - this.y) / dd;
      } else if (this.nav.dir(lv, this.x, this.y, _d)) {
        dx = _d.x; dy = _d.y;
      } else if (dd > 1) {
        dx = (this.tx - this.x) / dd; dy = (this.ty - this.y) / dd;
      }
    } else {
      dx *= 0.6; dy *= 0.6;
    }
    // serpentine wiggle
    const wig = Math.sin(this.phase * 1.6) * 0.22;
    const wx = dx - dy * wig, wy = dy + dx * wig;
    ease(this, wx * speed, wy * speed, cfg.ease, dt);
    g.applyCurrents(this, dt, cfg.type === 'leviathan' ? 0.25 : 0.7);
    moveBody(lv, this, this.r * 0.85, dt, 0.25);
    const sp = Math.hypot(this.vx, this.vy);
    if (moving && sp > 8) this.angle = turnToward(this.angle, Math.atan2(this.vy, this.vx), 5, dt);
    // spine follows the head
    const s = this.spine;
    s[0].x = this.x; s[0].y = this.y;
    for (let i = 1; i < s.length; i++) {
      const ax = s[i].x - s[i - 1].x, ay = s[i].y - s[i - 1].y, ad = Math.hypot(ax, ay) || 1;
      s[i].x = s[i - 1].x + (ax / ad) * this.segLen;
      s[i].y = s[i - 1].y + (ay / ad) * this.segLen;
    }
    // click while hunting
    this.clickT = (this.clickT || 0) - dt;
    if (this.clickT <= 0 && (this.state === 'chase' || this.state === 'investigate')) {
      this.clickT = this.state === 'chase' ? 0.34 : 0.7;
      g.snd(cfg.type === 'leviathan' ? 'thrum' : 'click', this.x, this.y, 0.7);
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
