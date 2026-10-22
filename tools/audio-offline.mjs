// Deterministic per-sound loudness table via OfflineAudioContext (no real-time jitter, no bed masking unless asked).
// Columns: peak (|x| max after the full master chain), lmax (max 100 ms RMS, dBFS), lamax (same, A-weighted),
// tail (s until < -55 dBFS, includes the 0.3 s lead-in), maxDelta (largest sample step: click detector), lr (L/R dB: pan check), nan (bad samples).
// usage: node tools/audio-offline.mjs [--vol=0.8] [--music=0.7] [--json] [--only=substr]
// exit 1 when a hard check fails (worst-case peak >= 0.9, NaN, exception, bed outside 0.01..0.25).
import { openPage, table } from './audio-lib.mjs';

const arg = (k, d) => { const m = process.argv.find((a) => a.startsWith('--' + k + '=')); return m ? m.split('=')[1] : d; };
const VOL = parseFloat(arg('vol', 0.8)), MUS = parseFloat(arg('music', 0.7)), JSON_OUT = process.argv.includes('--json');
const ONLY = arg('only', '');
const COMP = arg('comp', '') ? (([threshold, ratio, knee, attack, release]) => { const o = { threshold, ratio, knee, attack, release }; for (const k in o) if (o[k] === undefined || o[k] === '') delete o[k]; else o[k] = parseFloat(o[k]); return o; })(arg('comp', '').split(',')) : null;

