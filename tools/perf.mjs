import { launch, sleep } from './harness.mjs';
const h = await launch({ args: process.argv.includes('--gpu') ? [] : [] });
const { page } = h;
await page.goto(h.url + '/index.html?start=1&seed=perf1&depth=' + (process.argv[2] || 6) + '&god=1', { waitUntil: 'load' });
await sleep(1500);
const res = await page.evaluate(async () => {
  const f = window.__fathom, g = f.game;
  // fire several pings to make the scene busy
  const times = [];
  for (let i = 0; i < 4; i++) { g.firePing(i % 2 ? 1 : 0.6); for (let k = 0; k < 18; k++) g.update(1 / 60); }
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) f.renderer.frame();
  const tFrame = (performance.now() - t0) / 20;
  const t1 = performance.now();
  for (let i = 0; i < 120; i++) g.update(1 / 60);
  const tUpd = (performance.now() - t1) / 120;
  f.renderer.quality = 'low';
  const t2 = performance.now();
  for (let i = 0; i < 20; i++) f.renderer.frame();
  const tLow = (performance.now() - t2) / 20;
  return { renderMs: tFrame, renderLowMs: tLow, updateMs: tUpd, pings: g.pings.length, flora: g.lv.flora.length, enemies: g.enemies.length };
});
console.log(res);
console.log('errors', h.errors);
await h.close();
