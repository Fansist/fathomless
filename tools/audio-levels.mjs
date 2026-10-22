// Real-time per-sound loudness table at default volumes (master 0.8, music 0.7): audio.peak() sampled every ~20 ms plus an exact
// ScriptProcessor tap on the output. The ambient bed is cut from the mix for the per-sound rows (--bed keeps it) so every
// row is the sound alone; the worst-case overlap keeps it. For the deterministic, faster-than-real-time version with
// A-weighted loudness see audio-offline.mjs.
// usage: node tools/audio-levels.mjs [--bed]     exit 1 if worst-case >= 0.9, bed outside 0.01..0.25, exceptions, or a sound is silent
import { openPage, table } from './audio-lib.mjs';

const KEEP_BED = process.argv.includes('--bed');
const h = await openPage();
const res = await h.page.evaluate(async (KEEP_BED) => {
  const { AudioEngine } = await import('/js/audio.js');
  const wait = window.__wait;
  const a = new AudioEngine();
  a.volume = 0.8; a.musicVol = 0.7;
  a.init();
  await wait(400);
  window.__installCapture(a, 'out', 'out');
  const cap = window.__caps.out;
  // bed first (real fade-in via tick), then optionally cut it
  a.tick(0.016, true);
  const bedIv = setInterval(() => a.tick(0.016, true), 16);
  a.musicT = 1e9; a.whaleT = 1e9;
  await wait(5000);
  const bedStart = a.ctx.currentTime;
  let bedA = 0;
  const bi = setInterval(() => { bedA = Math.max(bedA, a.peak()); }, 20);
  await wait(3000);
  clearInterval(bi);
  const bedRow = { name: 'BED (drone only)', peak: +cap.query(bedStart, bedStart + 3).peak.toFixed(3), apeak: +bedA.toFixed(3), rms: +cap.query(bedStart, bedStart + 3).rms.toFixed(3), voices: a.voices };
  clearInterval(bedIv);
  if (!KEEP_BED) a.drone.out.disconnect();
  await wait(4000); // let the bed's reverb tail die

  const echoList = [];
  for (let i = 0; i < 14; i++) echoList.push({ t: 0.05 + i * 0.09, gain: Math.max(0.15, 1 - i * 0.07), pan: Math.sin(i * 1.7) * 0.9 });
  const out = [bedRow];
  async function measure(name, fn, dur) {
    const c0 = a.ctx.currentTime;
    let ap = 0;
    const iv = setInterval(() => { ap = Math.max(ap, a.peak()); }, 20);
    let err = null;
    try { fn(); } catch (e) { err = String(e && e.message || e); }
    await wait(dur * 1000);
    clearInterval(iv);
    await wait(150);
    const r = cap.query(c0 - 0.03, c0 + dur + 0.1);
    out.push({ name, peak: +r.peak.toFixed(3), apeak: +ap.toFixed(3), rms: +r.rms.toFixed(3), voices: a.voices, err });
    await wait(500);
  }
  await measure('ping p=0', () => a.ping(0), 1.2);
  await measure('ping p=0.5', () => a.ping(0.5), 1.6);
  await measure('ping p=1', () => a.ping(1), 2);
  await measure('ping decoy p=.35 g=.4', () => a.ping(0.35, { gain: 0.4 }), 1.4);
  await measure('echoes x14', () => a.echoes(echoList), 2.2);
  await measure('ping p=1 + echoes', () => { a.ping(1); a.echoes(echoList); }, 2.6);
  await measure('pickup pearl #1', () => a.pickup('pearl'), 1.4);
  await measure('pickup buoy', () => a.pickup('buoy'), 1.8);
  await measure('pickup patch', () => a.pickup('patch'), 2.2);
  await measure('hit', () => a.hit(), 1.4);
  await measure('dash', () => a.dash(), 0.8);
  await measure('buoyPlace', () => a.buoyPlace(), 0.8);
  await measure('buoyBeep', () => a.buoyBeep(0, 1), 1.2);
  await measure('denied', () => a.denied(), 0.5);
  for (const k of ['click', 'alert', 'alert2', 'lunge', 'roar', 'thrum']) await measure(k + ' pan=-1 g=1', () => a[k](-1, 1), k === 'roar' ? 3.2 : 1.6);
  await measure('levelComplete', () => a.levelComplete(), 3.6);
  await measure('gameOver', () => a.gameOver(), 4.2);
  await measure('victory', () => a.victory(), 5);
  await measure('newDepth', () => a.newDepth(), 3);
  for (const k of ['hover', 'back', 'upgrade', 'click']) await measure('ui ' + k, () => a.ui(k), 1.5);
  await measure('whale', () => a.whale(), 5);
  await measure('charge 0..1 (sustained)', () => {
    a.chargeStart(); let l = 0;
    const iv = setInterval(() => { l = Math.min(1, l + 0.04); a.chargeUpdate(l); }, 30);
    setTimeout(() => { clearInterval(iv); a.chargeStop(); a.chargeStop(); }, 1100);
  }, 1.6);
  for (const dg of [0.1, 0.5, 1]) {
    await measure('heartbeat danger=' + dg, () => {
      a.setDanger(dg); a.musicT = 1e9; a.whaleT = 1e9; a.beatT = 0;
      const iv = setInterval(() => { a.setDanger(dg); a.tick(0.016, true); }, 16);
      setTimeout(() => clearInterval(iv), 2400);
    }, 2.6);
  }
  a.setDanger(0);
  await wait(1200);

  // worst case overlap, bed on
  if (!KEEP_BED) { a.drone.out.connect(a.musicBus); a.drone.out.connect(a.mVerb); }
  const worst = [];
  for (let rep = 0; rep < 2; rep++) {
    const c0 = a.ctx.currentTime;
    let ap = 0;
    const iv = setInterval(() => { ap = Math.max(ap, a.peak()); }, 20);
    a.setDanger(1); a.beatT = 0; a.musicT = 0; a.whaleT = 1e9;
    const tk = setInterval(() => { a.setDanger(1); a.tick(0.016, true); }, 16);
    a.ping(1); a.echoes(echoList); a.hit(); a.roar(0, 1); a.lunge(-0.5, 1); a.alert(0.5, 1);
    a.pickup('patch'); a.dash(); a.buoyBeep(0, 1);
    setTimeout(() => { a.hit(); a.ping(1); a.echoes(echoList); a.thrum(0, 1); }, 700);
    setTimeout(() => { a.levelComplete(); a.whale(); }, 1200);
    await wait(3800);
    clearInterval(tk); clearInterval(iv);
    await wait(300);
    const r = cap.query(c0, c0 + 4.0);
    worst.push({ peak: +r.peak.toFixed(3), apeak: +ap.toFixed(3), rms: +r.rms.toFixed(3), voicesNow: a.voices });
    a.setDanger(0);
    await wait(4500);
  }
  return { out, worst, sr: a.ctx.sampleRate, errors: a.errors, lastError: a.lastError && String(a.lastError.message) };
}, KEEP_BED);

