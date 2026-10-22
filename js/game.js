// Game rules and state machine. Rendering and DOM live elsewhere.
import { RNG, clamp, lerp, TAU, angleDiff } from './rng.js';
import { PLAYER, PING, MAX_DEPTH, DEPTH_METERS, computeStats, pickUpgrades, UPGRADES } from './config.js';
import { generateLevel, sdfAt, moveBody, NavField, lineClear } from './world.js';
import { createPing, updatePing, HK } from './sonar.js';
import { makeEnemy } from './entities.js';
import { load, save } from './storage.js';

const todayStr = () => new Date().toISOString().slice(0, 10);

export class Game {
  constructor({ input, audio, ui, settings }) {
    this.input = input;
    this.audio = audio;
    this.ui = ui;
    this.settings = settings;
    this.state = 'title';
    this.prevState = 'title';
    this.time = 0;          // world clock (paused with the game)
    this.realTime = 0;
    this.view = { w: 1280, h: 720 };
    this.cam = { x: 0, y: 0, zoom: 1, sx: 0, sy: 0 };
    this.shakeAmt = 0;
    this.flash = 0;
    this.hitStop = 0;
    this.danger = 0;
    this.bot = null;        // optional controller for automated tests
    this.god = false;
    this.best = Game.sanitizeBest(load('best', null));
    this.hintsSeen = load('hints', {});
    this.hintQ = []; this.hintGap = 0; this.hintN = 0; this.hintEl = null; this.hintCur = '';
    this.levelTime = 0; this.levelHurt = false; this.levelPearls = 0;
    this.upgradeChoices = [];
    this.titleGenMs = 0;
    // a view of this game whose player is far away: handed to a hunter that just bit you so its proximity sense cannot instantly re-arm it
    this.deaf = Object.create(this);
    this.deaf.player = { x: -1e6, y: -1e6, vx: 0, vy: 0, r: 9, dead: false, invul: 0, hull: 3, charging: false };
    this.pings = []; this.enemies = []; this.pickups = []; this.buoys = []; this.particles = []; this.floaters = [];
    this.player = this.makePlayer(0, 0);
    this.run = null;
    this.stats = computeStats({});
    this.onLevel = null;    // renderer hook
    this.rng = new RNG('boot');
    this.pingWasHeld = false; this.pingLatch = false; this.pingCd = 0; this.regenDelay = 0;
    this.pearlCombo = 0;
    this.stateT = 0;
    this.demo = null;
    this.exitObj = { x: 0, y: 0, seen: -999, type: 'exit' };
    this.levelSummary = null;
  }

  // records may come from hand-edited / corrupted storage: always return a complete, numeric structure
  static sanitizeBest(b) {
    const n = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
    b = b && typeof b === 'object' ? b : {};
    const d = b.daily && typeof b.daily === 'object' ? b.daily : {};
    return { depth: n(b.depth), score: n(b.score), endless: n(b.endless), daily: { date: typeof d.date === 'string' ? d.date : '', depth: n(d.depth), score: n(d.score) } };
  }

  /* ================================================================ */
  /* Run / level lifecycle                                             */
  /* ================================================================ */
  makePlayer(x, y) {
    return {
      x, y, vx: 0, vy: 0, r: PLAYER.r, angle: -Math.PI / 2, hull: 3, maxHull: 3, energy: 100,
      charge: 0, charging: false, dashCd: 0, dashT: 0, invul: 0, dead: false, buoys: 2, trail: 0,
    };
  }

  startTitle() {
    this.state = 'title';
    this.run = null;
    this.stats = computeStats({});
    this.audio.chargeStop();
    this.hintQ.length = 0; this.hintGap = 0; this.hintEl = null; this.upgradeChoices = [];
    this.pingWasHeld = false; this.pingLatch = false;
    // depths 1-8 only: smaller, cheaper caves keep the (synchronous) title regeneration well under a frame budget hitch
    const depth = 1 + Math.floor(Math.random() * 8);
    const t0 = performance.now();
    this.lv = generateLevel('title:' + Math.random().toString(36).slice(2), depth);
    this.rng = new RNG('title');
    this.setupLevelEntities(this.lv, depth, true);
    const p = this.player = this.makePlayer(this.lv.start.x, this.lv.start.y);
    p.energy = 100;
    this.demo = { nav: new NavField(this.lv), pingT: 1.2, n: 0, age: 0 };
    this.demo.nav.compute(this.lv, 'S', this.lv.exit.x, this.lv.exit.y);
    this.afterLevelLoad();
    this.titleGenMs = performance.now() - t0;
    this.audio.setBiome(this.lv.biome.id, 1);
  }

