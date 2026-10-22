// UX lens robustness: random-input soak, hostile storage, dt spikes, title regeneration cost, heap growth over 100 level
// loads, listener / DOM / toast leaks, fake gamepad. Usage: node tools/ux-robust.mjs  (exit code 1 on failure)
import { launch, sleep } from './harness.mjs';
import puppeteer from 'puppeteer-core';
let fails = 0, total = 0;
const check = (name, ok, info) => {
  total++;
  if (!ok) { fails++; console.log('  FAIL  ' + name + (info !== undefined ? '  -> ' + JSON.stringify(info) : '')); }
  else console.log('  ok    ' + name);
};
const real = (errs) => errs.filter((e) => !/AudioContext encountered an error from the audio device/.test(e));

/* ---------------------------------------------------------------- 1. soak */
console.log('== 1. 5000-step random-input soak at depths 1, 6, 12 (god + mortal)');
{
  const h = await launch({});
  const { page } = h;
  await page.goto(h.url + '/index.html?noaudio=1', { waitUntil: 'load' });
  await sleep(500);
  await page.evaluate(() => { const f = window.__fathom; f.freeze(true); f.renderer.frame = function () {}; });
  for (const depth of [1, 6, 12]) {
    for (const god of [true, false]) {
      const r = await page.evaluate((depth, god) => {
        const f = window.__fathom, g = f.game;
        let seed = 12345 + depth * 7 + (god ? 1 : 0);
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        f.start('soak-' + depth + (god ? 'g' : 'm'), depth);
        g.god = god;
        let mx = 0, my = 0, ping = false;
        g.bot = () => {
          if (rnd() < 0.04) { mx = Math.round(rnd() * 2 - 1); my = Math.round(rnd() * 2 - 1); }
          if (rnd() < 0.03) ping = !ping;
          return { mx, my, ping, dash: rnd() < 0.01, buoy: rnd() < 0.004 };
        };
        const issues = [];
        let max = { particles: 0, pings: 0, enemies: 0 }, states = {};
        try {
          for (let i = 0; i < 5000; i++) {
            if (g.state === 'gameover' || g.state === 'victory') { f.start('soak-r' + i, depth); g.god = god; }
            if (g.state === 'upgrade') g.chooseUpgrade(g.upgradeChoices[0] ? g.upgradeChoices[0].id : 'lens');
            if (rnd() < 0.002) { if (g.state === 'play') g.pause(); else if (g.state === 'paused') g.resume(); }
            if (rnd() < 0.0005 && g.state === 'play') g.completeLevel();
            g.update(1 / 60);
            states[g.state] = (states[g.state] || 0) + 1;
            const p = g.player;
            if (i % 50 === 0) {
              if (!Number.isFinite(p.x + p.y + p.vx + p.vy + p.energy)) issues.push('non-finite player at ' + i);
              if (p.energy < -0.001 || p.energy > g.stats.maxEnergy + 0.001) issues.push('energy out of range ' + p.energy);
              if (p.hull > p.maxHull || p.hull < 0) issues.push('hull out of range ' + p.hull);
              for (const e of g.enemies) if (!Number.isFinite(e.x + e.y)) { issues.push('enemy NaN ' + e.type); break; }
              for (const e of g.enemies) if (e.x < -50 || e.y < -50 || e.x > g.lv.width + 50 || e.y > g.lv.height + 50) { issues.push('enemy out of level ' + e.type); break; }
              if (g.state === 'play' && g.lv && (p.x < 0 || p.y < 0 || p.x > g.lv.width || p.y > g.lv.height)) issues.push('player out of level');
            }
            max.particles = Math.max(max.particles, g.particles.length); max.pings = Math.max(max.pings, g.pings.length); max.enemies = Math.max(max.enemies, g.enemies.length);
          }
        } catch (e) { issues.push('EXCEPTION ' + (e.stack || e.message).split('\n').slice(0, 4).join(' | ')); }
        return { depth, god, issues: [...new Set(issues)].slice(0, 5), max, states, finalState: g.state, uiMode: f.ui.mode };
      }, depth, god);
      check(`depth ${depth} ${god ? 'god' : 'mortal'}: no exceptions / NaN / out-of-range (${JSON.stringify(r.states)})`, r.issues.length === 0 && r.max.particles <= 800 && r.max.pings <= 17, r);
    }
  }
  check('no page errors during soak', real(h.errors).length === 0, real(h.errors).slice(0, 3));
  await h.close();
}