// Runs in the page: builds window.__cases = [{ name, run() -> row }]
function defineCases(VOL, MUS, AudioEngine, COMP) {
  const opts = { volume: VOL, musicVol: MUS, comp: COMP };
  const echoList = [];
  for (let i = 0; i < 14; i++) echoList.push({ t: 0.05 + i * 0.09, gain: Math.max(0.15, 1 - i * 0.07), pan: Math.sin(i * 1.7) * 0.9 });
  const cases = (window.__cases = []);
  const one = (name, fn, sec, reps = 2) => cases.push({ name, run: async () => {
    let best = null, err = null;
    for (let r = 0; r < reps; r++) {
      try {
        const { a, off } = window.__mkOffline(AudioEngine, sec, opts);
        fn(a);
        const buf = await off.startRendering();
        const m = window.__analyze(buf);
        m.errs = a.errors || 0;
        if (!best || m.peak > best.peak) best = m;
      } catch (e) { err = String(e && e.message || e); }
    }
    return Object.assign({ name, err }, best || {});
  } });
  const loop = (name, fn, sec, step, setup, extra = {}) => cases.push({ name, run: async () => {
    try {
      const { a, buf } = await window.__runOffline(AudioEngine, sec, step, fn, Object.assign({ setup }, opts, extra));
      const m = window.__analyze(buf); m.errs = a.errors || 0; return Object.assign({ name }, m);
    } catch (e) { return { name, err: String(e && e.message || e) }; }
  } });
  loop('BED playing', (a) => a.tick(0.25, true), 10, 0.25, (a) => { a.musicT = 1e9; a.whaleT = 1e9; }, { bed: true });
  loop('BED menu', (a) => a.tick(0.25, false), 10, 0.25, (a) => { a.musicT = 1e9; a.whaleT = 1e9; }, { bed: true });
  loop('BED playing danger=1', (a) => { a.setDanger(1); a.tick(0.25, true); }, 10, 0.25, (a) => { a.musicT = 1e9; a.whaleT = 1e9; a.beatT = 1e9; }, { bed: true });
  loop('BED+music notes', (a) => a.tick(0.25, true), 30, 0.25, (a) => { a.whaleT = 1e9; }, { bed: true });
  loop('MUSIC=0 bed+notes+whale', (a) => { a.tick(0.25, true); }, 24, 0.25, (a) => { a.depth = 3; a.whaleT = 0.2; }, { bed: true, musicVol: 0 });
  loop('MUTED everything', (a, t) => { a.tick(0.25, true); if (t < 0.3) { a.ping(1); a.hit(); a.roar(0, 1); } }, 6, 0.25, (a) => { a.depth = 3; }, { bed: true, muted: true });
  one('ping p=0', (a) => a.ping(0), 2);
  one('ping p=0.5', (a) => a.ping(0.5), 2.5);
  one('ping p=1', (a) => a.ping(1), 3);
  one('ping decoy p=.35 g=.4', (a) => a.ping(0.35, { gain: 0.4 }), 2.5);
  one('echoes x14 (g 1..0.15)', (a) => a.echoes(echoList), 3);
  one('echoes x1 g=1', (a) => a.echoes([{ t: 0.05, gain: 1, pan: 0 }]), 1);
  one('echoes x1 g=.3 pan=1', (a) => a.echoes([{ t: 0.05, gain: 0.3, pan: 1 }]), 1);
  one('ping p=1 + echoes', (a) => { a.ping(1); a.echoes(echoList); }, 3.5);
  one('pickup pearl #1', (a) => a.pickup('pearl'), 2.5);
  one('pickup pearl #8', (a) => { a.pearlStreak = 7; a.pearlT = 2; a.pickup('pearl'); }, 2.5);
  one('pickup buoy', (a) => a.pickup('buoy'), 3);
  one('pickup patch', (a) => a.pickup('patch'), 3.5);
  one('hit', (a) => a.hit(), 2);
  one('dash', (a) => a.dash(), 1);
  one('buoyPlace', (a) => a.buoyPlace(), 1);
  one('buoyBeep g=1', (a) => a.buoyBeep(0, 1), 1.5);
  one('denied', (a) => a.denied(), 1);
  for (const k of ['click', 'alert', 'alert2', 'lunge', 'roar', 'thrum']) {
    one(k + ' pan=-1 g=1', (a) => a[k](-1, 1), k === 'roar' ? 4 : 2);
    one(k + ' pan=0 g=.3', (a) => a[k](0, 0.3), k === 'roar' ? 4 : 2);
  }
  one('levelComplete', (a) => a.levelComplete(), 5);
  one('gameOver', (a) => a.gameOver(), 6);
  one('victory', (a) => a.victory(), 8);
  one('newDepth', (a) => a.newDepth(), 4);
  for (const k of ['hover', 'back', 'upgrade', 'click']) one('ui ' + k, (a) => a.ui(k), 2);
  one('whale', (a) => a.whale(), 6);
  one('charge 0..1', (a) => { a.chargeStart(); for (let i = 0; i <= 20; i++) a.chargeUpdate(i / 20); }, 1);
  for (const dg of [0.1, 0.5, 1]) {
    loop('heartbeat danger=' + dg, (a) => { a.setDanger(dg); a.tick(0.1, true); }, 6, 0.1, (a) => { a.musicT = 1e9; a.whaleT = 1e9; a.beatT = 0; });
  }
  // stress: everything at once (several fanfares overlapping is unrealistic on purpose). nolim = bypass the safety limiter
  // so the table shows what the compressor alone delivers; "lim" rows show the shipped output (hard ceiling 0.89).
  for (const [v, m, nolim] of [[VOL, MUS, true], [VOL, MUS, false], [1, 1, true], [1, 1, false]]) {
    cases.push({ name: 'WORST CASE vol=' + v + ' music=' + m + (nolim ? ' nolimiter' : ' limiter'), run: async () => {
      const ev = [
        [0.04, (a) => { a.__dng = (1); a.beatT = 0; a.musicT = 0; a.ping(1); a.echoes(echoList); a.hit(); a.roar(0, 1); a.lunge(-0.5, 1); a.alert(0.5, 1); a.pickup('patch'); a.dash(); a.buoyBeep(0, 1); }],
        [0.7, (a) => { a.hit(); a.ping(1); a.echoes(echoList); a.thrum(0, 1); a.click(0.3, 1); a.alert2(-0.3, 1); }],
        [1.2, (a) => { a.levelComplete(); a.whale(); }],
        [2.0, (a) => { a.victory(); a.gameOver(); a.newDepth(); a.hit(); a.ping(1); a.echoes(echoList); }],
      ].map(([at, fn]) => ({ at, fn, done: false }));
      const { a, buf } = await window.__runOffline(AudioEngine, 8, 0.05, (a, t) => {
        if (a.__dng !== undefined) a.setDanger(a.__dng);
        a.tick(0.05, true);
        for (const e of ev) if (!e.done && t >= e.at) { e.done = true; e.fn(a); }
      }, { bed: true, volume: v, musicVol: m, nolim, comp: COMP, setup: (a) => { a.whaleT = 1e9; } });
      const mm = window.__analyze(buf); mm.errs = a.errors || 0; mm.voices = a.voices;
      return Object.assign({ name: 'WORST CASE vol=' + v + ' music=' + m + (nolim ? ' nolimiter' : ' limiter') }, mm);
    } });
  }
  // plausible busy gameplay: loud pings + echoes, hunters nearby, danger ramping, pickups, a hit: 30 s, deterministic schedule
  cases.push({ name: 'BUSY GAMEPLAY 30s nolimiter', run: async () => {
    const sched = [];
    for (let t = 1; t < 28; t += 2.3) sched.push([t, (a) => { a.ping(0.8); a.echoes(echoList); }]);
    for (let t = 2; t < 28; t += 3.1) sched.push([t, (a) => { a.pickup('pearl'); }]);
    for (let t = 3; t < 28; t += 1.7) sched.push([t, (a) => { a.click(-0.6, 0.7); }]);
    sched.push([6, (a) => { a.alert(0.4, 0.8); a.__dng = (0.5); }], [9, (a) => { a.hit(); a.__dng = (0.8); }], [12, (a) => { a.lunge(-0.3, 0.8); }],
      [14, (a) => { a.dash(); }], [16, (a) => { a.buoyPlace(); }], [20, (a) => { a.roar(0.2, 0.8); a.__dng = (1); }], [25, (a) => { a.levelComplete(); a.__dng = (0); }]);
    const ev = sched.map(([at, fn]) => ({ at, fn, done: false }));
    const { a, buf } = await window.__runOffline(AudioEngine, 32, 0.1, (a, t) => {
      if (a.__dng !== undefined) a.setDanger(a.__dng);
      a.tick(0.1, true);
      for (const e of ev) if (!e.done && t >= e.at) { e.done = true; e.fn(a); }
    }, { bed: true, volume: VOL, musicVol: MUS, nolim: true, comp: COMP, setup: (a) => { a.depth = 6; a.whaleT = 8; } });
    const mm = window.__analyze(buf); mm.errs = a.errors || 0; mm.voices = a.voices;
    return Object.assign({ name: 'BUSY GAMEPLAY 30s nolimiter' }, mm);
  } });
  return cases.map((c) => c.name);
}

