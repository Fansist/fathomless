// Leak / CPU hygiene: node counts vs onended disconnects over a simulated 3-minute session, voice cap, idle tick() cost.
//  A) OfflineAudioContext, 180 s of plausible play (60 Hz tick() + seeded random sounds, charge cycles, biome changes,
//     volume/mute changes) + a quiet tail: live nodes must return to baseline, voices to 0, voices never above the cap.
//  B) idle tick(): thousands of frames with nothing to play must create no nodes and schedule no AudioParam events.
//  C) real-time AudioContext, 30 s of the same mix at wall-clock speed, then settle: same assertions.
// usage: node tools/audio-leaks.mjs [--quick]    (--quick: 60 s offline, 12 s real-time)
import { openPage } from './audio-lib.mjs';

const QUICK = process.argv.includes('--quick');
const h = await openPage();
const bad = [];
const check = (c, msg) => { if (!c) { bad.push(msg); console.log('  FAIL', msg); } };

// in-page: seeded session driver shared by A and C
await h.page.evaluate(() => {
  window.__mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  window.__driver = function (a, rnd) {
    const echo = [];
    for (let i = 0; i < 14; i++) echo.push({ t: 0.05 + i * 0.09, gain: Math.max(0.1, 1 - i * 0.07), pan: Math.sin(i * 1.7) * 0.9 });
    const st = { nextPing: 0.5, nextSfx: 1, nextBiome: 30, nextVol: 20, charging: 0, nextCharge: 3, maxVoices: 0, sounds: 0, danger: 0 };
    const sfx = ['click', 'alert', 'alert2', 'lunge', 'thrum', 'roar'];
    return {
      st,
      frame(t, dt, quiet) { // one game frame at audio-time t
        if (!quiet) {
          if (t >= st.nextPing) { a.ping(rnd() < 0.5 ? rnd() * 0.3 : 0.5 + rnd() * 0.5); if (rnd() < 0.85) a.echoes(echo); st.nextPing = t + 0.6 + rnd() * 2.2; st.sounds++; }
          if (t >= st.nextSfx) {
            const r = rnd();
            if (r < 0.45) a[sfx[(rnd() * 5) | 0]]((rnd() * 2 - 1), rnd());
            else if (r < 0.6) a.pickup(['pearl', 'pearl', 'pearl', 'buoy', 'patch'][(rnd() * 5) | 0]);
            else if (r < 0.7) a.hit();
            else if (r < 0.78) a.dash();
            else if (r < 0.84) { a.buoyPlace(); a.buoyBeep(rnd() * 2 - 1, rnd()); }
            else if (r < 0.88) a.denied();
            else if (r < 0.9) a.levelComplete();
            else if (r < 0.92) a.newDepth();
            else if (r < 0.93) a.ui(['hover', 'back', 'upgrade', 'click'][(rnd() * 4) | 0]);
            else if (r < 0.935) a.gameOver();
            else if (r < 0.94) a.victory();
            st.nextSfx = t + 0.15 + rnd() * 1.6; st.sounds++;
          }
          if (st.charging) { a.chargeUpdate(Math.min(1, (t - st.charging) / 1.2)); if (t - st.charging > 0.3 + rnd() * 0.01 + st.chargeLen) { a.chargeStop(); if (rnd() < 0.3) a.chargeStop(); st.charging = 0; st.nextCharge = t + 0.5 + rnd() * 3; } }
          else if (t >= st.nextCharge) { a.chargeStart(); st.charging = t; st.chargeLen = rnd() * 1.1; a.chargeUpdate(0); }
          if (t >= st.nextBiome) { a.setBiome((rnd() * 4) | 0, 1 + ((rnd() * 12) | 0)); st.nextBiome = t + 25 + rnd() * 30; }
          if (t >= st.nextVol) { a.setVolumes(rnd(), rnd()); if (rnd() < 0.3) a.setMuted(rnd() < 0.5); st.nextVol = t + 15 + rnd() * 20; }
          st.danger = Math.max(0, Math.min(1, st.danger + (rnd() - 0.5) * 0.02)); a.setDanger(st.danger);
        }
        a.tick(dt, true);
        if (a.voices > st.maxVoices) st.maxVoices = a.voices;
      },
    };
  };
});