/* ---------------------------------------------------------------- 2. dt spikes */
console.log('== 2. dt spikes, NaN, negative dt');
{
  const h = await launch({});
  const { page } = h;
  await page.goto(h.url + '/index.html?noaudio=1', { waitUntil: 'load' });
  await sleep(500);
  const r = await page.evaluate(() => {
    const f = window.__fathom, g = f.game; f.freeze(true); f.renderer.frame = function () {};
    f.start('spike', 6);
    g.bot = () => ({ mx: 1, my: 0.3, ping: false });
    const out = { issues: [] };
    try {
      for (const dt of [5, 1, 0.5, NaN, -1, 0, Infinity, 0.25]) {
        g.update(dt);
        const p = g.player;
        if (!Number.isFinite(p.x + p.y + p.vx + p.vy + g.time + g.realTime)) out.issues.push('non-finite after dt=' + dt);
        if (window.__sdf) { /* placeholder */ }
      }
      // the player must still be inside open water (not tunnelled into rock)
      out.sdf = null;
    } catch (e) { out.issues.push('EXC ' + e.message); }
    return out;
  });
  check('absurd dt values never produce NaN or exceptions', r.issues.length === 0, r);
  const r2 = await page.evaluate(async () => {
    const f = window.__fathom, g = f.game; const W = await import('/js/world.js');
    f.start('spike2', 6); g.god = true;
    g.bot = () => ({ mx: 1, my: 0.2, ping: false, dash: true });
    let minSdf = 1e9;
    for (let i = 0; i < 40; i++) { g.update(10); minSdf = Math.min(minSdf, W.sdfAt(g.lv, g.player.x, g.player.y)); }
    return { minSdf: +minSdf.toFixed(1) };
  });
  check('after 10 s-sized dt spikes the player is never inside rock (sdf >= 0)', r2.minSdf >= 0, r2);
  await h.close();
}

/* ---------------------------------------------------------------- 3. hostile storage */
console.log('== 3. localStorage that throws / corrupt values');
{
  const mk = async (script, label, check2) => {
    const h = await launch({});
    const { page } = h;
    await page.evaluateOnNewDocument(script);
    await page.goto(h.url + '/index.html?noaudio=1', { waitUntil: 'load' });
    await sleep(600);
    const r = await page.evaluate(() => {
      const f = window.__fathom, g = f.game; f.freeze(true); f.renderer.frame = function () {};
      const out = { ok: true, err: null };
      try {
        f.start('store', 2);
        g.run.score = 999; g.completeLevel(); for (let i = 0; i < 130; i++) g.update(1 / 60);
        f.ui.setHue(120);
        g.chooseUpgrade(g.upgradeChoices[0].id);
        g.hint('dash', 'x'); g.finishRun(false);
        out.best = JSON.stringify(g.best); out.state = g.state;
        f.ui.refreshTitle(); out.bestLine = document.getElementById('bestLine').textContent;
        out.settings = JSON.stringify(f.settings);
      } catch (e) { out.ok = false; out.err = e.stack.split('\n').slice(0, 3).join(' | '); }
      return out;
    });
    check(label, r.ok && r.state === 'gameover' && check2(r), r.ok ? r : r.err);
    check(label + ': no page errors', real(h.errors).length === 0, real(h.errors).slice(0, 3));
    await h.close();
  };
  await mk(`Storage.prototype.getItem = function () { throw new Error('denied'); }; Storage.prototype.setItem = function () { throw new Error('quota'); };`,
    'getItem/setItem throw: boots, plays, saves in memory', (r) => JSON.parse(r.best).score >= 999);
  await mk(`Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });`,
    'window.localStorage getter throws (blocked site data)', (r) => JSON.parse(r.best).score >= 999);
  await mk(`localStorage.setItem('fathomless.best', 'null'); localStorage.setItem('fathomless.hints', 'null'); localStorage.setItem('fathomless.settings', '[1,2]');`,
    'corrupt "null"/array records fall back to defaults', (r) => JSON.parse(r.best).score >= 999 && /"master":0.8/.test(r.settings));
  await mk(`localStorage.setItem('fathomless.best', '{"depth":"x","score":-5,"daily":7}'); localStorage.setItem('fathomless.hints', '5'); localStorage.setItem('fathomless.settings', '"hi"');`,
    'wrongly-typed fields are sanitised', (r) => JSON.parse(r.best).score >= 999);
  await mk(`localStorage.setItem('fathomless.best', '{not json');`, 'unparseable JSON ignored', (r) => JSON.parse(r.best).score >= 999);
}

