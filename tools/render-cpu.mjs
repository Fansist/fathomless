// Main-thread CPU time per Renderer.frame() (CDP ThreadTime, immune to scheduler contention) with raster flushed in.
//   node tools/render-cpu.mjs [depths=10,12] [WxH[xDPR]=1280x720] [frames=60] [label]   (always --disable-gpu: canvas raster runs on the main thread)
import { launch, openGame, out } from './render-lib.mjs';
import fs from 'node:fs';
const depths = (process.argv[2] || '10,12').split(',').map(Number);
const sz = (process.argv[3] || '1280x720').split('x').map(Number);
const frames = parseInt(process.argv[4] || '60', 10);
const label = process.argv[5] || '';
const flags = ['--disable-gpu', ...(process.env.FLAGS ? process.env.FLAGS.split(',') : [])];
const h = await launch({ width: sz[0], height: sz[1], dpr: sz[2] || 1, args: flags });
const { page } = h;
await openGame(h, 'start=1&seed=perf1&depth=1&god=1&noaudio=1', sz);
const cdp = await page.createCDPSession();
await cdp.send('Performance.enable');
const thread = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'ThreadTime').value;
const rows = [];
for (const depth of depths) {
  for (const bloom of [true, false]) {
    await page.evaluate((depth, bloom, disable) => {
      const f = window.__fathom, g = f.game, R = f.renderer;
      g.god = true;
      if (!g.run || g.run.depth !== depth) { f.start('perf1', 1); g.loadLevel(depth); }
      g.bot = () => ({ mx: 0.35, my: 0.1, ping: false });
      R.quality = bloom ? 'high' : 'low';
      for (const n of (disable || '').split(',').filter(Boolean)) Object.getPrototypeOf(R)[n] = function () {};
      window.__k = 0;
      window.__spawn = () => g.spawnPing(g.player.x, g.player.y, 0.55 + 0.45 * ((window.__k++ * 0.37) % 1), { kind: 'player' });
      for (let i = 0; i < 160; i++) { if (i % 20 === 0) window.__spawn(); g.update(1 / 60); }
      for (let i = 0; i < 6; i++) { g.update(1 / 60); R.frame(); R.ctx.getImageData(0, 0, 1, 1); }
    }, depth, bloom, process.env.DISABLE);
    const t0 = await thread();
    const wall = await page.evaluate((frames) => {
      const f = window.__fathom, g = f.game, R = f.renderer;
      const w0 = performance.now(); let upd = 0;
      for (let i = 0; i < frames; i++) {
        const u0 = performance.now();
        if (i % 20 === 0) window.__spawn();
        g.update(1 / 60);
        upd += performance.now() - u0;
        R.frame(); R.ctx.getImageData(0, 0, 1, 1);
      }
      return { wall: (performance.now() - w0 - upd) / frames, upd: upd / frames, pings: g.pings.length };
    }, frames);
    const t1 = await thread();
    // ThreadTime also includes g.update(): subtract its (wall-measured) share
    const cpu = ((t1 - t0) * 1000) / frames - wall.upd;
    const r = { depth, bloom, cpuMsPerFrame: +cpu.toFixed(2), wallMsPerFrame: +wall.wall.toFixed(2), updMs: +wall.upd.toFixed(2), pings: wall.pings };
    rows.push(r); console.log(JSON.stringify(r));
  }
}
console.log('errors', JSON.stringify(h.errors));
if (label) fs.writeFileSync(out(`cpu-${label}.json`), JSON.stringify(rows, null, 1));
await h.close();
