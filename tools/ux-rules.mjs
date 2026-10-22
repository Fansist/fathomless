// UX lens: verifies the numbers and rules in the browser with the deterministic frozen stepper (60 Hz fixed steps).
// Usage: node tools/ux-rules.mjs   (exit code 1 on any failed check)
import { launch, sleep } from './harness.mjs';
const h = await launch({});
const { page } = h;
const ev = (fn, ...a) => page.evaluate(fn, ...a);
let fails = 0, total = 0;
const check = (name, ok, info) => {
  total++;
  if (!ok) { fails++; console.log('  FAIL  ' + name + (info !== undefined ? '  -> ' + JSON.stringify(info) : '')); }
  else console.log('  ok    ' + name);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

await page.goto(h.url + '/index.html?noaudio=1', { waitUntil: 'load' });
await sleep(600);
await ev(async () => {
  const f = window.__fathom;
  f.freeze(true);
  f.renderer.frame = function () {};
  window.W = await import('/js/world.js'); window.E = await import('/js/entities.js'); window.C = await import('/js/config.js'); window.S = await import('/js/sonar.js');
  window.__ctl = { mx: 0, my: 0, ping: false, dash: false, buoy: false };
  f.game.bot = () => { const c = { ...window.__ctl }; window.__ctl.dash = false; window.__ctl.buoy = false; return c; };
  window.step = (n) => { for (let i = 0; i < n; i++) f.game.update(1 / 60); };
  window.fresh = (seed, depth = 1, clear = true) => {
    f.start(seed, depth);
    const g = f.game;
    if (clear) { g.enemies.length = 0; g.pickups.length = 0; g.buoys.length = 0; }
    g.god = false; g.pings.length = 0;
    const p = g.player; p.invul = 0; p.energy = g.stats.maxEnergy; p.hull = p.maxHull; p.dashCd = 0; p.charging = false; p.charge = 0;
    g.pingLatch = false; g.pingCd = 0; g.regenDelay = 0; g.pingWasHeld = false;
    window.__ctl.mx = window.__ctl.my = 0; window.__ctl.ping = false;
    return g;
  };
  window.spy = (obj, name) => { const o = obj[name]; const log = []; obj[name] = function (...a) { log.push(a); return o.apply(this, a); }; return { log, restore: () => { obj[name] = o; } }; };
});

console.log('== A. sonar ping: cost 9..42 by charge, charge time 0.95 s');
for (const hold of [1, 15, 29, 57, 90]) {
  const r = await ev((hold) => {
    const g = window.fresh('rules-ping', 1), p = g.player;
    const e0 = p.energy;
    window.__ctl.ping = true; window.step(hold);
    const chargeAt = p.charge;
    window.__ctl.ping = false; window.step(1);
    return { hold, spent: +(e0 - p.energy).toFixed(2), chargeAt: +chargeAt.toFixed(3), pings: g.run.pings, maxCharge: 1 };
  }, hold);
  const power = Math.min(1, hold / 57);
  const want = 9 + 33 * power;
  check(`hold ${hold} steps (${(hold / 60).toFixed(2)} s): cost ~${want.toFixed(1)}`, near(r.spent, want, 0.6) && r.pings === 1, r);
}
const ct = await ev(() => { const g = window.fresh('rules-ct', 1), st = g.stats; return { chargeTime: st.chargeTime }; });
check('base charge time is 0.95 s', near(ct.chargeTime, 0.95, 1e-9), ct);

console.log('== B. energy regen: 0.6 s delay, then 7 per second');
{
  const r = await ev(() => {
    const g = window.fresh('rules-regen', 1), p = g.player;
    p.energy = 40; window.__ctl.ping = true; window.step(1); window.__ctl.ping = false; window.step(1);   // whisper
    const e0 = p.energy;
    window.step(30); const e1 = p.energy;       // 0.5 s: still delayed
    window.step(66); const e2 = p.energy;       // total 1.6 s since firing
    return { e0, e1, e2, gain: e2 - e0 };
  });
  check('no regen during the 0.6 s delay', near(r.e1, r.e0, 0.001), r);
  check('regen ~7/s afterwards (1.6 s total -> ~7.0 gained)', near(r.gain, 7.0, 0.8), r);
}

console.log('== C. cannot ping below 9 energy (denied feedback)');
{
  const r = await ev(() => {
    const g = window.fresh('rules-deny', 1), p = g.player;
    const sa = window.spy(g.audio, 'denied'), sp = window.spy(g.ui, 'pulseEnergy');
    p.energy = 8.5; g.regenDelay = 99;
    window.__ctl.ping = true; window.step(5); const charging = p.charging; window.__ctl.ping = false; window.step(2);
    const out = { charging, pings: g.run.pings, denied: sa.log.length, pulsed: sp.log.length };
    sa.restore(); sp.restore();
    return out;
  });
  check('no charge started, no ping, audio denied + HUD pulse once', !r.charging && r.pings === 0 && r.denied === 1 && r.pulsed === 1, r);
  const r2 = await ev(() => {
    const g = window.fresh('rules-low', 1), p = g.player;
    p.energy = 10; g.regenDelay = 99;
    window.__ctl.ping = true; window.step(80); const charge = p.charge; window.__ctl.ping = false; window.step(1);
    return { charge: +charge.toFixed(3), energy: +p.energy.toFixed(2), pings: g.run.pings };
  });
  check('with 10 energy the charge is capped so the ping never overdraws', r2.pings === 1 && r2.energy >= 0 && r2.energy < 0.6, r2);
}

console.log('== D. dash: cost 20, cooldown 1.5 s, loud');
{
  const r = await ev(() => {
    const g = window.fresh('rules-dash', 1), p = g.player;
    const e0 = p.energy;
    window.__ctl.mx = 1; window.__ctl.dash = true; window.step(1);
    const out = { spent: e0 - p.energy, cd: p.dashCd, dashes: g.run.dashes };
    window.__ctl.dash = true; window.step(1);             // still on cooldown
    out.dashes2 = g.run.dashes;
    window.step(80); window.__ctl.dash = true; window.step(1); out.dashesAt1_4 = g.run.dashes;   // ~1.4 s
    window.step(10); p.energy = 100; window.__ctl.dash = true; window.step(1); out.dashesAfter = g.run.dashes;
    p.dashCd = 0; p.energy = 19; window.__ctl.dash = true; window.step(1); out.dashesLow = g.run.dashes;
    return out;
  });
  check('dash costs 20 and starts a 1.5 s cooldown', near(r.spent, 20, 0.2) && near(r.cd, 1.5, 0.02) && r.dashes === 1, r);
  check('cannot dash on cooldown, can after 1.5 s, not with <20 energy', r.dashes2 === 1 && r.dashesAt1_4 === 1 && r.dashesAfter === 2 && r.dashesLow === 2, r);
}

console.log('== E. damage: 1.8 s invulnerability, hull pips, death, afterBite escape window');
{
  const r = await ev(() => {
    const g = window.fresh('rules-hurt', 1), p = g.player;
    g.hurt(1, p.x + 5, p.y);
    const out = { hull: p.hull, invul: +p.invul.toFixed(2) };
    g.hurt(1, p.x + 5, p.y); out.hullAfterSecond = p.hull;
    window.step(5 + 100); g.hurt(1, p.x + 5, p.y); out.hullAt1_67 = p.hull;   // 5 hit-stop steps + 1.67 s: still invulnerable
    window.step(12); g.hurt(1, p.x + 5, p.y); out.hullAt1_87 = p.hull;        // 1.87 s: vulnerable again
    return out;
  });
  check('hit costs 1 pip and grants 1.8 s invulnerability', r.hull === 2 && near(r.invul, 1.8, 0.02) && r.hullAfterSecond === 2 && r.hullAt1_67 === 2 && r.hullAt1_87 === 1, r);
  const r2 = await ev(() => {
    const g = window.fresh('rules-collide', 1, true), p = g.player;
    // an urchin on top of the player
    g.enemies.push(window.E.makeEnemy('urchin', { x: p.x, y: p.y }, 1));
    window.step(2);
    return { hull: p.hull, invul: +p.invul.toFixed(2), state: g.state };
  });
  check('real collision with an urchin takes a pip', r2.hull === 2 && r2.invul > 1.7, r2);
  const r3 = await ev(() => {
    const g = window.fresh('rules-bite', 6, true), p = g.player;
    const eel = window.E.makeEnemy('eel', { x: p.x + 4, y: p.y }, 6);
    eel.state = 'chase'; eel.alert = 5; g.enemies.push(eel);
    window.step(2);
    const out = { state: eel.state, timer: +eel.timer.toFixed(2), hull: p.hull, calm: +eel.calm.toFixed(2) };
    let chased = false; for (let i = 0; i < 60 * 2.2; i++) { window.step(1); if (eel.state === 'chase') chased = true; }
    out.chasedInWindow = chased; out.hullAfter = p.hull;
    return out;
  });
  check('afterBite: hunter drops to search and cannot re-arm itself for the 2.4 s escape window', r3.state === 'search' && r3.timer > 2.2 && r3.hull === 2 && r3.calm > 2.3 && !r3.chasedInWindow && r3.hullAfter === 2, r3);
  const r4 = await ev(() => {
    const g = window.fresh('rules-die', 1), p = g.player;
    for (let i = 0; i < 3; i++) { p.invul = 0; g.hurt(1, p.x + 3, p.y); }
    const out = { state: g.state, hull: p.hull };
    window.step(60 * 3); out.after = g.state;
    return out;
  });
  check('3 hull pips: third hit kills, dying -> gameover after ~2.6 s', r4.state === 'dying' && r4.hull === 0 && r4.after === 'gameover', r4);
}

console.log('== F. pickups: pearl +25 & +10 energy, patch heal, decoy pickup');
{
  const r = await ev(() => {
    const g = window.fresh('rules-pick', 1), p = g.player;
    p.energy = 50; g.regenDelay = 99;
    g.pickups.push({ type: 'pearl', x: p.x, y: p.y, r: 8, taken: false, seen: -999, phase: 0 });
    window.step(2);
    const out = { score: g.run.score, energy: p.energy, pearls: g.run.pearls };
    p.hull = 1;
    g.pickups.push({ type: 'patch', x: p.x, y: p.y, r: 11, taken: false, seen: -999, phase: 0 }); window.step(2);
    out.hullAfterPatch = p.hull;
    p.hull = p.maxHull; const s0 = g.run.score;
    g.pickups.push({ type: 'patch', x: p.x, y: p.y, r: 11, taken: false, seen: -999, phase: 0 }); window.step(2);
    out.patchFull = g.run.score - s0; out.hullFull = p.hull;
    const b0 = p.buoys;
    g.pickups.push({ type: 'buoy', x: p.x, y: p.y, r: 10, taken: false, seen: -999, phase: 0 }); window.step(2);
    out.buoys = p.buoys - b0;
    return out;
  });
  check('pearl: +25 score, +10 energy', r.score === 25 && near(r.energy, 60, 0.01) && r.pearls === 1, r);
  check('patch heals 1 hull; at full hull gives +60 score instead', r.hullAfterPatch === 2 && r.patchFull === 60 && r.hullFull === 3, r);
  check('decoy pickup +1', r.buoys === 1, r);
}

console.log('== G. decoy buoys: placement, lifetime 7 s, beep every ~0.95 s, noise');
{
  const r = await ev(() => {
    const g = window.fresh('rules-buoy', 1), p = g.player;
    const noise = [];
    const o = g.noiseEvent.bind(g); g.noiseEvent = (x, y, l, k, pw) => { noise.push([k, l]); o(x, y, l, k, pw); };
    const b0 = p.buoys;
    window.__ctl.buoy = true; window.step(1);
    const out = { buoys: b0 - p.buoys, placed: g.buoys.length, life: g.buoys[0] && +g.buoys[0].life.toFixed(2), used: g.run.buoysUsed };
    window.step(60 * 2); out.beeps2s = noise.filter((n) => n[0] === 'buoy').length; out.beepLoud = (noise.find((n) => n[0] === 'buoy') || [])[1];
    window.step(60 * 4.8); out.alive6_8 = g.buoys.length;
    window.step(60 * 0.6); out.alive7_4 = g.buoys.length;
    p.buoys = 0; window.__ctl.buoy = true; window.step(1); out.noneLeft = g.buoys.length;
    g.noiseEvent = o;
    return out;
  });
  check('E drops one decoy (inventory -1, run stat +1)', r.buoys === 1 && r.placed === 1 && r.used === 1, r);
  check('decoy lasts ~7 s', near(r.life, 7, 0.1) && r.alive6_8 === 1 && r.alive7_4 === 0, r);
  check('decoy beeps ~every 0.95 s with noise radius 360', r.beeps2s >= 2 && r.beeps2s <= 3 && r.beepLoud === 360, r);
  check('no decoy dropped with an empty inventory', r.noneLeft === 0, r);
}

console.log('== H. level-end scoring');
{
  const r = await ev(() => {
    const out = {};
    for (const [depth, t, hurt] of [[1, 30, false], [4, 100, true], [7, 200, false]]) {
      const g = window.fresh('rules-score', depth), run = g.run;
      g.levelTime = t; g.levelHurt = hurt;
      const s0 = run.score; g.completeLevel();
      const want = 100 + 30 * depth + Math.max(0, 240 - 2 * t) + (hurt ? 0 : 120);
      out[`d${depth}`] = { got: run.score - s0, want, sum: g.levelSummary.total };
    }
    return out;
  });
  for (const k of Object.keys(r)) check(`score ${k}: base 100+30d + max(0,240-2t) + flawless 120`, r[k].got === r[k].want, r[k]);
  const r2 = await ev(() => {
    const g = window.fresh('rules-score2', 3);
    g.completeLevel(); const s = g.run.score; g.completeLevel(); g.completeLevel();
    return { s, after: g.run.score, state: g.state };
  });
  check('completeLevel twice is a no-op', r2.s === r2.after && r2.state === 'levelend', r2);
}

console.log('== I. upgrades through chooseUpgrade');
{
  const r = await ev(() => {
    const out = [];
    for (const u of window.C.UPGRADES) {
      const g = window.fresh('rules-up-' + u.id, 2), p = g.player;
      p.hull = 2; const b0 = p.buoys;
      g.state = 'upgrade'; g.chooseUpgrade(u.id);
      const want = window.C.computeStats({ [u.id]: 1 });
      const same = JSON.stringify(g.stats) === JSON.stringify(want);
      out.push({ id: u.id, same, hull: p.hull, maxHull: p.maxHull, buoys: p.buoys - b0, depth: g.run.depth, state: g.state, energy: p.energy, maxEnergy: g.stats.maxEnergy });
    }
    return out;
  });
  for (const u of r) {
    const hullOk = u.id === 'hull' ? (u.maxHull === 4 && u.hull === 3) : (u.maxHull === 3 && u.hull === 2);
    const buoyOk = u.id === 'decoy' ? u.buoys === 2 : u.buoys === 0;
    check(`upgrade ${u.id}: stats from computeStats, hull/buoy effect, next depth, energy refilled`, u.same && hullOk && buoyOk && u.depth === 3 && u.state === 'play' && u.energy === u.maxEnergy, u);
  }
  const r2 = await ev(() => {
    const g = window.fresh('rules-cap', 2);
    g.state = 'upgrade'; g.run.ups.lens = 3; g.chooseUpgrade('lens');
    return { lens: g.run.ups.lens, state: g.state };
  });
  check('an upgrade at max level cannot be taken again', r2.lens === 3 && r2.state === 'upgrade', r2);
  const r3 = await ev(() => {
    const g = window.fresh('rules-maxed', 2);
    for (const u of window.C.UPGRADES) g.run.ups[u.id] = u.max;
    g.stats = window.C.computeStats(g.run.ups);
    g.completeLevel(); window.step(60 * 2.1);
    return { state: g.state, depth: g.run.depth, layer: document.getElementById('upgrade').classList.contains('show') };
  });
  check('all upgrades maxed: picker is skipped cleanly into the next depth', r3.state === 'play' && r3.depth === 3 && !r3.layer, r3);
}

console.log('== J. hints: once only, one at a time, sensible order');
{
  const r = await ev(() => {
    const f = window.__fathom, g = window.fresh('rules-hints', 1, false);
    localStorage.clear(); g.hintsSeen = {}; g.hintQ.length = 0; g.hintGap = 0; g.settings.hints = true;
    const log = [];
    const o = g.ui.toast.bind(g.ui); g.ui.toast = (text, ms, key) => { log.push({ t: +g.levelTime.toFixed(1), text: text.slice(0, 28), ms, end: null }); return o(text, ms, key); };
    const of = g.ui.fadeToast.bind(g.ui); g.ui.fadeToast = (el) => { if (log.length && log[log.length - 1].end === null) log[log.length - 1].end = g.levelTime; return of(el); };
    // pin one jelly in plain sight
    const p = g.player;
    let ang = 0, best = 0;
    for (let a = 0; a < 6.28; a += 0.2) { const d = window.W.rayMarch(g.lv, p.x, p.y, Math.cos(a), Math.sin(a), 300); if (d > best) { best = d; ang = a; } }
    const dist = Math.min(120, best - 30);
    const jelly = g.enemies.find((e) => e.type === 'jelly') || window.E.makeEnemy('jelly', { x: 0, y: 0 }, 1);
    if (!g.enemies.includes(jelly)) g.enemies.push(jelly);
    jelly.x = p.x + Math.cos(ang) * dist; jelly.y = p.y + Math.sin(ang) * dist; jelly.vx = jelly.vy = 0;
    window.__ctl.mx = window.__ctl.my = 0;
    // idle 3 s, then ping (twice, to see that nothing repeats), keep a jelly in view
    window.step(180);
    window.__ctl.ping = true; window.step(20); window.__ctl.ping = false; window.step(30);
    for (let k = 0; k < 3; k++) { p.energy = 100; g.pingCd = 0; window.__ctl.ping = true; window.step(10); window.__ctl.ping = false; window.step(60 * 4); jelly.x = p.x + Math.cos(ang) * dist; jelly.y = p.y + Math.sin(ang) * dist; }
    window.step(60 * 30);
    g.ui.toast = o;
    const stacked = document.querySelectorAll('#toasts .toast').length;
    return { log, stacked };
  });
  console.log('   hint log:', r.log.map((x) => `${x.t}s "${x.text}"`).join(' | '));
  const texts = r.log.map((x) => x.text);
  const idx = (s) => texts.findIndex((t) => t.startsWith(s));
  check('controls hint comes first', idx('Swim with WASD') === 0, texts);
  check('ping explanation comes after the controls hint', idx('Louder pings') > idx('Swim with WASD'), texts);
  check('creature hint comes after the ping explanation', idx('Orange echoes') > idx('Louder pings'), texts);
  const gaps = r.log.slice(1).map((x, i) => x.t - (r.log[i].end !== null ? r.log[i].end : r.log[i].t + r.log[i].ms / 1000));
  check('hints never overlap (each starts after the previous one ended)', gaps.every((g) => g >= -0.05), gaps);
  check('every hint shows at most once', new Set(texts).size === texts.length, texts);
  check('at most 1 toast element on screen from hints', r.stacked <= 1, r.stacked);
}

console.log('== K. endless mode: spawn table, generation time, leviathan');
{
  const r = await ev(() => {
    const out = {};
    for (const d of [12, 13, 20, 40]) {
      const tb = window.C.spawnTable(d), sz = window.C.levelSize(d);
      const g = window.fresh('rules-endless-' + d, 12);
      const t0 = performance.now(); g.loadLevel(d); const ms = performance.now() - t0;
      out[d] = { table: tb, size: sz, ms: +ms.toFixed(0), enemies: g.enemies.length, leviathans: g.enemies.filter((e) => e.cfg && e.cfg.type === 'leviathan').length, biome: g.lv.biome.name, depth: g.run.depth };
    }
    return out;
  });
  for (const d of Object.keys(r)) console.log(`   depth ${d}: ${r[d].ms} ms, ${r[d].enemies} enemies, leviathans ${r[d].leviathans}, ${r[d].biome}, table ${JSON.stringify(r[d].table)}`);
  check('depth 13/20/40 load under 1.2 s (single hitch, level-start only)', [13, 20, 40].every((d) => r[d].ms < 1200), Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.ms])));
  check('leviathan spawns on depth 12 and in endless', [12, 13, 20, 40].every((d) => r[d].leviathans === 1), Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.leviathans])));
  check('spawn table growth is bounded (<= 9 urchins, <= 8 jellies, <= 5 eels)', [13, 20, 40].every((d) => r[d].table.urchin <= 9 && r[d].table.jelly <= 8 && r[d].table.eel <= 5), r[40].table);
  check('hull-defining pearls grow slowly (<= 65 at depth 40)', r[40].table.pearls <= 65, r[40].table.pearls);
}