/* ---------------------------------------------------------------- 4. title regeneration */
console.log('== 4. title regeneration cost, memory over 100 level loads, leaks');
{
  const h = await launch({});
  const { page } = h;
  const cdp = await page.createCDPSession();
  await page.goto(h.url + '/index.html?noaudio=1', { waitUntil: 'load' });
  await sleep(800);
  await page.evaluate(() => { const f = window.__fathom; f.freeze(true); });
  const t = await page.evaluate(() => {
    const g = window.__fathom.game, ts = [];
    for (let i = 0; i < 30; i++) { const t0 = performance.now(); g.startTitle(); ts.push(performance.now() - t0); }
    ts.sort((a, b) => a - b);
    return { median: +ts[15].toFixed(0), p90: +ts[27].toFixed(0), max: +ts[29].toFixed(0), inner: +g.titleGenMs.toFixed(0) };
  });
  console.log('   startTitle():', JSON.stringify(t), 'ms');
  check('startTitle() median < 150 ms and p90 < 250 ms', t.median < 150 && t.p90 < 250, t);

  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage'); const m = await page.metrics(); return m.JSHeapUsedSize / 1048576; };
  // drive real level loads, with the renderer drawing a frame after each (memory map canvases etc.)
  await page.evaluate(() => { window.__loads = 0; });
  const load = (n) => page.evaluate((n) => {
    const f = window.__fathom, g = f.game;
    if (!g.run) f.start('leak', 1);
    for (let i = 0; i < n; i++) { g.loadLevel(1 + (window.__loads++ % 12)); f.step(3, true); g.pause(); g.resume(); }
    return window.__loads;
  }, n);
  await load(5); const h0 = await heap();
  await load(35); const h40 = await heap();
  await load(60); const h100 = await heap();
  console.log(`   heap MB: after 5 loads ${h0.toFixed(1)}, 40 loads ${h40.toFixed(1)}, 100 loads ${h100.toFixed(1)}`);
  check('heap does not grow with level loads (100 loads within +15 MB of 5 loads)', h100 - h0 < 15, { h0, h40, h100 });
  await h.close();
}
{
  const h = await launch({});
  const { page } = h;
  await page.evaluateOnNewDocument(() => {
    window.__adds = [];
    const o = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, opts) {
      let who = this === window ? 'window' : this === document ? 'document' : this.id ? '#' + this.id : (this.tagName || this.constructor.name);
      window.__adds.push(who + ':' + type);
      return o.call(this, type, fn, opts);
    };
  });
  await page.goto(h.url + '/index.html?noaudio=1', { waitUntil: 'load' });
  await sleep(800);
  const r = await page.evaluate(() => {
    const f = window.__fathom, g = f.game; f.freeze(true); f.renderer.frame = function () {};
    const persistent = (s) => /^(window|document|view|title|hud|toasts|BODY|HTML):/.test(s) || /^#(btn|set|end$|cards$|upgrade$)/.test(s);
    const before = window.__adds.filter(persistent).length;
    for (let i = 0; i < 25; i++) {
      f.start('leak' + i, 1); g.god = false;
      g.hint('dash', 'a'); g.completeLevel(); for (let k = 0; k < 130; k++) g.update(1 / 60);
      g.chooseUpgrade(g.upgradeChoices[0].id);
      g.player.invul = 0; g.hurt(9, g.player.x + 3, g.player.y); for (let k = 0; k < 200; k++) g.update(1 / 60);
      document.querySelector('#endBtns .btn:not(.primary)').click();
    }
    const after = window.__adds.filter(persistent).length;
    return {
      persistentListenerGrowth: after - before, cards: document.querySelectorAll('#cards .card').length, toasts: document.querySelectorAll('#toasts .toast').length,
      endBtns: document.querySelectorAll('#endBtns .btn').length, state: g.state, mode: f.ui.mode, newOnes: window.__adds.slice(-6),
    };
  });
  check('ui.bind / global listeners are added once (no growth over 25 full cycles)', r.persistentListenerGrowth === 0, r);
  check('upgrade cards + end buttons + toasts cleaned up', r.cards === 0 && r.toasts <= 1 && r.endBtns <= 2, r);
  check('ended on the title with a coherent ui mode', r.state === 'title' && r.mode === 'title', r);
  check('no page errors in the cycle test', real(h.errors).length === 0, real(h.errors).slice(0, 3));
  await h.close();
}