/* ---------- A: offline 3-minute session ---------- */
{
  const SEC = QUICK ? 60 : 180;
  console.log(`[A] offline ${SEC} s session`);
  const r = await h.page.evaluate(async (SEC) => {
    const { AudioEngine } = await import('/js/audio.js');
    const P = window.__probe;
    const { a, off } = window.__mkOffline(AudioEngine, SEC + 14, { volume: 0.8, musicVol: 0.7, bed: true });
    await window.__wait(50);
    const base = P.live(), baseTotal = P.liveTotal();
    const rnd = window.__mulberry(12345), drv = window.__driver(a, rnd);
    a.whaleT = 5; a.depth = 3;
    const snaps = [];
    let t = 0, step = 1 / 60 * 3; // 50 ms = 3 frames
    const created0 = Object.assign({}, P.created);
    await new Promise((resolve) => {
      const go = () => {
        t += step;
        if (t >= SEC + 12) return;
        off.suspend(t).then(() => {
          const now = off.currentTime, quiet = now >= SEC;
          if (quiet && !drv.st.quietSet) { drv.st.quietSet = true; if (drv.st.charging) { a.chargeStop(); drv.st.charging = 0; } a.musicT = 1e9; a.whaleT = 1e9; a.setDanger(0); }
          for (let k = 0; k < 3; k++) drv.frame(now + k / 60, 1 / 60, quiet);
          if (Math.floor(now) % 15 === 0 && (!snaps.length || snaps[snaps.length - 1].t < Math.floor(now))) snaps.push({ t: Math.floor(now), voices: a.voices, live: P.liveTotal() });
          go(); // register the next suspend point before resuming
          off.resume();
        });
      };
      go();
      off.startRendering().then(() => resolve());
    });
    await window.__wait(1500); // flush pending ended events + the charge cleanup timers
    const end = P.live(), endTotal = P.liveTotal();
    const made = {};
    for (const k in P.created) made[k] = P.created[k] - (created0[k] || 0);
    return { base, baseTotal, end, endTotal, snaps, maxVoices: drv.st.maxVoices, sounds: drv.st.sounds, voicesEnd: a.voices, errors: a.errors, lastError: a.lastError && String(a.lastError.message), made };
  }, SEC);
  console.log('  baseline live nodes:', r.baseTotal, JSON.stringify(r.base));
  console.log('  nodes created during session:', JSON.stringify(r.made));
  console.log('  snapshots (t, voices, live nodes):', r.snaps.map((s) => `${s.t}s:${s.voices}v/${s.live}n`).join('  '));
  console.log('  end live nodes:', r.endTotal, ' voices at end:', r.voicesEnd, ' max voices seen:', r.maxVoices, ' sounds triggered:', r.sounds);
  check(r.endTotal <= r.baseTotal + 2, `offline: live nodes ${r.endTotal} did not return to baseline ${r.baseTotal}`);
  check(r.voicesEnd === 0, 'offline: voices at end = ' + r.voicesEnd);
  check(r.maxVoices <= 70, 'offline: voice cap exceeded: ' + r.maxVoices);
  check(r.errors === 0, 'offline: swallowed exceptions: ' + r.errors + ' ' + r.lastError);
  const mid = r.snaps.filter((s) => s.t > 20).map((s) => s.live);
  check(mid.length === 0 || Math.max(...mid) < r.baseTotal + 400, 'offline: live nodes mid-session too high: ' + Math.max(...mid));
}

