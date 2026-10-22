// Integration: the real game (index.html, real AudioContext) driven at wall-clock 60 Hz by an omniscient bot with the
// main loop frozen (headless software rendering is far too slow for rAF), audio.tick() fed from the same driver.
// Records audio.peak() every ~20 ms, voices, node counts and (when the browser has it) the audio render load; then checks
// the M key mute path and the tab-hidden suspend/resume path of main.js.
// usage: node tools/audio-live.mjs [seconds=45] [seed]
import { launch, sleep } from './harness.mjs';

const SEC = parseFloat(process.argv[2] || '45');
const seed = process.argv[3] || 'live7';
const h = await launch();
const { page } = h;
await page.goto(h.url + `/index.html?start=1&seed=${seed}&depth=3&god=1`, { waitUntil: 'load' });
await sleep(1500);
// probe nodes (patch BaseAudioContext early enough: the engine already exists, so count from now on and compare)
await page.evaluate(() => {
  const P = (window.__probe = { created: {}, disc: {} });
  const AC = window.BaseAudioContext;
  for (const m of ['createOscillator', 'createBufferSource', 'createGain', 'createBiquadFilter', 'createStereoPanner']) {
    const orig = AC.prototype[m];
    AC.prototype[m] = function (...a) { const n = orig.apply(this, a); P.created[n.constructor.name] = (P.created[n.constructor.name] || 0) + 1; return n; };
  }
  const od = AudioNode.prototype.disconnect;
  AudioNode.prototype.disconnect = function (...a) { if (a.length === 0 && !this.__d) { this.__d = 1; const k = this.constructor.name; P.disc[k] = (P.disc[k] || 0) + 1; } return od.apply(this, a); };
  P.live = () => { let s = 0; for (const k in P.created) s += P.created[k] - (P.disc[k] || 0); return s; };
  window.__fathom.freeze(true);
});

const res = await page.evaluate(async (SEC) => {
  const W = await import('/js/world.js');
  const f = window.__fathom, g = f.game, a = f.audio, P = window.__probe;
  const out = { state0: a.ctx && a.ctx.state, ok: a.ok };
  let nav = null, navDepth = -1;
  const d = { x: 0, y: 0 };
  let pingT = 0, holdT = 0, big = false, buoyT = 5, dashT = 9;
  g.bot = (gg) => {
    const p = gg.player;
    if (navDepth !== gg.run.depth) { nav = new W.NavField(gg.lv); nav.compute(gg.lv, 'S', gg.lv.exit.x, gg.lv.exit.y); navDepth = gg.run.depth; }
    const ok = nav.dir(gg.lv, p.x, p.y, d);
    pingT -= 1 / 60; buoyT -= 1 / 60; dashT -= 1 / 60;
    let ping = false;
    if (holdT > 0) { holdT -= 1 / 60; ping = holdT > 0; }
    else if (pingT <= 0) { holdT = big ? 0.8 : 0.12; big = !big; pingT = 1.6; ping = true; }
    let buoy = false, dash = false;
    if (buoyT <= 0) { buoy = true; buoyT = 7; }
    if (dashT <= 0) { dash = true; dashT = 6; }
    return { mx: ok ? d.x : 0, my: ok ? d.y : 0, ping, dash, buoy };
  };
  const stat = { peaks: [], maxVoices: 0, states: {}, levels: 0, runs: 0, frames: 0, maxLive: 0, hits: 0 };
  const origHit = a.hit.bind(a); a.hit = () => { stat.hits++; origHit(); };
  const base = P.live();
  // render capacity (Chrome 120+)
  let cap = null;
  if (a.ctx.renderCapacity) { try { cap = { avg: [], peak: [], under: [] }; a.ctx.renderCapacity.addEventListener('update', (e) => { cap.avg.push(e.averageLoad); cap.peak.push(e.peakLoad); cap.under.push(e.underrunRatio); }); a.ctx.renderCapacity.start({ updateInterval: 1 }); } catch (e) { cap = null; } }
  await new Promise((resolve) => {
    const t0 = performance.now(); let last = t0, acc = 0, lastPeak = t0;
    const iv = setInterval(() => {
      const now = performance.now();
      acc += Math.min(0.25, (now - last) / 1000); last = now;
      while (acc >= 1 / 60) {
        acc -= 1 / 60; stat.frames++;
        if (g.state === 'upgrade' && g.upgradeChoices && g.upgradeChoices.length) { stat.levels++; g.chooseUpgrade(g.upgradeChoices[0].id); }
        else if (g.state === 'gameover' || g.state === 'victory') { stat.runs++; f.start(undefined, 3); }
        else g.update(1 / 60);
        stat.states[g.state] = (stat.states[g.state] || 0) + 1;
        a.tick(1 / 60, g.state === 'play' || g.state === 'levelend');
        if (a.voices > stat.maxVoices) stat.maxVoices = a.voices;
      }
      if (now - lastPeak >= 20) { lastPeak = now; stat.peaks.push(a.peak()); }
      stat.maxLive = Math.max(stat.maxLive, P.live());
      if (now - t0 > SEC * 1000) { clearInterval(iv); resolve(); }
    }, 8);
  });
  if (cap) { try { a.ctx.renderCapacity.stop(); } catch (e) { /* noop */ } }
  const pk = stat.peaks.slice().sort((x, y) => x - y);
  const q = (p) => +pk[Math.min(pk.length - 1, Math.floor(p * pk.length))].toFixed(3);
  out.peak = { n: pk.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: +pk[pk.length - 1].toFixed(3) };
  out.maxVoices = stat.maxVoices; out.frames = stat.frames; out.levels = stat.levels; out.runs = stat.runs; out.hits = stat.hits;
  out.depth = g.run && g.run.depth; out.states = stat.states;
  out.errors = a.errors; out.lastError = a.lastError && String(a.lastError.message);
  out.live = { base, max: stat.maxLive };
  if (cap && cap.avg.length) out.renderCapacity = { avgLoadMean: +(cap.avg.reduce((s, v) => s + v, 0) / cap.avg.length).toFixed(3), peakLoadMax: +Math.max(...cap.peak).toFixed(3), underrunMax: +Math.max(...cap.under).toFixed(3), n: cap.avg.length };
  // quiet down and settle
  a.hit = origHit;
  g.bot = null;
  return out;
}, SEC);
console.log(JSON.stringify(res, null, 1));

