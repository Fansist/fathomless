// Counts canvas calls per Renderer.frame() (geometry load) for a heavy scene.  node tools/render-count.mjs [depth=10] [WxH=1280x720]
import { launch, openGame } from './render-lib.mjs';
const depth = parseInt(process.argv[2] || '10', 10);
const sz = (process.argv[3] || '1280x720').split('x').map(Number);
const h = await launch({ width: sz[0], height: sz[1] });
await openGame(h, 'start=1&seed=perf1&depth=1&god=1&noaudio=1', sz);
const res = await h.page.evaluate((depth) => {
  const f = window.__fathom, g = f.game, R = f.renderer;
  g.god = true; f.start('perf1', 1); g.loadLevel(depth);
  g.bot = () => ({ mx: 0.35, my: 0.1, ping: false });
  let k = 0;
  const spawn = () => g.spawnPing(g.player.x, g.player.y, 0.55 + 0.45 * ((k++ * 0.37) % 1), { kind: 'player' });
  for (let i = 0; i < 160; i++) { if (i % 20 === 0) spawn(); g.update(1 / 60); }
  const P = CanvasRenderingContext2D.prototype, c = {};
  for (const n of ['stroke', 'fill', 'fillRect', 'rect', 'lineTo', 'moveTo', 'arc', 'drawImage', 'quadraticCurveTo', 'beginPath', 'createRadialGradient', 'save', 'ellipse']) {
    const o = P[n]; P[n] = function (...a) { c[n] = (c[n] || 0) + 1; return o.apply(this, a); };
  }
  const N = 30;
  for (let i = 0; i < N; i++) { if (i % 20 === 0) spawn(); g.update(1 / 60); R.frame(); }
  const out = {}; for (const n in c) out[n] = Math.round(c[n] / N);
  out.pings = g.pings.length;
  return out;
}, depth);
console.log(JSON.stringify(res));
await h.close();
