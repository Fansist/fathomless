// API robustness: every public AudioEngine method with sane + hostile arguments, with audio unavailable (ctx null),
// with a real AudioContext, double/odd lifecycles, an autoplay-blocked context that must unlock on the first gesture,
// visibility suspend/resume. Fails on any exception, console.error/warn, swallowed exception (engine.errors) or leaked voice.
// usage: node tools/audio-api.mjs
import { openPage, sleep } from './audio-lib.mjs';

const bad = [];
const check = (c, msg) => { if (!c) { bad.push(msg); console.log('  FAIL', msg); } };

/* ---------- part 1: audio unavailable ---------- */
{
  const h = await openPage();
  const r = await h.page.evaluate(async () => {
    const { AudioEngine } = await import('/js/audio.js');
    const out = { thrown: [] };
    const all = (a, tag) => {
      const call = (name, ...args) => { try { a[name](...args); } catch (e) { out.thrown.push(tag + ' ' + name + ': ' + e.message); } };
      call('resume'); call('suspend'); call('setVolumes', 0.5, 0.5); call('setMuted', true); call('setMuted', false);
      call('tick', 0.016, true); call('tick', 0.016, false); call('setBiome', 2, 5); call('setDanger', 0.7);
      call('chargeStart'); call('chargeUpdate', 0.5); call('chargeStop'); call('chargeStop');
      call('ping', 0); call('ping', 1, { gain: 0.4, pan: -1 }); call('echoes', [{ t: 0.1, gain: 1, pan: 0 }]); call('echoes', null);
      for (const k of ['pearl', 'buoy', 'patch', 'zzz']) call('pickup', k);
      for (const k of ['hit', 'dash', 'buoyPlace', 'denied', 'levelComplete', 'gameOver', 'victory', 'newDepth', 'whale', 'startDrone']) call(k);
      call('buoyBeep', 0.3, 0.5);
      for (const k of ['click', 'alert', 'alert2', 'lunge', 'roar', 'thrum']) { call(k, -1, 1); call(k, 1, 0); call(k); }
      for (const k of ['hover', 'back', 'upgrade', 'click', 'nope']) call('ui', k);
      out[tag + ' peak'] = a.peak(); out[tag + ' voices'] = a.voices; out[tag + ' ok'] = a.ok;
    };
    all(new AudioEngine(), 'never-initialised');
    // no AudioContext at all
    const Real = window.AudioContext, RealW = window.webkitAudioContext;
    window.AudioContext = undefined; window.webkitAudioContext = undefined;
    const b = new AudioEngine(); out.initNoAC = b.init(); all(b, 'no-AudioContext');
    // constructor throws
    window.AudioContext = function () { throw new Error('boom'); };
    const c = new AudioEngine(); out.initThrows = c.init(); all(c, 'ctor-throws');
    window.AudioContext = Real; window.webkitAudioContext = RealW;
    return out;
  });
  console.log('[unavailable]', JSON.stringify(r));
  check(r.thrown.length === 0, 'unavailable: methods threw: ' + r.thrown.slice(0, 3).join(' | '));
  for (const k of ['never-initialised', 'no-AudioContext', 'ctor-throws']) {
    check(r[k + ' peak'] === 0 && r[k + ' voices'] === 0 && r[k + ' ok'] === false, k + ': not a clean no-op');
  }
  check(r.initNoAC === false && r.initThrows === false, 'init() should report false when audio is unavailable');
  const logs = h.logs.filter((l) => /^(error|warn)/.test(l));
  check(h.errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, 'unavailable: page errors ' + h.errors.join('|'));
  console.log('  logs:', logs);
  await h.close();
}

