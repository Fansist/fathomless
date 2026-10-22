// Interleaved A/B of Renderer passes (each variant disables one method) with the raster flushed into the timing.
//   node tools/render-ab.mjs <depth> <WxH> <comma list of methods> [chromeFlags]   (use --disable-gpu for CPU raster)
import { launch, openGame } from './render-lib.mjs';
const depth = parseInt(process.argv[2] || '10', 10);
const sz = (process.argv[3] || '1280x720').split('x').map(Number);
const names = (process.argv[4] || 'pingVolume').split(',');
const flags = process.argv.slice(5);
const h = await launch({ width: sz[0], height: sz[1], dpr: sz[2] || 1, args: flags });
await openGame(h, 'start=1&seed=perf1&depth=1&god=1&noaudio=1', sz); await h.page.evaluate((r) => { window.__ROUNDS = r; }, process.env.ROUNDS || 6);
const res = await h.page.evaluate((depth, names) => {
  const f = window.__fathom, g = f.game, R = f.renderer, P = Object.getPrototypeOf(R);
  g.god = true; f.start('perf1', 1); g.loadLevel(depth);
  g.bot = () => ({ mx: 0.35, my: 0.1, ping: false });
  let k = 0;
  const spawn = () => g.spawnPing(g.player.x, g.player.y, 0.55 + 0.45 * ((k++ * 0.37) % 1), { kind: 'player' });
  for (let i = 0; i < 160; i++) { if (i % 20 === 0) spawn(); g.update(1 / 60); }
  const variants = ['ALL', ...names];
  const samples = {}; variants.forEach((v) => (samples[v] = []));
  let step = 0;
  for (let round = 0; round < (+(window.__ROUNDS) || 6); round++) {
    for (const v of variants) {
      const orig = v === 'ALL' ? null : P[v];
      if (orig) P[v] = function () {};
      for (let i = 0; i < 6; i++) {
        if (step++ % 20 === 0) spawn();
        g.update(1 / 60);
        const t0 = performance.now();
        R.frame(); R.ctx.getImageData(0, 0, 1, 1);
        if (i >= 1) samples[v].push(performance.now() - t0);
      }
      if (orig) P[v] = orig;
    }
  }
  const med = (a) => { a = a.slice().sort((x, y) => x - y); return a[a.length >> 1]; };
  const min = (a) => Math.min(...a);
  return variants.map((v) => ({ variant: v, median: +med(samples[v]).toFixed(1), min: +min(samples[v]).toFixed(1) }));
}, depth, names);
console.table(res);
console.log('errors', JSON.stringify(h.errors));
await h.close();