/* ---------------------------------------------------------------- 5. edge cases of the state machine */
console.log('== 5. state machine edge cases');
{
  const h = await launch({});
  const { page } = h;
  await page.goto(h.url + '/index.html?noaudio=1', { waitUntil: 'load' });
  await sleep(500);
  const r = await page.evaluate(() => {
    const f = window.__fathom, g = f.game; f.freeze(true); f.renderer.frame = function () {};
    const out = {};
    f.start('edge', 3); g.god = false;
    g.completeLevel();
    out.pauseInLevelEnd = g.pause();
    g.die(); out.dieInLevelEnd = g.state;
    g.hurt(9, g.player.x + 3, g.player.y); out.hurtInLevelEnd = g.state + '/' + g.player.hull;
    for (let i = 0; i < 130; i++) g.update(1 / 60);
    out.upgradeShown = g.state;
    out.pauseInUpgrade = g.pause();
    out.resumeNotPaused = g.resume();
    g.chooseUpgrade('nonexistent'); out.badUpgradeKeepsState = g.state;
    g.chooseUpgrade(g.upgradeChoices[0].id); out.afterPick = g.state;
    g.player.invul = 0; g.hurt(9, g.player.x + 3, g.player.y);
    out.pauseInDying = g.pause();
    g.hurt(9, 0, 0); g.die(); out.doubleDie = g.state;
    for (let i = 0; i < 200; i++) g.update(1 / 60);
    out.gameover = g.state;
    g.continueEndless(); out.endlessFromGameover = g.state;
    g.chooseUpgrade('lens'); out.pickInGameover = g.state;
    g.finishRun(false); out.finishTwice = g.state;
    f.start('edge2', 12); g.completeLevel(); for (let i = 0; i < 130; i++) g.update(1 / 60);
    out.victory = g.state;
    g.continueEndless(); out.endless1 = g.state; g.continueEndless(); out.endless2 = g.state;
    return out;
  });
  check('pause refused in levelend/upgrade/dying; resume refused when not paused', r.pauseInLevelEnd === false && r.pauseInUpgrade === false && r.pauseInDying === false && r.resumeNotPaused === false, r);
  check('die()/hurt() during levelend are ignored (gate already closing)', r.dieInLevelEnd === 'levelend' && r.hurtInLevelEnd.startsWith('levelend/'), r);
  check('levelend -> upgrade happens; invalid upgrade id ignored; valid one advances', r.upgradeShown === 'upgrade' && r.badUpgradeKeepsState === 'upgrade' && r.afterPick === 'play', r);
  check('double die() / death spiral ends in gameover once', r.doubleDie === 'dying' && r.gameover === 'gameover', r);
  check('continueEndless / chooseUpgrade outside their states are no-ops', r.endlessFromGameover === 'gameover' && r.pickInGameover === 'gameover' && r.finishTwice === 'gameover', r);
  check('depth 12 gate -> victory; continueEndless once, second call is a no-op', r.victory === 'victory' && r.endless1 === 'upgrade' && r.endless2 === 'upgrade', r);
  await h.close();
}