/* ---------- part 2: real context, full surface ---------- */
{
  const h = await openPage();
  const r = await h.page.evaluate(async () => {
    const { AudioEngine } = await import('/js/audio.js');
    const out = { thrown: [], notes: [] };
    const a = new AudioEngine();
    out.init = a.init(); out.init2 = a.init(); out.state = a.ctx.state;
    const nOsc0 = window.__probe.created.OscillatorNode;
    a.init(); a.startDrone(); a.startDrone();
    out.droneOncePerInit = window.__probe.created.OscillatorNode === nOsc0; // no extra oscillators from repeated init/startDrone
    const call = (name, ...args) => { try { return a[name](...args); } catch (e) { out.thrown.push(name + '(' + args.map((x) => JSON.stringify(x)).join(',') + '): ' + e.message); } };
    const echo = [];
    for (let i = 0; i < 14; i++) echo.push({ t: 0.05 + i * 0.09, gain: Math.max(0.1, 1 - i * 0.07), pan: Math.sin(i * 1.7) * 0.9 });
    for (const p of [0, 0.5, 1]) { call('ping', p); call('ping', p, { gain: 0.4 }); call('ping', p, { pan: -1 }); call('ping', p, { pan: 1, gain: 0 }); }
    call('echoes', echo); call('echoes', []); call('echoes', undefined); call('echoes', [null, {}, { t: NaN, gain: NaN, pan: NaN }, { t: -1, gain: 2, pan: 9 }]);
    for (const k of ['pearl', 'pearl', 'pearl', 'buoy', 'patch', 'bogus', undefined]) call('pickup', k);
    for (let i = 0; i < 14; i++) call('pickup', 'pearl'); // streak runs off the scale
    for (const k of ['hit', 'dash', 'buoyPlace', 'denied', 'levelComplete', 'gameOver', 'victory', 'newDepth', 'whale']) call(k);
    call('buoyBeep'); call('buoyBeep', -1, 0); call('buoyBeep', 1, 1); call('buoyBeep', NaN, NaN);
    for (const k of ['click', 'alert', 'alert2', 'lunge', 'roar', 'thrum']) {
      for (const pan of [-1, -0.5, 0, 0.5, 1]) for (const g of [0, 0.01, 0.5, 1]) call(k, pan, g);
      call(k); call(k, undefined, undefined); call(k, NaN, NaN); call(k, 5, 5); call(k, -5, -1);
    }
    for (const k of ['hover', 'back', 'upgrade', 'click', 'whatever', undefined, null]) call('ui', k);
    // charge lifecycle
    call('chargeStop'); call('chargeUpdate', 0.5); call('chargeStart'); call('chargeStart'); call('chargeUpdate', 0.2); call('chargeUpdate', 2); call('chargeUpdate', NaN);
    call('chargeStop'); call('chargeStop'); call('chargeStart'); call('chargeStop');
    // biomes / danger / volumes
    for (const b of [0, 1, 2, 3, 0, 3, 1, 2]) call('setBiome', b, 1 + b * 3);
    call('setBiome', 7, 99); call('setBiome', -1, 0); call('setBiome', NaN, NaN); call('setBiome', undefined, undefined); call('setBiome', 1.7, 4);
    for (let d = 0; d <= 1.001; d += 0.1) { call('setDanger', d); call('tick', 0.016, true); }
    call('setDanger', -3); call('setDanger', 9); call('setDanger', NaN); call('setDanger');
    call('setVolumes', 0, 0); call('setVolumes', 1, 1); call('setVolumes', 0.5); call('setVolumes', undefined, 0.3); call('setVolumes', 9, -9); call('setVolumes', NaN, NaN); call('setVolumes', '0.5', '0.5');
    call('setMuted', true); call('setMuted', true); call('setMuted', false); call('setMuted'); call('setMuted', 1);
    call('setVolumes', 0.8, 0.7); call('setMuted', false);
    for (const dt of [0.016, 0, -1, 0.5, 10, NaN, undefined]) { call('tick', dt, true); call('tick', dt, false); }
    for (let i = 0; i < 600; i++) { call('tick', 1 / 60, i % 7 !== 0); }
    out.voicesMid = a.voices;
    out.peakType = typeof a.peak();
    // suspend / resume
    call('suspend'); call('suspend'); for (let i = 0; i < 40 && a.ctx.state !== 'suspended'; i++) await window.__wait(50); out.stateSuspended = a.ctx.state;
    const v0 = a.voices;
    call('ping', 1); call('hit'); call('echoes', echo); call('tick', 0.016, true);
    out.noVoicesWhileSuspended = a.voices === v0; // nothing is queued into a suspended context
    call('resume'); call('resume'); for (let i = 0; i < 40 && a.ctx.state !== 'running'; i++) await window.__wait(50); out.stateResumed = a.ctx.state;
    call('ping', 1); await window.__wait(50); out.pingAfterResume = a.voices > 0;
    // charge watchdog: a charge nobody releases or updates is stopped by tick() instead of whining forever
    call('chargeStart'); await window.__wait(2400); call('tick', 0.016, true); out.watchdog = a.chargeVoice === null;
    // back-to-back suspend()/resume() (tab hidden and shown within a frame) must end running; resume()+suspend() must end suspended
    call('suspend'); call('resume'); for (let i = 0; i < 40; i++) await window.__wait(50); out.stateSuspendResume = a.ctx.state;
    call('resume'); call('suspend'); for (let i = 0; i < 40; i++) await window.__wait(50); out.stateResumeSuspend = a.ctx.state;
    call('resume'); for (let i = 0; i < 40 && a.ctx.state !== 'running'; i++) await window.__wait(50);
    await window.__wait(6000); // let every voice finish (longest are the ~5 s fanfares)
    for (let i = 0; i < 20; i++) { call('tick', 1 / 60, true); }
    await window.__wait(5500);
    out.voicesEnd = a.voices; out.errors = a.errors; out.lastError = a.lastError && String(a.lastError.message || a.lastError);
    out.live = window.__probe.live(); out.maxVoicesSeen = a.voices;
    out.peak = a.peak();
    return out;
  });
  console.log('[real context]', JSON.stringify({ ...r, live: undefined }));
  console.log('  live nodes at end:', JSON.stringify(r.live));
  check(r.init === true && r.init2 === true, 'init() should return true twice');
  check(r.thrown.length === 0, 'real: methods threw: ' + r.thrown.slice(0, 5).join(' | '));
  check(r.errors === 0, 'real: engine swallowed ' + r.errors + ' exceptions: ' + r.lastError);
  check(r.droneOncePerInit, 'real: repeated init()/startDrone() created extra oscillators');
  check(r.stateSuspended === 'suspended' && r.noVoicesWhileSuspended, 'real: suspend() should stop scheduling (state=' + r.stateSuspended + ')');
  check(r.stateResumed === 'running' && r.pingAfterResume, 'real: resume() should restore sound (state=' + r.stateResumed + ')');
  check(r.watchdog === true, 'real: an abandoned charge voice was never stopped');
  check(r.stateSuspendResume === 'running', 'real: suspend() immediately followed by resume() ended ' + r.stateSuspendResume);
  check(r.stateResumeSuspend === 'suspended', 'real: resume() immediately followed by suspend() ended ' + r.stateResumeSuspend);
  check(r.voicesEnd === 0, 'real: voices did not return to 0: ' + r.voicesEnd);
  const logs = h.logs.filter((l) => /^(error|warn)/.test(l) && !/ScriptProcessor/.test(l));
  check(h.errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, 'real: page errors ' + h.errors.join('|'));
  check(logs.length === 0, 'real: console warnings ' + logs.join('|'));
  await h.close();
}

