// Visual check of the creatures in the real page: places each creature type in view of the player, pings, screenshots.
//   node tools/ai-shot.mjs [depth]   -> tools/out/ai-<name>.png
import { launch, sleep } from './harness.mjs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
fs.mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
const out = (n) => fileURLToPath(new URL('./out/' + n, import.meta.url));
const depth = +(process.argv[2] || 12);

const h = await launch({ width: 1280, height: 720 });
const { page } = h;
await page.goto(h.url + `/index.html?start=1&seed=shot1&depth=${depth}&noaudio=1&mute=1&god=1`, { waitUntil: 'load' });
await sleep(700);
await page.evaluate(() => window.__fathom.freeze(true));

const info = await page.evaluate(async () => {
  const f = window.__fathom, g = f.game;
  const W = await import('/js/world.js'), E = await import('/js/entities.js');
  const lv = g.lv, p = g.player;
  // roomy spot for the player
  let best = null;
  for (let c = 0; c < lv.gw * lv.gh; c++) if (lv.startDist[c] >= 0 && lv.clear[c] >= 44 && (!best || lv.clear[c] > lv.clear[best])) best = c;
  p.x = (best % lv.gw + 0.5) * 16; p.y = (((best / lv.gw) | 0) + 0.5) * 16; p.vx = p.vy = 0;
  g.enemies = []; g.pickups = []; g.pings = [];
  const place = (type, r, a0) => {
    for (let i = 0; i < 400; i++) {
      const a = a0 + i * 0.37, rr = r + (i % 5) * 12;
      const x = p.x + Math.cos(a) * rr, y = p.y + Math.sin(a) * rr;
      if (W.sdfAt(lv, x, y) < 30 || !W.lineClear(lv, p.x, p.y, x, y, 10)) continue;
      const e = E.makeEnemy(type, { x, y, a: Math.atan2(p.y - y, p.x - x) }, g.run.depth);
      g.enemies.push(e); return e;
    }
  };
  const made = { eel: !!place('eel', 130, 0.2), lev: !!place('leviathan', 220, 2.4), jelly: !!place('jelly', 90, 4.0), angler: !!place('angler', 120, 5.2), urchin: !!place('urchin', 150, 3.0) };
  g.lv.currents = [];
  f.step(120, false);                    // let them move so the bodies unfold
  g.energy = 100; p.energy = 100;
  g.firePing(1.0);
  f.step(40, true);
  return { made, n: g.enemies.length, states: g.enemies.map((e) => e.type + ':' + e.state) };
});
console.log(info);
await page.screenshot({ path: out('ai-creatures.png') });
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => { const f = window.__fathom; f.game.player.energy = 100; f.game.firePing(0.9); f.step(25, true); });
  await sleep(50);
}
await page.screenshot({ path: out('ai-creatures2.png') });
console.log('errors', h.errors);
await h.close();
