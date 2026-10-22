// Plays levels with a simple omniscient-navigation bot, taking screenshots along the way.
import { launch, sleep } from './harness.mjs';
import { fileURLToPath } from 'node:url';
const out = (n) => fileURLToPath(new URL('./out/' + n, import.meta.url));
const depth = parseInt(process.argv[2] || '1', 10);
const seed = process.argv[3] || 'botseed';
const h = await launch({});
const { page } = h;
await page.goto(h.url + `/index.html?start=1&seed=${seed}&depth=${depth}&noaudio=1`, { waitUntil: 'load' });
await sleep(800);
await page.evaluate(() => window.__fathom.freeze(true));

await page.evaluate(async () => {
  const W = await import('/js/world.js');
  const f = window.__fathom, g = f.game;
  const nav = new W.NavField(g.lv);
  nav.compute(g.lv, 'S', g.lv.exit.x, g.lv.exit.y);
  const d = { x: 0, y: 0 };
  let pingT = 0, holdT = 0, big = false;
  window.__bot = { log: [] };
  g.bot = (g) => {
    const p = g.player;
    const ok = nav.dir(g.lv, p.x, p.y, d);
    pingT -= 1 / 60;
    let ping = false;
    if (holdT > 0) { holdT -= 1 / 60; ping = holdT > 0; }
    else if (pingT <= 0) { holdT = big ? 0.8 : 0.12; big = !big; pingT = 2.2; ping = true; }
    // slow down when an enemy is near
    let slow = 1;
    for (const e of g.enemies) if (e.type !== 'urchin' && Math.hypot(e.x - p.x, e.y - p.y) < 200) slow = 0.4;
    return { mx: ok ? d.x * slow : 0, my: ok ? d.y * slow : 0, ping, dash: false, buoy: false };
  };
});

const shots = [20, 60, 120, 240, 480];
let stepsDone = 0;
for (const sTarget of shots) {
  const st = await page.evaluate((n) => { const f = window.__fathom; for (let i = 0; i < n; i++) { if (f.game.state !== 'play') break; f.step(1, false); } f.step(0, true); const g = f.game; return { state: g.state, hull: g.player.hull, e: g.player.energy | 0, depth: g.run.depth, pos: [g.player.x | 0, g.player.y | 0], t: g.levelTime | 0 }; }, (sTarget - stepsDone) * 6);
  stepsDone = sTarget;
  console.log(sTarget, st);
  await page.screenshot({ path: out(`bot-d${depth}-${sTarget}.png`) });
  if (st.state !== 'play') break;
}
console.log('errors', h.errors);
await h.close();