/* ---------- B: idle tick() ---------- */
{
  console.log('[B] idle tick()');
  const r = await h.page.evaluate(async () => {
    const { AudioEngine } = await import('/js/audio.js');
    const { a } = window.__mkOffline(AudioEngine, 5, { bed: true });
    // count AudioParam automation calls
    const cnt = { n: 0 };
    const names = ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'cancelScheduledValues', 'setValueCurveAtTime'];
    const orig = {};
    for (const n of names) { orig[n] = AudioParam.prototype[n]; AudioParam.prototype[n] = function (...x) { cnt.n++; return orig[n].apply(this, x); }; }
    a.musicT = 1e9; a.whaleT = 1e9; a.beatT = 1e9; a.setDanger(0);
    a.tick(0.016, true); // settle the bed target
    const P = window.__probe, created0 = Object.assign({}, P.created), n0 = cnt.n;
    const t0 = performance.now();
    for (let i = 0; i < 20000; i++) a.tick(1 / 60, true);
    const ms = performance.now() - t0;
    let made = 0; for (const k in P.created) made += P.created[k] - (created0[k] || 0);
    for (const n of names) AudioParam.prototype[n] = orig[n];
    return { ms, made, params: cnt.n - n0 };
  });
  console.log('  20000 idle ticks:', r.ms.toFixed(1), 'ms, nodes created:', r.made, ', AudioParam events:', r.params);
  check(r.made === 0, 'idle tick created ' + r.made + ' nodes');
  check(r.params === 0, 'idle tick scheduled ' + r.params + ' AudioParam events');
  check(r.ms < 200, 'idle tick too slow: ' + r.ms.toFixed(0) + ' ms per 20000');
}

/* ---------- C: real-time ---------- */
{
  const SEC = QUICK ? 12 : 30;
  console.log(`[C] real-time ${SEC} s session`);
  const r = await h.page.evaluate(async (SEC) => {
    const { AudioEngine } = await import('/js/audio.js');
    const P = window.__probe;
    const a = new AudioEngine(); a.init();
    await window.__wait(600);
    const base = P.live(), baseTotal = P.liveTotal();
    const rnd = window.__mulberry(777), drv = window.__driver(a, rnd);
    a.whaleT = 4; a.depth = 3;
    const t0 = a.ctx.currentTime;
    let frames = 0, lastLive = 0, maxLive = 0;
    await new Promise((resolve) => {
      let last = performance.now(), acc = 0;
      const iv = setInterval(() => {
        const now = performance.now(); acc += Math.min(0.25, (now - last) / 1000); last = now;
        while (acc >= 1 / 60) { acc -= 1 / 60; frames++; drv.frame(a.ctx.currentTime - t0, 1 / 60, false); }
        const lt = P.liveTotal(); if (lt > maxLive) maxLive = lt;
        if (a.ctx.currentTime - t0 > SEC) { clearInterval(iv); resolve(); }
      }, 16);
    });
    a.chargeStop(); a.musicT = 1e9; a.whaleT = 1e9; a.setDanger(0);
    const peak = a.peak();
    await window.__wait(9000);
    const endTotal = P.liveTotal();
    return { base, baseTotal, endTotal, end: P.live(), maxLive, voicesEnd: a.voices, maxVoices: drv.st.maxVoices, errors: a.errors, lastError: a.lastError && String(a.lastError.message), frames, sounds: drv.st.sounds, state: a.ctx.state };
  }, SEC);
  console.log('  baseline live nodes:', r.baseTotal, ' max during session:', r.maxLive, ' end:', r.endTotal, ' voices end:', r.voicesEnd, ' max voices:', r.maxVoices, ' sounds:', r.sounds, ' frames:', r.frames);
  check(r.endTotal <= r.baseTotal + 2, `realtime: live nodes ${r.endTotal} did not return to baseline ${r.baseTotal}: ${JSON.stringify(r.end)}`);
  check(r.voicesEnd === 0, 'realtime: voices at end = ' + r.voicesEnd);
  check(r.maxVoices <= 70, 'realtime: voice cap exceeded: ' + r.maxVoices);
  check(r.errors === 0, 'realtime: swallowed exceptions: ' + r.errors + ' ' + r.lastError);
}

const errs = h.errors.filter((e) => !/Failed to load resource/.test(e));
check(errs.length === 0, 'page errors: ' + errs.join(' | '));
console.log(bad.length ? 'FAIL: ' + bad.join('; ') : 'PASS');
await h.close();
process.exit(bad.length ? 1 : 0);