/* ---------- part 3: autoplay-blocked context unlocks on the first gesture ---------- */
{
  // Chrome's flag cannot be overridden from here, so emulate the blocked state: the context reports 'suspended' and
  // resume() stays pending (as in a real browser) until a user gesture is flagged by the test.
  const h = await openPage();
  await h.page.evaluate(() => {
    const Real = window.AudioContext;
    window.__gesture = false;
    window.AudioContext = class extends Real {
      get state() { return window.__gesture && this.__resumed ? 'running' : 'suspended'; }
      resume() { if (window.__gesture) { this.__resumed = true; return Promise.resolve(); } return new Promise(() => {}); }
    };
    window.addEventListener('pointerdown', () => { window.__gesture = true; }, { capture: true, passive: true });
  });
  const r1 = await h.page.evaluate(async () => {
    const { AudioEngine } = await import('/js/audio.js');
    const a = (window.__a = new AudioEngine());
    const out = {};
    out.init = a.init();
    out.state0 = a.ctx.state;
    a.ping(1); a.hit(); a.echoes([{ t: 0.1, gain: 1, pan: 0 }]); a.tick(0.016, true); a.chargeStart(); a.chargeStop();
    out.voicesWhileBlocked = a.voices;
    out.ok = a.ok;
    return out;
  });
  console.log('[autoplay blocked]', JSON.stringify(r1));
  check(r1.init === true && r1.state0 === 'suspended', 'blocked: expected a suspended context after init()');
  check(r1.voicesWhileBlocked === 0, 'blocked: sounds were queued into a suspended context (' + r1.voicesWhileBlocked + ')');
  await h.page.mouse.click(100, 100);
  await sleep(300);
  const r2 = await h.page.evaluate(async () => {
    const a = window.__a, out = { state: a.ctx.state };
    a.ping(1);
    out.voicesAfter = a.voices;
    return out;
  });
  console.log('  after click:', JSON.stringify(r2));
  check(r2.state === 'running', 'blocked: first user gesture should resume the context (state ' + r2.state + ')');
  check(r2.voicesAfter > 0, 'blocked: ping after unlock should make sound');
  await h.close();
}

console.log(bad.length ? 'FAIL: ' + bad.join('; ') : 'PASS');
process.exit(bad.length ? 1 : 0);
