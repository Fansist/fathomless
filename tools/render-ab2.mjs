// A/B of canvas-call classes (skip strokes of a given lineWidth, skip rect fills...) with raster flushed into the timing.
import { launch, openGame } from './render-lib.mjs';
const depth = parseInt(process.argv[2] || '12', 10);
const sz = (process.argv[3] || '1280x720').split('x').map(Number);
const flags = process.argv.slice(4);
const h = await launch({ width: sz[0], height: sz[1], args: flags });
await openGame(h, 'start=1&seed=perf1&depth=1&god=1&noaudio=1', sz);
const res = await h.page.evaluate((depth) => {
  const f = window.__fathom, g = f.game, R = f.renderer;
  g.god = true; f.start('perf1', 1); g.loadLevel(depth);
  g.bot = () => ({ mx: 0.35, my: 0.1, ping: false });
  let k = 0;
  const spawn = () => g.spawnPing(g.player.x, g.player.y, 0.55 + 0.45 * ((k++ * 0.37) % 1), { kind: 'player' });
  for (let i = 0; i < 160; i++) { if (i % 20 === 0) spawn(); g.update(1 / 60); }
  const P = CanvasRenderingContext2D.prototype, oStroke = P.stroke, oFill = P.fill, oDraw = P.drawImage;
  let skip = null;
  P.stroke = function (...a) { if (skip && skip.stroke && skip.stroke(this)) return; return oStroke.apply(this, a); };
  P.fill = function (...a) { if (skip && skip.fill && skip.fill(this)) return; return oFill.apply(this, a); };
  const lw = (...w) => ({ stroke: (c) => w.includes(c.lineWidth) });
  const variants = {
    ALL: null,
    'lw 12 (mem halo)': lw(12), 'lw 0.8 (mem hatch)': lw(0.8), 'lw 1.4 (mem core/coral/currents)': lw(1.4), 'lw 1.6 (kelp)': lw(1.6),
    'lw 1.5 (echo core)': lw(1.5), 'lw 7 (echo glow)': lw(7), 'lw 9 (front)': lw(9), 'lw 1.2 (bulb stalk)': lw(1.2),
    'no strokes at all': { stroke: () => true },
  };
  const names = Object.keys(variants), samples = {}; names.forEach((n) => (samples[n] = []));
  let step = 0;
  for (let round = 0; round < 14; round++) for (const n of names) {
    skip = variants[n];
    for (let i = 0; i < 5; i++) {
      if (step++ % 20 === 0) spawn();
      g.update(1 / 60);
      const t0 = performance.now(); R.frame(); R.ctx.getImageData(0, 0, 1, 1);
      if (i >= 1) samples[n].push(performance.now() - t0);
    }
  }
  const med = (a) => { a = a.slice().sort((x, y) => x - y); return a[a.length >> 1]; };
  return names.map((n) => ({ variant: n, median: +med(samples[n]).toFixed(1), min: +Math.min(...samples[n]).toFixed(1) }));
}, depth);
console.table(res);
console.log('errors', JSON.stringify(h.errors));
await h.close();
