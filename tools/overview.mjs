import { launch, sleep } from './harness.mjs';
import { fileURLToPath } from 'node:url';
const out = (n) => fileURLToPath(new URL('./out/' + n, import.meta.url));
const depths = (process.argv[2] || '1,5,9,12').split(',').map(Number);
const seed = process.argv[3] || 'overview';
const h = await launch({ width: 1600, height: 1000 });
const { page } = h;
await page.goto(h.url + `/index.html?start=1&seed=${seed}&noaudio=1&god=1`, { waitUntil: 'load' });
await sleep(500);
for (const d of depths) {
  const info = await page.evaluate((d) => {
    const f = window.__fathom, g = f.game;
    f.freeze(true);
    g.loadLevel(d);
    g.bot = () => ({ mx: 0, my: 0, ping: false });
    f.renderer.revealAll();
    const lv = g.lv;
    g.cam.zoom = Math.min(1600 / lv.width, 1000 / lv.height) * 0.97 / (f.renderer.px / (window.devicePixelRatio || 1)) * (1280 / 1600 > 720 / 1000 ? 1 : 1);
    g.cam.x = lv.width / 2; g.cam.y = lv.height / 2;
    // fire pings around so entities show up
    for (const e of g.enemies) e.snapshot(g.time);
    g.pings = [];
    f.renderer.frame();
    return { w: lv.width, h: lv.height, zoom: g.cam.zoom, enemies: g.enemies.map((e) => e.type).reduce((a, t) => (a[t] = (a[t] || 0) + 1, a), {}), pearls: g.pickups.filter((p) => p.type === 'pearl').length, route: lv.routeLength, reach: lv.reach, flora: lv.flora.length, currents: lv.currents.length };
  }, d);
  console.log(d, JSON.stringify(info));
  await page.screenshot({ path: out(`overview-d${d}.png`) });
}
console.log('errors', h.errors);
await h.close();