  startRun(o = {}) {
    const daily = !!o.daily;
    const date = todayStr();
    const seed = o.seed || (daily ? 'daily-' + date : 'dive-' + Math.floor(Math.random() * 1e9).toString(36));
    this.run = {
      seed, daily, date, depth: 1, score: 0, pearls: 0, time: 0, hits: 0, pings: 0, dashes: 0, buoysUsed: 0,
      ups: {}, won: false, endless: false, startedAt: Date.now(),
      startBest: { depth: this.best.depth, score: this.best.score },
    };
    this.stats = computeStats({});
    this.player = this.makePlayer(0, 0);
    this.player.buoys = 2;
    this.hintQ.length = 0; this.hintGap = 0; this.hintEl = null;
    this.loadLevel(1);
  }

  setupLevelEntities(lv, depth, titleMode = false) {
    this.enemies = []; this.pickups = []; this.buoys = []; this.pings = []; this.particles = []; this.floaters = [];
    const sp = lv.spawns;
    const add = (type, list) => { for (const s of list) { const e = makeEnemy(type, s, depth); if (e) this.enemies.push(e); } };
    add('jelly', sp.jellies);
    if (!titleMode) {
      add('urchin', sp.urchins);
      add('eel', sp.eels);
      add('angler', sp.anglers);
      if (sp.leviathan) add('leviathan', [sp.leviathan]);
    }
    for (const p of sp.pearls) this.pickups.push({ type: 'pearl', x: p.x, y: p.y, r: 8, taken: false, seen: -999, phase: Math.random() * TAU });
    for (const p of sp.buoys) this.pickups.push({ type: 'buoy', x: p.x, y: p.y, r: 10, taken: false, seen: -999, phase: Math.random() * TAU });
    for (const p of sp.patches) this.pickups.push({ type: 'patch', x: p.x, y: p.y, r: 11, taken: false, seen: -999, phase: Math.random() * TAU });
    this.exitObj = { x: lv.exit.x, y: lv.exit.y, seen: -999, type: 'exit' };
  }

  loadLevel(depth) {
    const run = this.run;
    run.depth = depth;
    this.lv = generateLevel(run.seed, depth);
    this.rng = new RNG(run.seed + ':ai:' + depth);
    this.setupLevelEntities(this.lv, depth);
    const p = this.player;
    p.x = this.lv.start.x; p.y = this.lv.start.y; p.vx = 0; p.vy = 0;
    p.angle = Math.atan2(this.lv.exit.y - p.y, this.lv.exit.x - p.x);
    p.maxHull = this.stats.maxHull;
    p.hull = Math.min(p.hull, p.maxHull);
    p.energy = this.stats.maxEnergy;
    p.charge = 0; p.charging = false; p.dashCd = 0; p.dashT = 0; p.invul = 1.2; p.dead = false;
    this.audio.chargeStop();
    this.levelTime = 0; this.levelHurt = false; this.levelPearls = 0; this.pearlCombo = 0;
    this.demo = null;
    this.state = 'play'; this.stateT = 0;
    this.pingLatch = true; this.pingCd = 0.4; this.regenDelay = 0;
    this.danger = 0; this.flash = 0; this.shakeAmt = 0;
    this.hintGap = Math.max(this.hintGap, 1.1);   // let the depth banner land before any hint
    this.afterLevelLoad();
    this.audio.setBiome(this.lv.biome.id, depth);
    this.audio.newDepth();
    this.ui.banner(this.lv.biome.name, `DEPTH ${depth}  ·  ${depth * DEPTH_METERS} m`, depth >= MAX_DEPTH ? 'Something enormous is listening.' : this.lv.biome.tag);
    // a faint first look around so the player is never completely blind
    this.spawnPing(p.x, p.y, 0.3, { quiet: true, kind: 'intro' });
    this.ui.setMode('play');
  }

  afterLevelLoad() {
    this.time = 0;
    const p = this.player;
    this.cam.x = p.x; this.cam.y = p.y; this.cam.zoom = 1;
    if (this.onLevel) this.onLevel(this.lv);
  }

  nextLevel() {
    this.loadLevel(this.run.depth + 1);
  }

  /* ================================================================ */
  /* Main update                                                       */
  /* ================================================================ */
  update(dt) {
    dt = dt > 0 ? Math.min(dt, 0.1) : 0;   // tab restores / debugger pauses must never tunnel creatures through rock
    this.realTime += dt;
    this.stateT += dt;
    switch (this.state) {
      case 'title': this.updateTitle(dt); break;
      case 'play': this.updatePlay(dt); break;
      case 'dying': this.updateDying(dt); break;
      case 'levelend': this.updateLevelEnd(dt); break;
      case 'upgrade': case 'gameover': case 'victory': this.updateIdle(dt); break;
      case 'paused': break;
    }
    this.updateFx(dt);
  }

  controls() {
    if (this.bot) return this.bot(this);
    const i = this.input;
    return {
      mx: i.moveX, my: i.moveY, ping: i.pingHeld,
      dash: i.pressed('dash'), buoy: i.pressed('buoy'),
    };
  }