/* ---------------------------------------------------------------- 6. gamepad */
console.log('== 6. fake gamepad: menus, swimming, ping, pause');
{
  const h = await launch({});
  const { page } = h;
  await page.evaluateOnNewDocument(() => {
    window.__pad = { connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    navigator.getGamepads = () => [window.__pad];
  });
  await page.goto(h.url + '/index.html?noaudio=1', { waitUntil: 'load' });
  await sleep(500);
  await page.evaluate(() => { window.__fathom.renderer.frame = function () {}; });
  const frames = (n = 4) => page.evaluate((n) => new Promise((r) => { let i = 0; (function f() { if (++i >= n) r(); else requestAnimationFrame(f); })(); }), n);
  const tap = async (i, hold = 220) => { await page.evaluate((i) => { window.__pad.buttons[i].pressed = true; }, i); await sleep(hold); await page.evaluate((i) => { window.__pad.buttons[i].pressed = false; }, i); await frames(4); };
  const st = () => page.evaluate(() => { const f = window.__fathom; const a = document.activeElement; return { state: f.game.state, active: a && a !== document.body ? a.id : 'body', x: f.game.player.x, pings: f.game.run ? f.game.run.pings : 0, charging: f.game.player.charging }; });
  await frames(6);
  await tap(13);   // d-pad down: first press focuses the first button
  let s = await st();
  check('d-pad moves menu focus on the title', s.active === 'btnDive', s);
  await tap(13); s = await st();
  check('d-pad down again -> Daily Dive', s.active === 'btnDaily', s);
  await tap(12); s = await st();
  check('d-pad up goes back', s.active === 'btnDive', s);
  await tap(0); await frames(6); s = await st();
  check('A on the focused Dive button starts the run', s.state === 'play', s);
  await page.evaluate(() => { window.__pad.axes[0] = 1; }); await sleep(900); await page.evaluate(() => { window.__pad.axes[0] = 0; }); await frames(3);
  const s2 = await st();
  check('left stick swims', Math.abs(s2.x - s.x) > 10, { from: s.x, to: s2.x });
  await sleep(500);
  const p0 = (await st()).pings;
  await page.evaluate(() => { window.__pad.buttons[0].pressed = true; }); await sleep(500);
  check('holding A charges a ping', (await st()).charging === true);
  await page.evaluate(() => { window.__pad.buttons[0].pressed = false; }); await frames(5);
  check('releasing A fires it', (await st()).pings === p0 + 1);
  await tap(9); s = await st();
  check('Start pauses', s.state === 'paused' && s.active === 'btnResume', s);
  await tap(13); s = await st();
  check('d-pad moves within the pause menu', s.active === 'btnPauseSettings', s);
  await tap(12); await tap(0); await frames(4); s = await st();
  check('A on Resume resumes', s.state === 'play', s);
  await sleep(300);
  s = await st();
  check('resuming with A did not fire a stray ping', s.pings === p0 + 1 && !s.charging, s);
  check('no errors with a gamepad attached', real(h.errors).length === 0, real(h.errors).slice(0, 3));
  await h.close();
}

console.log('== 7. no gamepad API at all');
{
  const h = await launch({});
  const { page } = h;
  await page.evaluateOnNewDocument(() => { navigator.getGamepads = () => { throw new Error('no gamepads here'); }; });
  await page.goto(h.url + '/index.html?noaudio=1', { waitUntil: 'load' });
  await sleep(1200);
  check('a throwing getGamepads() does not break the loop', (await page.evaluate(() => window.__fathom.game.state)) === 'title' && real(h.errors).length === 0, real(h.errors).slice(0, 2));
  await h.close();
}

console.log(`\n${total - fails}/${total} checks passed`);
process.exit(fails ? 1 : 0);
