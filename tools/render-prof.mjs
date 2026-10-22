// Real-throughput profiler: which Renderer draw pass costs the most when the canvas is actually rasterised?
// node tools/render-prof.mjs [depth=10] [WxH=1280x720] [frames=4] [extraChromeFlag...]
import { launch, openGame } from './render-lib.mjs';
const depth = parseInt(process.argv[2] || '10', 10);
const sz = (process.argv[3] || '1280x720').split('x').map(Number);
const frames = parseInt(process.argv[4] || '4', 10);
const extra = process.argv.slice(5);
const h = await launch({ width: sz[0], height: sz[1], args: extra });
const { page } = h;
await openGame(h, 'start=1&seed=perf1&depth=1&god=1&noaudio=1', sz);
const passes = (process.env.PASSES || 'drawBokeh,drawSnow,drawCurrents,drawMemory,drawFlora,drawPings,pingVolume,pingFront,pingEchoes,drawWhiskers,drawItems,drawEnemies,drawPlayer,drawParticles,drawCompass,drawFloaters,drawBloom,drawOverlays').split(',');
const rows = await page.evaluate(async (depth, frames, passes) => {
  const f = window.__fathom, g = f.game, R = f.renderer, P = Object.getPrototypeOf(R);
  g.god = true; f.start('perf1', 1); g.loadLevel(depth);
  g.bot = () => ({ mx: 0.35, my: 0.1, ping: false });
  let k = 0;
  const spawn = () => g.spawnPing(g.player.x, g.player.y, 0.55 + 0.45 * ((k++ * 0.37) % 1), { kind: 'player' });
  for (let i = 0; i < 160; i++) { if (i % 20 === 0) spawn(); g.update(1 / 60); }
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const measure = async () => {
    await raf();
    const t0 = performance.now(); let rec = 0;
    for (let i = 0; i < frames; i++) {
      g.update(1 / 60); if (i % 2 === 0) spawn();
      const a = performance.now(); R.frame(); rec += performance.now() - a;
      await raf();
    }
    return { real: (performance.now() - t0) / frames, rec: rec / frames };
  };
  const out = [];
  out.push(['ALL', await measure()]);
  for (const name of passes) {
    const orig = P[name]; P[name] = function () {};
    out.push(['-' + name, await measure()]);
    P[name] = orig;
  }
  return out.map(([n, m]) => ({ n, real: +m.real.toFixed(1), rec: +m.rec.toFixed(2) }));
}, depth, frames, passes);
console.table(rows);
console.log('errors', h.errors);
await h.close();