// mute key + visibility paths of main.js (run the real loop again)
await page.evaluate(() => window.__fathom.freeze(false));
await sleep(300);
await page.keyboard.down('KeyM'); await sleep(450); await page.keyboard.up('KeyM'); await sleep(700);
const mute1 = await page.evaluate(() => { const a = window.__fathom.audio; return { muted: a.muted, gain: a.master.gain.value }; });
await page.keyboard.down('KeyM'); await sleep(450); await page.keyboard.up('KeyM'); await sleep(700);
const mute2 = await page.evaluate(() => { const a = window.__fathom.audio; return { muted: a.muted, gain: a.master.gain.value }; });
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
await sleep(400);
const hidden = await page.evaluate(() => window.__fathom.audio.ctx.state);
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
await sleep(400);
const shown = await page.evaluate(() => window.__fathom.audio.ctx.state);
console.log('mute on/off:', JSON.stringify(mute1), JSON.stringify(mute2), ' hidden ->', hidden, ' shown ->', shown);

const bad = [];
const errs = h.errors.filter((e) => !/Failed to load resource/.test(e));
const warns = h.logs.filter((l) => /^(warn|error)/.test(l));
if (res.ok !== true) bad.push('audio did not initialise in the game');
if (res.errors) bad.push('engine swallowed ' + res.errors + ' exceptions: ' + res.lastError);
if (res.maxVoices > 70) bad.push('voice cap exceeded: ' + res.maxVoices);
if (res.peak.max >= 0.9) bad.push('output peak ' + res.peak.max + ' >= 0.9');
if (res.peak.p50 < 0.005) bad.push('median level ' + res.peak.p50 + ': bed inaudible?');
if (res.live.max > res.live.base + 400) bad.push('node count ballooned: ' + res.live.max + ' vs base ' + res.live.base);
if (!(mute1.muted === true && mute1.gain < 0.01 && mute2.muted === false && mute2.gain > 0.5)) bad.push('M key mute path wrong');
if (hidden !== 'suspended' || shown !== 'running') bad.push(`visibility path wrong (hidden ${hidden}, shown ${shown})`);
if (errs.length) bad.push('page errors: ' + errs.join(' | ').slice(0, 300));
if (warns.length) bad.push('console warnings: ' + warns.join(' | ').slice(0, 300));
console.log(bad.length ? 'FAIL: ' + bad.join('; ') : 'PASS');
await h.close();
process.exit(bad.length ? 1 : 0);
