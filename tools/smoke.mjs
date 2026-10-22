import { launch, sleep } from './harness.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
fs.mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
const out = (n) => fileURLToPath(new URL('./out/' + n, import.meta.url));

const h = await launch({});
const { page } = h;
await page.goto(h.url + '/index.html', { waitUntil: 'load' });
await sleep(2500);
await page.screenshot({ path: out('01-title.png') });
console.log('title state', await page.evaluate(() => window.__fathom.game.state));

await page.click('#btnDive');
await sleep(1500);
await page.screenshot({ path: out('02-play-start.png') });
console.log('state', await page.evaluate(() => window.__fathom.game.state));

// charge a ping
await page.keyboard.down('Space'); await sleep(900); await page.keyboard.up('Space');
await sleep(500);
await page.screenshot({ path: out('03-ping-early.png') });
await sleep(700);
await page.screenshot({ path: out('04-ping-late.png') });

// swim right for a bit
await page.keyboard.down('KeyD'); await sleep(1500); await page.keyboard.up('KeyD');
await page.keyboard.down('Space'); await sleep(300); await page.keyboard.up('Space');
await sleep(900);
await page.screenshot({ path: out('05-swim.png') });

const info = await page.evaluate(() => {
  const g = window.__fathom.game;
  return { state: g.state, depth: g.run.depth, hull: g.player.hull, energy: g.player.energy, pings: g.run.pings, enemies: g.enemies.length, flora: g.lv.flora.length, pos: [g.player.x | 0, g.player.y | 0], reach: g.lv.reach, route: g.lv.routeLength };
});
console.log(info);
// fps estimate
const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); function f() { n++; if (performance.now() - t0 > 2000) res(n / 2); else requestAnimationFrame(f); } requestAnimationFrame(f); }));
console.log('fps ~', fps);
console.log('errors:', h.errors.length ? h.errors : 'none');
console.log(h.logs.slice(0, 10));
await h.close();
