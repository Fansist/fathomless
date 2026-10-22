// In-browser integration check of generated levels (headless Chrome, deterministic fixed-step simulation).
//   node tools/worldgen-browser.mjs [depths=1,3,5,8,11,12,13] [seed=wgbrowser]
// For each depth: load the level inside the real game, let an omniscient flow-field bot swim start -> exit (god mode so creatures
// cannot kill it), and report whether it arrived, how long it took, the worst wall penetration of the player and every creature,
// plus any page errors.
import { launch, sleep } from './harness.mjs';
const depths = (process.argv[2] || '1,3,5,8,11,12,13').split(',').map(Number);
const seed = process.argv[3] || 'wgbrowser';
const h = await launch({ width: 1280, height: 720 });
const { page } = h;
await page.goto(h.url + `/index.html?start=1&seed=${seed}&noaudio=1&mute=1&god=1&low=1`, { waitUntil: 'load' });
await sleep(800);
let bad = 0;
for (const d of depths) {
  const r = await page.evaluate(async (d) => {
    const W = await import('/js/world.js');
    const f = window.__fathom, g = f.game;
    f.freeze(true);
    const t0 = performance.now();
    g.loadLevel(d);
    const genMs = performance.now() - t0;
    const lv = g.lv;
    const nav = new W.NavField(lv);
    nav.compute(lv, 'S', lv.exit.x, lv.exit.y);
    const dir = { x: 0, y: 0 };
    g.bot = (gg) => {
      const p = gg.player;
      const ok = nav.dir(gg.lv, p.x, p.y, dir);
      return { mx: ok ? dir.x : 0, my: ok ? dir.y : 0, ping: false, dash: false, buoy: false };
    };
    let steps = 0, worst = 0, enemyWorst = 0, arrived = false;
    const t1 = performance.now();
    for (; steps < 60 * 150; steps++) {
      f.step(1, false);
      const p = g.player;
      worst = Math.max(worst, p.r - W.sdfAt(lv, p.x, p.y));
      for (const e of g.enemies) enemyWorst = Math.max(enemyWorst, e.r * (e.type === 'leviathan' ? 0.85 : e.type === 'eel' ? 0.85 : e.type === 'angler' ? 0.9 : 0.8) - W.sdfAt(lv, e.x, e.y));
      if (g.state !== 'play') { arrived = g.state === 'levelend' || g.state === 'upgrade' || g.state === 'victory'; break; }
    }
    const stepMs = (performance.now() - t1) / Math.max(1, steps);
    return {
      depth: d, genMs: +genMs.toFixed(0), arrived, state: g.state, simSeconds: +(steps / 60).toFixed(1), route: lv.routeLength,
      playerPenetration: +worst.toFixed(2), creaturePenetration: +enemyWorst.toFixed(2), enemies: g.enemies.length, pickups: g.pickups.length,
      stepMs: +stepMs.toFixed(2),
    };
  }, d);
  console.log(JSON.stringify(r));
  if (!r.arrived || r.playerPenetration > 1.5) bad++;
}
console.log('page errors:', h.errors.length ? h.errors.slice(0, 5) : 'none');
await h.close();
if (bad || h.errors.length) process.exit(1);