const h = await openPage();
const names = await h.page.evaluate(async (src, VOL, MUS, COMP) => {
  const { AudioEngine } = await import('/js/audio.js');
  return (0, eval)('(' + src + ')')(VOL, MUS, AudioEngine, COMP);
}, defineCases.toString(), VOL, MUS, COMP);

const res = [];
for (let i = 0; i < names.length; i++) {
  if (ONLY && !names[i].includes(ONLY)) continue;
  const r = await h.page.evaluate((i) => window.__cases[i].run(), i);
  res.push(r);
  if (!JSON_OUT) process.stderr.write('.');
}
if (!JSON_OUT) process.stderr.write('\n');

if (JSON_OUT) console.log(JSON.stringify(res));
else {
  console.log(`offline render, master=${VOL} music=${MUS}`);
  table(res, ['name', 'peak', 'pkAt', 'lmax', 'lamax', 'tail', 'maxDelta', 'lr', 'nan', 'errs', 'err']);
}
const errs = h.errors.filter((e) => !/Failed to load resource/.test(e));
const bad = [];
for (const r of res) {
  if (r.err) bad.push(r.name + ' threw: ' + r.err);
  if (r.nan) bad.push(r.name + ' produced NaN samples');
  if (r.errs) bad.push(r.name + ' swallowed ' + r.errs + ' exception(s)');
  if (r.name.startsWith('WORST') && r.name.includes(' limiter') && r.peak >= 0.9) bad.push(r.name + ' peak ' + r.peak + ' >= 0.9');
  if (r.name.startsWith('WORST') && r.name.includes('vol=0.8') && r.name.includes('nolimiter') && r.peak >= 0.95) bad.push(r.name + ' peak ' + r.peak + ' >= 0.95 (default-volume stress should not clip even with the safety limiter bypassed)');
  if (r.name.startsWith('BUSY') && r.peak >= 0.95) bad.push(r.name + ' peak ' + r.peak + ' >= 0.95 (typical busy play is 0.65-0.8 without the limiter; the noise bursts make single runs vary)');
  if ((r.name.startsWith('MUSIC=0') || r.name.startsWith('MUTED')) && r.peak > 0.003) bad.push(r.name + ' leaks, peak ' + r.peak);
}
const bed = res.find((r) => r.name === 'BED playing');
if (bed && (bed.peak < 0.01 || bed.peak > 0.25)) bad.push('bed peak ' + bed.peak + ' outside 0.01..0.25');
if (errs.length) bad.push('page errors: ' + errs.join(' | '));
console.log(bad.length ? 'FAIL: ' + bad.join('; ') : 'PASS');
await h.close();
process.exit(bad.length ? 1 : 0);