  /* ---------- title demo ---------- */
  updateTitle(dt) {
    const lv = this.lv, p = this.player, d = this.demo;
    this.time += dt; d.age += dt;
    // glide toward the exit along the flow field
    const dir = { x: 0, y: 0 };
    if (d.nav.dir(lv, p.x, p.y, dir)) {
      const sp = 58;
      p.vx += (dir.x * sp - p.vx) * (1 - Math.exp(-1.6 * dt));
      p.vy += (dir.y * sp - p.vy) * (1 - Math.exp(-1.6 * dt));
    }
    moveBody(lv, p, p.r, dt, 0.2);
    if (Math.hypot(p.vx, p.vy) > 5) p.angle += angleDiff(p.angle, Math.atan2(p.vy, p.vx)) * Math.min(1, dt * 4);
    d.pingT -= dt;
    if (d.pingT <= 0) {
      const pw = [0.55, 1.0, 0.8, 0.35][d.n++ % 4];
      this.spawnPing(p.x, p.y, pw, { quiet: true, kind: 'demo' });
      if (this.audio.ok) this.audio.ping(pw * 0.7, { gain: 0.4 });
      d.pingT = 1.5 + pw * 1.2;
    }
    this.updatePings(dt);
    for (const e of this.enemies) e.update(this, dt);
    this.updateCamera(dt, 2.5);
    if (Math.hypot(p.x - lv.exit.x, p.y - lv.exit.y) < 60 || d.age > 90) this.startTitle();
  }

  /* ---------- gameplay ---------- */
  updatePlay(dt) {
    if (this.hitStop > 0) { this.hitStop -= dt; dt = 0; }
    const p = this.player, st = this.stats, lv = this.lv;
    this.time += dt;
    this.levelTime += dt;
    this.run.time += dt;
    const c = this.controls();

    // ---- charging & firing pings ----
    let held = c.ping;
    if (this.pingLatch) { if (!held) this.pingLatch = false; held = false; }
    this.pingCd -= dt;
    if (!p.charging) {
      if (held && !this.pingWasHeld) {
        if (p.energy >= PING.costMin && this.pingCd <= 0) {
          p.charging = true; p.charge = 0; this.audio.chargeStart();
        } else if (p.energy < PING.costMin) {
          this.audio.denied(); this.ui.pulseEnergy();
        }
      }
    } else {
      const maxP = clamp((p.energy - PING.costMin) / (PING.costMax - PING.costMin), 0, 1);
      p.charge = Math.min(maxP, p.charge + dt / st.chargeTime);
      this.audio.chargeUpdate(p.charge);
      if (!held) {
        p.charging = false; this.audio.chargeStop();
        this.firePing(p.charge);
      }
    }
    this.pingWasHeld = held;

    // ---- movement ----
    const m = Math.hypot(c.mx, c.my);
    let tx = 0, ty = 0;
    if (m > 0.01) { tx = (c.mx / m) * PLAYER.maxSpeed * Math.min(1, m); ty = (c.my / m) * PLAYER.maxSpeed * Math.min(1, m); }
    p.dashCd -= dt;
    if (c.dash) {
      if (p.dashCd <= 0 && p.energy >= st.dashCost) {
        const dx = m > 0.01 ? c.mx / m : Math.cos(p.angle), dy = m > 0.01 ? c.my / m : Math.sin(p.angle);
        p.vx = dx * PLAYER.dashSpeed; p.vy = dy * PLAYER.dashSpeed;
        p.dashT = PLAYER.dashTime; p.dashCd = st.dashCd; p.energy -= st.dashCost; this.regenDelay = Math.max(this.regenDelay, 0.5);
        this.run.dashes++;
        this.noiseEvent(p.x, p.y, 300 * st.pingLoud, 'dash');
        this.audio.dash();
        for (let i = 0; i < 12; i++) this.particle(p.x, p.y, -dx * 120 + (Math.random() - 0.5) * 80, -dy * 120 + (Math.random() - 0.5) * 80, 0.6, 2.4, 'bubble');
        this.hint('dash', 'Dashing is fast, but it carries far through the water.', 5);
      } else if (p.dashCd > 0 || p.energy < st.dashCost) this.audio.denied();
    }
    if (p.dashT > 0) {
      p.dashT -= dt;
      const f = Math.exp(-2.4 * dt);
      p.vx *= f; p.vy *= f;
    } else {
      const k = m > 0.01 ? PLAYER.accelK : PLAYER.dragK;
      const f = 1 - Math.exp(-k * dt);
      p.vx += (tx - p.vx) * f; p.vy += (ty - p.vy) * f;
    }
    this.applyCurrents(p, dt, 1);
    moveBody(lv, p, p.r, dt, 0.12);
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > 8) p.angle += angleDiff(p.angle, Math.atan2(p.vy, p.vx)) * Math.min(1, dt * 9);
    p.invul = Math.max(0, p.invul - dt);

