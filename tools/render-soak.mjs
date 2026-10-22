// Renderer soak: every depth 1..13 (bot swims + pings), title cycles, pause/resume; checks for errors, NaN and unbounded memory-map growth.
import { launch, openGame, sleep } from './render-lib.mjs';
const h = await launch({ width: 1280, height: 720, args: ['--disable-gpu'] });
const { page } = h;
await openGame(h, 'start=1&seed=soak&depth=1&god=1&noaudio=1', [1280, 720]);
const res = await page.evaluate(async () => {
  const W = await import('/js/world.js');
  const f = window.__fathom, g = f.game, R = f.renderer;
  const rows = [];
  for (let depth = 1; depth <= 13; depth++) {
    g.god = true;
    if (depth === 1) { f.start('soak', 1); } else g.loadLevel(depth);
    const nav = new W.NavField(g.lv); nav.compute(g.lv, 'S', g.lv.exit.x, g.lv.exit.y);
    const d = { x: 0, y: 0 }; let t = 0;
    g.bot = (gg) => { const p = gg.player; const ok = nav.dir(gg.lv, p.x, p.y, d); t += 1 / 60; return { mx: ok ? d.x : 0, my: ok ? d.y : 0, ping: (t % 1.6) < 0.25 + (t % 3.2 < 1.6 ? 0.5 : 0), dash: false, buoy: false }; };
    let worst = 0, sum = 0, n = 0;
    for (let i = 0; i < 600 && g.state === 'play'; i++) {
      g.update(1 / 60);
      if (i % 3 === 0) { const a = performance.now(); R.frame(); const dt = performance.now() - a; worst = Math.max(worst, dt); sum += dt; n++; }
    }
    let segs = 0, cells = 0; for (const c of R.mcells) if (c) { cells++; segs += c.n / 6; }
    rows.push({ depth, state: g.state, frames: n, avgMs: +(sum / n).toFixed(2), worstMs: +worst.toFixed(1), memSegs: segs, memCells: cells, occKB: (R.mocc.length / 1024) | 0, flora: g.lv.flora.length, nan: [g.cam.x, g.cam.y, g.player.x].some((v) => !Number.isFinite(v)) });
  }
  // title cycles (glow texture rebuild), pause/resume
  for (let k = 0; k < 4; k++) { g.startTitle(); for (let i = 0; i < 400; i++) { g.update(1 / 60); if (i % 20 === 0) R.frame(); } }
  f.start('soak2', 1); for (let i = 0; i < 120; i++) { g.update(1 / 60); R.frame(); }
  g.pause(); for (let i = 0; i < 30; i++) { g.update(1 / 60); R.frame(); } g.resume();
  return rows;
});
console.table(res);
console.log('errors', JSON.stringify(h.errors));
await h.close();