table(res.out, ['name', 'peak', 'apeak', 'rms', 'voices', 'err']);
console.log('\nWORST CASE (ping+echoes+hit+roar+lunge+alert+heartbeat+music+fanfare, bed on):');
for (const w of res.worst) console.log(JSON.stringify(w));
const errs = h.errors.filter((e) => !/Failed to load resource/.test(e));
const warns = h.logs.filter((l) => /^(warn|error)/.test(l) && !/ScriptProcessor/.test(l));
console.log('page errors:', errs, ' warnings:', warns, ' engine errors:', res.errors);
const bed = res.out[0];
const worstPeak = Math.max(...res.worst.map((w) => w.peak));
const bad = [];
if (worstPeak >= 0.9) bad.push('worst-case peak ' + worstPeak + ' >= 0.9');
if (bed.peak < 0.01 || bed.peak > 0.25) bad.push('bed peak ' + bed.peak + ' outside 0.01..0.25');
if (errs.length || warns.length) bad.push('errors/warnings logged');
if (res.errors) bad.push('engine swallowed exceptions: ' + res.lastError);
for (const r of res.out) { if (r.err) bad.push(r.name + ' threw'); if (r.name !== bed.name && r.peak < 0.005) bad.push(r.name + ' is silent (' + r.peak + ')'); }
console.log(bad.length ? 'FAIL: ' + bad.join('; ') : 'PASS');
await h.close();
process.exit(bad.length ? 1 : 0);
