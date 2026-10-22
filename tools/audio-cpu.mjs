// Real-time CPU cost of the engine: renderer-process CPU seconds (CDP SystemInfo.getProcessInfo, robust to a loaded machine)
// over a window with the audio context suspended (baseline), the bed alone, and busy play (ping+echoes ~1/s, music, clicks,
// pickups, heartbeat). Reports percent of one core for each, and the difference = the audio engine's cost.
// usage: node tools/audio-cpu.mjs [seconds=12] [--lite]    (--lite: shorter 2.4 s reverb impulse as used on <= 2 core devices)
import { openPage, sleep } from './audio-lib.mjs';

const SEC = parseFloat(process.argv.find((a) => /^\d+(\.\d+)?$/.test(a)) || '12');
const h = await openPage();
const session = await h.browser.target().createCDPSession();
const cpu = async () => { const { processInfo } = await session.send('SystemInfo.getProcessInfo'); const r = {}; for (const p of processInfo) r[p.type] = (r[p.type] || 0) + p.cpuTime; return r; };
const LITE = process.argv.includes('--lite'), NOVERB = process.argv.includes('--noverb'), IR = parseFloat((process.argv.find((a) => a.startsWith('--ir=')) || '').slice(5)) || 0;

await h.page.evaluate(async (LITE, NOVERB, IR) => {
  const { AudioEngine } = await import('/js/audio.js');
  const a = (window.__a = new AudioEngine());
  a.init();
  if (LITE) { a.verb.buffer = a.makeImpulse(2.4, 2.2); }
  if (IR) { a.verb.buffer = a.makeImpulse(IR, 2.2); }
  if (NOVERB) { a.verbSend.disconnect(); }
  window.__echo = []; for (let i = 0; i < 14; i++) window.__echo.push({ t: 0.05 + i * 0.09, gain: Math.max(0.15, 1 - i * 0.07), pan: Math.sin(i * 1.7) * 0.9 });
  // driver at 60 Hz like the game loop; mode set from the outside
  window.__mode = 'off'; let n = 0;
  setInterval(() => {
    n++;
    if (window.__mode === 'off') return;
    a.tick(1 / 60, true);
    if (window.__mode === 'busy') {
      if (n % 60 === 0) { a.ping(0.8); a.echoes(window.__echo); }
      if (n % 100 === 0) a.pickup('pearl');
      if (n % 97 === 0) a.click(-0.5, 0.7);
      a.setDanger(0.6);
    }
  }, 1000 / 60);
}, LITE, NOVERB, IR);
await sleep(1500);

async function window_(mode, suspend) {
  await h.page.evaluate(async (mode, suspend) => { window.__mode = mode; if (suspend) await window.__a.ctx.suspend(); else await window.__a.ctx.resume(); }, mode, suspend);
  await sleep(2500); // settle
  const c0 = await cpu(), t0 = Date.now();
  await sleep(SEC * 1000);
  const c1 = await cpu(), dt = (Date.now() - t0) / 1000;
  const d = {}; for (const k in c1) d[k] = ((c1[k] - (c0[k] || 0)) / dt) * 100;
  return d;
}
const base = await window_('off', true);
const bed = await window_('bed', false);
const busy = await window_('busy', false);
const f = (v) => v.toFixed(1) + '%';
console.log(`${NOVERB ? 'NO reverb' : IR ? IR + ' s reverb' : LITE ? '2.4 s reverb (lite)' : '3.6 s reverb'}; CPU of one core over ${SEC} s windows (renderer / browser / gpu / utility):`);
for (const [n, d] of [['suspended (baseline)', base], ['bed only', bed], ['busy play', busy]]) console.log(' ', n.padEnd(22), ['renderer', 'browser', 'GPU', 'utility'].map((k) => k + ' ' + f(d[k] || 0)).join('  '));
console.log(`  audio cost ~ bed ${f((bed.renderer || 0) - (base.renderer || 0))}, busy ${f((busy.renderer || 0) - (base.renderer || 0))} of one core (renderer process; includes this test's 60 Hz timer)`);
await h.close();
process.exit(0);