    // bubbles in the wake
    p.trail -= dt;
    if (p.trail <= 0 && sp > 40) {
      p.trail = 0.07 + Math.random() * 0.06;
      this.particle(p.x - Math.cos(p.angle) * 8, p.y - Math.sin(p.angle) * 8, (Math.random() - 0.5) * 14, -8 - Math.random() * 10, 0.9, 1.2 + Math.random() * 1.2, 'bubble');
    }

    // ---- energy ----
    this.regenDelay -= dt;
    if (this.regenDelay <= 0 && !p.charging) p.energy = Math.min(st.maxEnergy, p.energy + st.regen * dt);
    if (p.energy < 22) this.hint('lowEnergy', 'Energy recharges while you drift. Be patient.', 5);

    // ---- noise you make ----
    const noiseR = clamp((sp - 78) * 1.35, 0, 230) * st.moveNoise;
    if (noiseR > 36) this.noiseEvent(p.x, p.y, noiseR, 'move');

    // ---- decoy buoys ----
    if (c.buoy) this.placeBuoy();
    this.updateBuoys(dt);

    // ---- world ----
    for (const e of this.enemies) {
      if (e.calm > 0) { e.calm -= dt; e.update(this.deaf, dt); }   // just bit you: deaf and blind to your position until the grace timer runs out
      else e.update(this, dt);
    }
    this.updatePings(dt);
    this.updatePickups(dt);
    this.checkCollisions();
    this.updateDanger(dt);

    // ---- exit ----
    const ex = this.exitObj;
    if (Math.hypot(p.x - ex.x, p.y - ex.y) < 26) this.completeLevel();

