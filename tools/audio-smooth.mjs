// Click / zipper-noise check (OfflineAudioContext): over a steady bed, mute/unmute, biome changes, volume changes, danger
// sweeps and a charge cycle must not produce sample-to-sample jumps above the bed's own natural slope. Also checks that
// the master volume is applied linearly and that init() cost (reverb impulse + noise buffer) stays small.
// usage: node tools/audio-smooth.mjs
import { openPage } from './audio-lib.mjs';

const h = await openPage();
const bad = [];
const check = (c, msg) => { if (!c) { bad.push(msg); console.log('  FAIL', msg); } };

const r = await h.page.evaluate(async () => {
  const { AudioEngine } = await import('/js/audio.js');
  const SR = 48000;
  const events = [
    [2.0, 'mute on', (a) => a.setMuted(true)],
    [3.5, 'mute off', (a) => a.setMuted(false)],
    [5.0, 'biome 0->2', (a) => a.setBiome(2, 7)],
    [8.0, 'biome 2->3', (a) => a.setBiome(3, 11)],
    [10.0, 'volume .8->.4', (a) => a.setVolumes(0.4)],
    [12.0, 'music .7->.1', (a) => a.setVolumes(undefined, 0.1)],
    [14.0, 'volumes back', (a) => a.setVolumes(0.8, 0.7)],
    [16.0, 'danger 0->1', (a) => { a.__dng = 1; }],
    [18.0, 'danger 1->0', (a) => { a.__dng = 0; }],
    [20.0, 'charge start', (a) => { a.chargeStart(); a.__cs = 20; }],
    [21.5, 'charge stop', (a) => { a.chargeStop(); a.__cs = 0; }],
    [23.0, 'ping (reference: a real sound)', (a) => a.ping(0.6)],
  ];
  const ev = events.map(([at, name, fn]) => ({ at, name, fn, done: false }));
  const { a, buf } = await window.__runOffline(AudioEngine, 26, 0.05, (a, t) => {
    if (a.__dng !== undefined) a.setDanger(a.__dng);
    a.tick(0.05, true);
    if (a.__cs) a.chargeUpdate(Math.min(1, (t - a.__cs) / 1.2));
    for (const e of ev) if (!e.done && t >= e.at) { e.done = true; e.fn(a); }
  }, { bed: true, volume: 0.8, musicVol: 0.7, setup: (a) => { a.musicT = 1e9; a.whaleT = 1e9; } });
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const win = (t0, t1) => {
    let md = 0, ss = 0, pk = 0, n = 0;
    for (let i = Math.max(1, Math.floor(t0 * SR)); i < Math.min(L.length, Math.floor(t1 * SR)); i++) {
      md = Math.max(md, Math.abs(L[i] - L[i - 1]), Math.abs(R[i] - R[i - 1]));
      ss += L[i] * L[i] + R[i] * R[i]; n += 2;
      pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
    }
    return { md, rms: Math.sqrt(ss / Math.max(1, n)), pk };
  };
  const control = win(0.8, 1.9);
  const out = { control, events: [], errors: a.errors };
  for (const [at, name] of events) out.events.push({ name, ...win(at - 0.02, at + 0.6) });
  // master volume is linear: a steady tone, volume .8 -> .4 mid-render, must halve the level (the compressor sits before the master)
  {
    let changed = false;
    const r2 = await window.__runOffline(AudioEngine, 10, 0.25, (a2, t) => {
      if (t === 0) { const o = a2.ctx.createOscillator(), g = a2.ctx.createGain(); o.frequency.value = 440; g.gain.value = 0.1; o.connect(g); g.connect(a2.sfx); o.start(0.3); }
      if (!changed && t >= 5) { changed = true; a2.setVolumes(0.4); }
    }, { bed: false, volume: 0.8, musicVol: 0.7 });
    const d = r2.buf.getChannelData(0), rms = (t0, t1) => { let ss = 0, n = 0; for (let i = Math.floor(t0 * SR); i < Math.floor(t1 * SR); i++) { ss += d[i] * d[i]; n++; } return Math.sqrt(ss / n); };
    out.volRatio = rms(7, 9.5) / rms(2.5, 4.8);
  }
  out.muteRms = win(2.4, 3.4).rms;
  // init cost: time the engine's own work, excluding the browser's AudioContext constructor (device startup)
  const e2 = new AudioEngine(); e2.ctx = new AudioContext();
  let t1 = performance.now(); e2.makeImpulse(3.6, 2.2); out.impulse36 = performance.now() - t1;
  t1 = performance.now(); e2.makeImpulse(2.4, 2.2); out.impulse24 = performance.now() - t1;
  const Real = window.AudioContext; let ctorMs = 0;
  window.AudioContext = function (o) { const t = performance.now(); const c = new Real(o); ctorMs = performance.now() - t; return c; };
  out.initWork = 1e9; // best of 3 (a loaded CI box adds noise)
  for (let k = 0; k < 3; k++) {
    const e3 = new AudioEngine(); t1 = performance.now(); e3.init(); const total = performance.now() - t1;
    if (total - ctorMs < out.initWork) { out.initWork = total - ctorMs; out.initTotal = total; out.ctxMs = ctorMs; }
    e3.ctx.close();
  }
  window.AudioContext = Real;
  // charge stop: compare the slope just before and just after the stop (a click would show as a jump only after)
  out.chargePre = win(21.0, 21.48).md; out.chargePost = win(21.52, 22.1).md;
  return out;
});
console.log('control window (steady bed): maxDelta', r.control.md.toFixed(4), 'rms', r.control.rms.toFixed(4), 'peak', r.control.pk.toFixed(3));
console.log('event                           maxDelta   peak    verdict');
const lim = Math.max(0.01, r.control.md * 4);
for (const e of r.events) {
  const ok = e.md <= lim || e.name.startsWith('ping') || e.name === 'charge stop';
  console.log(e.name.padEnd(32), e.md.toFixed(4).padEnd(10), e.pk.toFixed(3).padEnd(7), ok ? 'smooth' : 'JUMP');
  if (!ok) check(false, `${e.name}: maxDelta ${e.md.toFixed(4)} > ${lim.toFixed(4)}`);
}
console.log(`charge stop: slope before ${r.chargePre.toFixed(4)} after ${r.chargePost.toFixed(4)}`);
check(r.chargePost <= r.chargePre * 1.25 + 0.002, 'charge stop clicks: ' + r.chargePost.toFixed(4) + ' after vs ' + r.chargePre.toFixed(4) + ' before');
console.log(`volume .8 -> .4 rms ratio ${r.volRatio.toFixed(3)} (expect 0.5); muted rms ${r.muteRms.toExponential(1)}`);
check(r.volRatio > 0.47 && r.volRatio < 0.53, 'master volume not linear: ratio ' + r.volRatio.toFixed(3));
check(r.muteRms < 1e-4, 'mute not silent: ' + r.muteRms);
console.log(`impulse 3.6 s: ${r.impulse36.toFixed(1)} ms, 2.4 s: ${r.impulse24.toFixed(1)} ms; init() total ${r.initTotal.toFixed(0)} ms of which AudioContext ctor ${r.ctxMs.toFixed(0)} ms => engine work ${r.initWork.toFixed(0)} ms`);
check(r.impulse36 < 150, 'reverb impulse generation too slow: ' + r.impulse36.toFixed(0) + ' ms');
check(r.initWork < 150, 'init() work (excluding context creation) too slow: ' + r.initWork.toFixed(0) + ' ms');
check(r.errors === 0, 'engine swallowed exceptions: ' + r.errors);
const errs = h.errors.filter((x) => !/Failed to load resource/.test(x));
check(errs.length === 0, 'page errors: ' + errs.join(' | '));
console.log(bad.length ? 'FAIL: ' + bad.join('; ') : 'PASS');
await h.close();
process.exit(bad.length ? 1 : 0);
