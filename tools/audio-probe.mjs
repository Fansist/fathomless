import { launch, sleep } from './harness.mjs';
const { page, errors, logs, url, close } = await launch();
await page.goto(url + '/index.html?noaudio=1', { waitUntil: 'load' });
const r = await page.evaluate(async () => {
  const { AudioEngine } = await import('/js/audio.js');
  const out = {};
  let t0 = performance.now();
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  out.ctxMs = performance.now() - t0;
  const a = new AudioEngine(); a.ctx = ctx;
  t0 = performance.now(); a.makeImpulse(3.6, 2.2); out.impulseMs = performance.now() - t0;
  t0 = performance.now(); a.makeImpulse(3.6, 2.2); out.impulse2Ms = performance.now() - t0;
  const b = new AudioEngine();
  t0 = performance.now(); b.init(); out.initMs = performance.now() - t0;
  return out;
});
console.log(JSON.stringify(r), errors, logs.slice(0, 5));
await close();