    this.updateHints();
    this.tickHints(dt);
    this.updateCamera(dt, 6);
  }

  updateDying(dt) {
    this.time += dt * 0.4;
    this.updatePings(dt * 0.5);
    for (const e of this.enemies) e.update(this, dt * 0.25);
    this.updateCamera(dt, 3);
    if (this.stateT > 2.6) this.finishRun(false);
  }

  updateLevelEnd(dt) {
    this.time += dt;
    this.updatePings(dt);
    const p = this.player;
    // glide into the gate
    const ex = this.exitObj;
    p.vx += (ex.x - p.x) * 4 * dt; p.vy += (ex.y - p.y) * 4 * dt;
    p.vx *= Math.exp(-3 * dt); p.vy *= Math.exp(-3 * dt);
    p.x += p.vx * dt; p.y += p.vy * dt;
    this.updateCamera(dt, 4);
    if (this.stateT > 2.0) this.afterLevel();
  }

  updateIdle(dt) {
    this.time += dt;
    this.updatePings(dt);
    for (const e of this.enemies) e.update(this, dt * 0.5);
    this.updateCamera(dt, 3);
  }

  updateFx(dt) {
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 40);
    this.flash = Math.max(0, this.flash - dt * 2.4);
    const sa = this.settings.shake ? this.shakeAmt : 0;
    this.cam.sx = (Math.random() - 0.5) * sa;
    this.cam.sy = (Math.random() - 0.5) * sa;
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.life -= dt;
      if (f.life <= 0) this.floaters.splice(i, 1);
    }
    // particles
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const q = ps[i];
      q.life -= dt;
      if (q.life <= 0) { ps[i] = ps[ps.length - 1]; ps.pop(); continue; }
      q.x += q.vx * dt; q.y += q.vy * dt;
      q.vx *= Math.exp(-1.2 * dt); q.vy *= Math.exp(-1.2 * dt);
      if (q.kind === 'bubble') q.vy -= 14 * dt;
    }
  }

  /* ================================================================ */
  /* Sonar                                                             */
  /* ================================================================ */
  pingTargets() {
    const out = [];
    for (const e of this.enemies) {
      for (const c of e.circles()) out.push({ kind: HK.THREAT, x: c.x, y: c.y, r: c.r, ref: e });
    }
    for (const pk of this.pickups) {
      if (pk.taken) continue;
      out.push({ kind: pk.type === 'pearl' ? HK.PEARL : HK.OTHER, x: pk.x, y: pk.y, r: pk.type === 'pearl' ? 7 : 9, ref: pk });
    }
    out.push({ kind: HK.EXIT, x: this.exitObj.x, y: this.exitObj.y, r: 24, ref: this.exitObj });
    for (const b of this.buoys) out.push({ kind: HK.OTHER, x: b.x, y: b.y, r: 7, ref: b });
    return out;
  }

  spawnPing(x, y, power, o = {}) {
    const ping = createPing(this.lv, x, y, power, {
      rangeMult: o.rangeMult !== undefined ? o.rangeMult : this.stats.rangeMult,
      targets: o.noTargets ? [] : this.pingTargets(),
      kind: o.kind, quiet: o.quiet, scale: o.scale,
    });
    this.pings.push(ping);
    if (this.pings.length > 16) this.pings.shift();
    return ping;
  }

  firePing(power) {
    const p = this.player, st = this.stats;
    const cost = lerp(PING.costMin, PING.costMax, power);
    p.energy = Math.max(0, p.energy - cost);
    this.regenDelay = 0.6; this.pingCd = 0.28;
    this.run.pings++;
    const ping = this.spawnPing(p.x, p.y, power, { kind: 'player' });
    this.noiseEvent(p.x, p.y, ping.maxR * st.pingLoud * 0.9, 'ping', power);
    this.audio.ping(power);
    this.audio.echoes(ping.echoes);
    this.addShake(2 + power * 5);
    for (let i = 0; i < 6; i++) this.particle(p.x, p.y, Math.cos(i) * 40, Math.sin(i) * 40, 0.5, 1.6, 'spark');
    // the controls hint has done its job once the first ping is out: clear it so the next hint can follow
    if (this.hintEl && this.hintCur === 'intro') { this.ui.fadeToast(this.hintEl); this.hintEl = null; this.hintGap = Math.min(this.hintGap, 0.4); }
    this.hint('afterPing', 'Louder pings travel farther and wake the hunters. A quick tap is a whisper.', 6, 1.2, 1);
  }

  updatePings(dt) {
    for (let i = this.pings.length - 1; i >= 0; i--) {
      const p = this.pings[i];
      updatePing(p, dt);
      for (const m of p.marks) {
        if (!m.done && p.r >= m.d) { m.done = true; this.onMark(m, p); }
      }
      if (p.dead) this.pings.splice(i, 1);
    }
  }

  onMark(m, ping) {
    const ref = m.ref;
    if (!ref) return;
    if (ref.snapshot) {
      ref.snapshot(this.time);
      this.hint('creature', 'Orange echoes are creatures. They hunt by sound: drift slowly to stay silent.', 6.5, 0.6, 2);
    } else {
      ref.seen = this.time;
      if (ref === this.exitObj) this.hint('exit', 'There is the gate. Reach its glow to dive deeper.', 5.5, 0.5, 3);
    }
  }

  noiseEvent(x, y, loud, kind, power = 1) {
    for (const e of this.enemies) {
      if (e.calm > 0 && (kind === 'move' || kind === 'dash')) continue;   // swimming away right after a bite must not re-arm the hunter
      e.hear(this, x, y, loud, kind, power);
    }
  }

  /* ================================================================ */
  /* Buoys, pickups, collisions                                        */
  /* ================================================================ */
  placeBuoy() {
    const p = this.player;
    if (p.buoys <= 0) { this.audio.denied(); return; }
    p.buoys--;
    this.run.buoysUsed++;
    const b = { x: p.x - Math.cos(p.angle) * 12, y: p.y - Math.sin(p.angle) * 12, life: this.stats.buoyLife, beep: 0.05, seen: this.time, phase: Math.random() * TAU, type: 'buoy' };
    if (sdfAt(this.lv, b.x, b.y) < 5) { b.x = p.x; b.y = p.y; }
    this.buoys.push(b);
    this.audio.buoyPlace();
  }

  updateBuoys(dt) {
    for (let i = this.buoys.length - 1; i >= 0; i--) {
      const b = this.buoys[i];
      b.life -= dt; b.beep -= dt;
      if (b.beep <= 0) {
        b.beep = 0.95;
        this.spawnPing(b.x, b.y, 0.2, { kind: 'buoy', quiet: true, rangeMult: 1, noTargets: true });
        this.noiseEvent(b.x, b.y, 360, 'buoy');
        const d = Math.hypot(b.x - this.player.x, b.y - this.player.y);
        this.audio.buoyBeep(clamp((b.x - this.player.x) / 450, -1, 1), clamp(1 - d / 900, 0.1, 1));
      }
      if (b.life <= 0) {
        for (let k = 0; k < 10; k++) this.particle(b.x, b.y, (Math.random() - 0.5) * 90, (Math.random() - 0.5) * 90, 0.8, 2, 'spark');
        this.buoys.splice(i, 1);
      }
    }
  }

  updatePickups(dt) {
    const p = this.player, st = this.stats;
    const magnet = st.dowse ? 34 + st.dowse * 40 : 0;
    for (const pk of this.pickups) {
      if (pk.taken) continue;
      pk.phase += dt;
      const dx = p.x - pk.x, dy = p.y - pk.y, d = Math.hypot(dx, dy);
      if (pk.type === 'pearl' && magnet && d < magnet && d > 1) {
        const s = 70 * (1 - d / magnet) + 20;
        pk.x += (dx / d) * s * dt; pk.y += (dy / d) * s * dt;
      }
      if (d < pk.r + p.r) this.collect(pk);
    }
  }

  collect(pk) {
    pk.taken = true;
    const p = this.player;
    if (pk.type === 'pearl') {
      this.run.pearls++; this.levelPearls++;
      this.pearlCombo++;
      this.run.score += 25;
      p.energy = Math.min(this.stats.maxEnergy, p.energy + 10);
      this.audio.pickup('pearl');
      this.hint('pearl', 'Pearls refill a little energy and add to your score.', 5, 0.4, 6);
      for (let i = 0; i < 10; i++) this.particle(pk.x, pk.y, (Math.random() - 0.5) * 120, (Math.random() - 0.5) * 120, 0.7, 2, 'gold');
      this.floatText('+25', pk.x, pk.y, 'hsla(44,100%,72%,A)');
    } else if (pk.type === 'buoy') {
      p.buoys++;
      this.audio.pickup('buoy');
      this.floatText('+1 DECOY', pk.x, pk.y, 'hsla(176,100%,76%,A)');
      this.hint('buoy', 'Press E to drop a decoy. Creatures swarm toward its beeps.', 7);
    } else if (pk.type === 'patch') {
      if (p.hull < p.maxHull) { p.hull++; this.floatText('HULL +1', pk.x, pk.y, 'hsla(135,100%,72%,A)'); }
      else { this.run.score += 60; this.floatText('+60', pk.x, pk.y, 'hsla(44,100%,72%,A)'); }
      this.audio.pickup('patch');
    }
  }

  checkCollisions() {
    const p = this.player;
    if (p.dead) return;
    for (const e of this.enemies) {
      if (e.passive) continue;   // a creature backing off after a bite is harmless for a moment
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
  }

  afterBite(e) {
    // hunters lose their prey for a moment so a hit is a setback, not a death spiral
    if (e.type === 'eel' || e.type === 'leviathan') {
      e.state = 'search'; e.timer = 2.4; e.alert = 0; e.calm = 2.4;
      const p = this.player, d = Math.hypot(e.x - p.x, e.y - p.y) || 1;
      e.vx += ((e.x - p.x) / d) * 380; e.vy += ((e.y - p.y) / d) * 380;   // recoil, so it is not still sitting on you when the invulnerability ends
    }
    if (e.type === 'angler') { e.state = 'recover'; e.timer = 2.2; }
    if (e.type === 'jelly') { const d = Math.hypot(e.x - this.player.x, e.y - this.player.y) || 1; e.vx += ((e.x - this.player.x) / d) * 120; e.vy += ((e.y - this.player.y) / d) * 120; }
  }

  hurt(dmg, sx, sy) {
    const p = this.player;
    if (p.invul > 0 || p.dead || this.god || this.state !== 'play') return;
    p.hull -= dmg; p.invul = PLAYER.hurtInvul;
    this.levelHurt = true; this.run.hits++;
    const dx = p.x - sx, dy = p.y - sy, d = Math.hypot(dx, dy) || 1;
    p.vx = (dx / d) * 280; p.vy = (dy / d) * 280; p.dashT = 0.18;
    this.addShake(18); this.flash = 1; this.hitStop = 0.07;
    this.audio.hit();
    for (let i = 0; i < 18; i++) this.particle(p.x, p.y, (Math.random() - 0.5) * 220, (Math.random() - 0.5) * 220, 0.9, 2.4, 'hurt');
    this.spawnPing(p.x, p.y, 0.3, { kind: 'impact', quiet: true });
    this.hint('hurt', 'Creatures that touch you cost hull. Dashing (SHIFT) can get you out.', 6);
    if (p.hull <= 0) this.die();
  }

  die() {
    const p = this.player;
    if (p.dead || this.state !== 'play') return;   // not while a gate is closing, paused, or already dying
    p.dead = true; p.hull = 0; p.charging = false;
    this.audio.chargeStop();
    this.audio.setDanger(0);
    this.audio.gameOver();
    this.state = 'dying'; this.stateT = 0;
    for (let i = 0; i < 50; i++) this.particle(p.x, p.y, (Math.random() - 0.5) * 340, (Math.random() - 0.5) * 340, 1.6, 2.6, 'hurt');
    this.spawnPing(p.x, p.y, 1, { kind: 'death', quiet: true, noTargets: false });
    this.ui.setMode('dying');
  }

  updateDanger(dt) {
    const p = this.player;
    let dg = 0;
    for (const e of this.enemies) {
      if (e.type === 'urchin') continue;
      const cs = e.circles();
      let d = 1e9;
      for (const c of cs) d = Math.min(d, Math.hypot(c.x - p.x, c.y - p.y) - c.r);
      const range = e.type === 'leviathan' ? 430 : 250;
      let k = clamp(1 - d / range, 0, 1);
      k = e.state === 'chase' ? 0.45 + 0.55 * k : k * 0.55;
      if (e.type === 'jelly') k *= 0.5;
      dg = Math.max(dg, k);
    }
    this.danger += (dg - this.danger) * (1 - Math.exp(-4 * dt));
    this.audio.setDanger(this.danger);
    if (this.danger > 0.5) this.hint('hunted', 'Something heard you. Go still, or drop a decoy (E) to pull it away.', 6.5, 0.4, 4);
  }

  /* ================================================================ */
  /* Level completion & meta                                           */
  /* ================================================================ */
  completeLevel() {
    if (this.state !== 'play') return;
    const run = this.run, p = this.player;
    this.state = 'levelend'; this.stateT = 0;
    p.charging = false; this.audio.chargeStop();
    const base = 100 + run.depth * 30;
    const timeBonus = Math.max(0, Math.round(240 - this.levelTime * 2));
    const flawless = this.levelHurt ? 0 : 120;
    run.score += base + timeBonus + flawless;
    this.levelSummary = { depth: run.depth, base, timeBonus, flawless, pearls: this.levelPearls, time: this.levelTime, total: base + timeBonus + flawless + this.levelPearls * 25 };
    this.audio.levelComplete();
    this.flash = 0.6;
    this.spawnPing(this.exitObj.x, this.exitObj.y, 1, { kind: 'victory', quiet: true });
    this.ui.setMode('levelend');
    if (run.depth > this.best.depth && !run.daily) { this.best.depth = run.depth; save('best', this.best); }
    if (run.depth > (this.best.endless || 0)) { this.best.endless = run.depth; save('best', this.best); }
  }

  afterLevel() {
    const run = this.run;
    if (run.depth >= MAX_DEPTH && !run.won) {
      run.won = true;
      this.finishRun(true);
      return;
    }
    this.offerUpgrades();
  }

  // 1-of-3 refit picker; with every upgrade maxed there is nothing to offer, so skip straight to the next depth
  offerUpgrades() {
    const run = this.run;
    const choices = pickUpgrades(this.rng.sub('up' + run.depth), run.ups, 3);
    this.upgradeChoices = choices;
    if (!choices.length) { this.nextLevel(); return; }
    this.state = 'upgrade'; this.stateT = 0;
    this.ui.showUpgrade(choices, run, this.levelSummary);
    this.ui.setMode('upgrade');
  }

  chooseUpgrade(id) {
    if (this.state !== 'upgrade') return;
    const run = this.run, p = this.player;
    const def = UPGRADES.find((u) => u.id === id);
    if (!def || (run.ups[id] || 0) >= def.max) return;
    run.ups[id] = (run.ups[id] || 0) + 1;
    this.stats = computeStats(run.ups);
    p.maxHull = this.stats.maxHull;
    if (id === 'hull') p.hull = Math.min(p.maxHull, p.hull + 1);
    if (id === 'decoy') p.buoys += 2;
    this.audio.ui('upgrade');
    this.ui.hideUpgrade();
    this.nextLevel();
  }

  // folds a run into the saved records (max semantics, so calling it again is harmless); says what improved
  recordBest(run) {
    const prevBest = run.startBest || { depth: this.best.depth, score: this.best.score };   // records before this run began
    const depthReached = run.depth;
    let newDaily = false;
    if (run.daily) {
      const t = run.date || todayStr();   // the day the run STARTED (a dive that crosses midnight UTC still counts for its own cave)
      if (this.best.daily.date !== t) this.best.daily = { date: t, depth: 0, score: 0 };
      const d = this.best.daily;
      if (depthReached > d.depth || (depthReached === d.depth && run.score > d.score)) {
        newDaily = true; d.depth = depthReached; d.score = run.score;
      }
    }
    const newScore = run.score > this.best.score;
    if (newScore) this.best.score = run.score;
    const newDepth = !run.daily && depthReached > prevBest.depth;
    if (depthReached > this.best.depth && !run.daily) this.best.depth = depthReached;
    save('best', this.best);
    return { newScore, newDepth, newDaily, best: this.best };
  }

  // quitting to the title (or closing the tab) mid-dive still banks the score and depth reached
  abandonRun() {
    const run = this.run;
    if (run && !run.over && this.state !== 'title') this.recordBest(run);
  }

  finishRun(won) {
    const run = this.run;
    if (!run || this.state === 'gameover' || this.state === 'victory') return;
    run.over = true; run.won = run.won || won;
    const info = this.recordBest(run);
    this.state = won ? 'victory' : 'gameover'; this.stateT = 0;
    if (won) this.audio.victory();
    this.ui.showEnd(won, run, info);
    this.ui.setMode(won ? 'victory' : 'gameover');
  }

  continueEndless() {
    if (!this.run || this.state !== 'victory') return;
    this.run.endless = true; this.run.over = false;
    this.offerUpgrades();
  }

  pause() {
    if (this.state !== 'play') return false;
    this.prevState = this.state;
    this.state = 'paused';
    this.player.charging = false; this.audio.chargeStop();
    this.ui.setMode('paused');
    return true;
  }

  resume() {
    if (this.state !== 'paused') return false;
    this.state = this.prevState;
    this.pingLatch = true;
    this.ui.setMode('play');
    return true;
  }

  /* ================================================================ */
  /* Helpers                                                           */
  /* ================================================================ */
  applyCurrents(e, dt, mult) {
    const cs = this.lv.currents;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      const dx = e.x - c.x, dy = e.y - c.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > c.r * c.r) continue;
      const w = 1 - Math.sqrt(d2) / c.r;
      const f = c.force * w * w * (3 - 2 * w) * mult * dt;
      e.vx += Math.cos(c.ang) * f; e.vy += Math.sin(c.ang) * f;
    }
  }

  snd(name, x, y, gain = 1) {
    if (!this.audio.ok) return;
    const p = this.player;
    const dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy);
    const att = clamp(1 - d / 950, 0, 1);
    if (att < 0.03) return;
    const fn = this.audio[name];
    if (fn) fn.call(this.audio, clamp(dx / 450, -1, 1), gain * Math.pow(att, 1.5));
  }

  addShake(a) { this.shakeAmt = Math.min(26, Math.max(this.shakeAmt, a)); }

  floatText(text, x, y, color) {
    this.floaters.push({ text, x, y, color, life: 1.1, max: 1.1 });
  }

  particle(x, y, vx, vy, life, size, kind) {
    if (this.particles.length > 700) return;
    this.particles.push({ x, y, vx, vy, life, max: life, size, kind });
  }

  // Hints are queued and shown strictly one at a time (lowest prio number first, then oldest), each at most once ever.
  // prio: 0 controls, 1 what pings do, 2 creatures, 3 the gate, 5+ situational.
  hint(id, text, dur = 6, delay = 0, prio = 5) {
    if (!this.settings.hints || this.hintsSeen[id] || !this.run || this.hintQ.some((h) => h.id === id)) return;
    this.hintQ.push({ id, text, dur, wait: delay, prio, n: this.hintN++ });
  }

  tickHints(dt) {
    const q = this.hintQ;
    this.hintGap -= dt;
    if (!q.length) return;
    for (const h of q) h.wait -= dt;
    if (this.hintGap > 0 || !this.settings.hints) return;
    let b = 0;   // strict order: the most important queued hint goes first, and a not-yet-due one holds the others back
    for (let i = 1; i < q.length; i++) if (q[i].prio < q[b].prio || (q[i].prio === q[b].prio && q[i].n < q[b].n)) b = i;
    if (q[b].wait > 0) return;
    const h = q.splice(b, 1)[0];
    if (this.hintsSeen[h.id]) return;
    this.hintsSeen[h.id] = true; save('hints', this.hintsSeen);
    this.hintEl = this.ui.toast(h.text, h.dur * 1000, 'hint'); this.hintCur = h.id;
    this.hintGap = h.dur + 1.0;
  }

  updateHints() {
    const run = this.run;
    if (run.depth === 1) {
      // controls first (skipped for anyone who already pinged), then what a ping does, then creatures, then the gate
      if (this.levelTime > 1.0 && run.pings === 0) this.hint('intro', 'Swim with WASD. Hold SPACE to charge a sonar ping, release to send it into the dark.', 6.5, 0, 0);
      if (this.levelTime > 20 && run.pings === 0) this.hint('pingNudge', 'Lost in the dark? Hold SPACE, then let go: your sonar paints the cave around you.', 6, 0, 0);
      if (this.levelTime > 16 && this.exitObj.seen < 0) this.hint('exit', 'Find the glowing gate to dive deeper. The faint arrow beside your craft points the way.', 6.5, 0, 3);
    }
  }

  updateCamera(dt, k) {
    const p = this.player, c = this.cam;
    const tz = p.charging ? 1 - 0.06 * p.charge : 1;
    c.zoom += (tz - c.zoom) * (1 - Math.exp(-5 * dt));
    const look = this.state === 'title' ? 0.6 : 0.34;
    let tx = p.x + p.vx * look, ty = p.y + p.vy * look;
    const lv = this.lv;
    const hw = this.view.w / 2 / c.zoom, hh = this.view.h / 2 / c.zoom;
    if (lv.width > hw * 2) tx = clamp(tx, hw - 40, lv.width - hw + 40); else tx = lv.width / 2;
    if (lv.height > hh * 2) ty = clamp(ty, hh - 40, lv.height - hh + 40); else ty = lv.height / 2;
    const f = 1 - Math.exp(-k * dt);
    c.x += (tx - c.x) * f; c.y += (ty - c.y) * f;
  }
}