console.log('== L. best score / depth persistence, daily mode, determinism across reloads');
{
  const r = await ev(() => {
    localStorage.clear();
    const g = window.fresh('rules-best', 3);
    g.best = window.__fathom.game.constructor.sanitizeBest(null);
    g.run.startBest = { depth: 0, score: 0 };
    g.run.score = 4321; g.finishRun(false);
    return JSON.parse(localStorage.getItem('fathomless.best'));
  });
  check('best score & depth saved to localStorage', r.score === 4321 && r.depth === 3, r);
  const ab = await ev(() => {
    const g = window.fresh('rules-abandon', 5);
    g.run.score = 9000; g.abandonRun();
    const b1 = JSON.parse(localStorage.getItem('fathomless.best'));
    g.abandonRun(); g.abandonRun();
    const b2 = JSON.parse(localStorage.getItem('fathomless.best'));
    g.startTitle(); g.abandonRun();                                  // no run: must not throw
    const b3 = JSON.parse(localStorage.getItem('fathomless.best'));
    return { b1, same: JSON.stringify(b1) === JSON.stringify(b2) && JSON.stringify(b2) === JSON.stringify(b3) };
  });
  check('abandoning a dive banks its score + depth (idempotent, safe without a run)', ab.b1.score === 9000 && ab.b1.depth === 5 && ab.same, ab);
  const daily1 = await ev(() => {
    const f = window.__fathom; f.game.startRun({ daily: true });
    const g = f.game, lv = g.lv;
    let hsh = 2166136261; for (let i = 0; i < lv.sdf.length; i++) { hsh ^= Math.round(lv.sdf[i] * 4) & 0xffff; hsh = Math.imul(hsh, 16777619) >>> 0; }
    g.run.score = 777; g.run.depth = 2; g.finishRun(false);
    return { seed: g.run.seed, hash: hsh, best: JSON.parse(localStorage.getItem('fathomless.best')) };
  });
  const today = new Date().toISOString().slice(0, 10);
  check('daily seed is daily-YYYY-MM-DD (UTC)', daily1.seed === 'daily-' + today, daily1.seed);
  check('per-day best stored', daily1.best.daily.date === today && daily1.best.daily.depth === 2 && daily1.best.daily.score === 777, daily1.best.daily);
  check('daily run does not raise the global deepest dive', daily1.best.depth === 5, daily1.best);
  await page.reload({ waitUntil: 'load' });
  await sleep(500);
  const daily2 = await ev(async () => {
    const f = window.__fathom; f.freeze(true); f.renderer.frame = function () {};
    f.game.startRun({ daily: true });
    const lv = f.game.lv;
    let hsh = 2166136261; for (let i = 0; i < lv.sdf.length; i++) { hsh ^= Math.round(lv.sdf[i] * 4) & 0xffff; hsh = Math.imul(hsh, 16777619) >>> 0; }
    return { seed: f.game.run.seed, hash: hsh, best: f.game.best, title: document.getElementById('dailyBest').textContent, bestLine: document.getElementById('bestLine').textContent };
  });
  check('same daily seed -> identical level (sdf hash) after a reload', daily2.hash === daily1.hash, { a: daily1.hash, b: daily2.hash });
  check('best records survive the reload', daily2.best.score === 9000 && daily2.best.daily.depth === 2, daily2.best);
  console.log('   title lines:', JSON.stringify(daily2.title), '|', JSON.stringify(daily2.bestLine));
}

console.log('== M. errors');
const real = h.errors.filter((e) => !/AudioContext encountered an error from the audio device/.test(e));
check('no page / console errors', real.length === 0, real.slice(0, 5));
console.log(`\n${total - fails}/${total} checks passed`);
await h.close();
process.exit(fails ? 1 : 0);
