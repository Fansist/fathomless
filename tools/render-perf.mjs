// Renderer.frame() profiling.  node tools/render-perf.mjs [depths=10,12,6] [WxH[xDPR]=1920x1080] [frames=240] [label] [chromeFlags,comma,separated]
// mean/p95 = ms spent inside Renderer.frame() (JS + canvas recording; with --disable-gpu this is the full raster cost too).
import { launch, sleep, openGame, out } from './render-lib.mjs';
import fs from 'node:fs';
const depths = (process.argv[2] || '10,12,6').split(',').map(Number);
const sz = (process.argv[3] || '1920x1080').split('x').map(Number);
const frames = parseInt(process.argv[4] || '240', 10);
const label = process.argv[5] || '';
const flags = (process.argv[6] || '').split(',').filter(Boolean);
const doRaf = !process.env.NORAF;
const flush = !!process.env.FLUSH;   // read one pixel back after every frame so the raster work lands inside the timing
const h = await launch({ width: sz[0], height: sz[1], dpr: sz[2] || 1, args: flags });
const { page } = h;
await openGame(h, 'start=1&seed=perf1&depth=1&god=1&noaudio=1', sz);
const rows = [];
for (const depth of depths) {
  for (const bloom of [true, false]) {
    const r = await page.evaluate(async (depth, bloom, frames, doRaf, flush) => {
      const f = window.__fathom, g = f.game, R = f.renderer;
      g.god = true;
      if (!g.run || g.run.depth !== depth) { f.start('perf1', 1); g.loadLevel(depth); }
      g.bot = () => ({ mx: 0.35, my: 0.1, ping: false });
      R.quality = bloom ? 'high' : 'low';
      let k = 0;
      const spawn = () => { g.spawnPing(g.player.x, g.player.y, 0.55 + 0.45 * ((k++ * 0.37) % 1), { kind: 'player' }); };
      for (let i = 0; i < 160; i++) { if (i % 20 === 0) spawn(); g.update(1 / 60); }
      const ts = [];
      let alive = 0;
      for (let i = 0; i < frames; i++) {
        if (i % 20 === 0) spawn();
        g.update(1 / 60);
        const t0 = performance.now();
        R.frame();
        if (flush) R.ctx.getImageData(0, 0, 1, 1);
        ts.push(performance.now() - t0);
        alive += g.pings.length;
      }
      let raf = { n: 1, ms: 1 };
      if (doRaf) raf = await Promise.race([new Promise((res) => {
        let n = 0; const t0 = performance.now();
        const tick = () => { g.update(1 / 60); if (n % 20 === 0) spawn(); R.frame(); n++; if (performance.now() - t0 < 2500) requestAnimationFrame(tick); else res({ n, ms: performance.now() - t0 }); };
        requestAnimationFrame(tick);
      }), new Promise((res) => setTimeout(() => res({ n: 1, ms: 99999 }), 20000))]);
      ts.sort((a, b) => a - b);
      const mean = ts.reduce((a, b) => a + b, 0) / ts.length;
      return { depth, bloom, mean: +mean.toFixed(2), p50: +ts[ts.length >> 1].toFixed(2), p95: +ts[Math.floor(ts.length * 0.95)].toFixed(2), max: +ts[ts.length - 1].toFixed(2), pings: +(alive / frames).toFixed(1), flora: g.lv.flora.length, enemies: g.enemies.length, rafMsPerFrame: +(raf.ms / raf.n).toFixed(1) };
    }, depth, bloom, frames, doRaf, flush);
    rows.push(r);
    console.log(JSON.stringify(r));
  }
}
console.log('canvas', JSON.stringify(await page.evaluate(() => { const r = window.__fathom.renderer; return { w: r.canvas.width, h: r.canvas.height, mem: [r.mem.width, r.mem.height], bloom: r.bloom.map((b) => [b.width, b.height]) }; })));
console.log('errors', JSON.stringify(h.errors));
if (label) fs.writeFileSync(out(`perf-${label}.json`), JSON.stringify(rows, null, 1));
await h.close();
