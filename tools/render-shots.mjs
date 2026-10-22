// Screenshot sets for the render lens.  node tools/render-shots.mjs <set> [WxH[xDPR]] [tag]
import { launch, sleep, openGame, sceneFn, out } from './render-lib.mjs';
const set = process.argv[2] || 'biomes';
const sz = (process.argv[3] || '1280x720').split('x').map(Number);
const tag = process.argv[4] || '';
const h = await launch({ width: sz[0], height: sz[1] });
const { page } = h;
const shot = async (name) => { await page.screenshot({ path: out(`${name}${tag}.png`) }); console.log('shot', name); };
const scene = (o) => page.evaluate(sceneFn, o);

if (set === 'biomes') {
  await openGame(h, undefined, sz);
  const plan = [
    [1, 'jelly', 'r1'], [4, 'eel', 'r1'], [7, 'angler', 'r1'], [10, 'eel', 'r1'], [12, 'leviathan', 'r1'],
  ];
  for (const [depth, near, seed] of plan) {
    // earlier ping to build memory, then a close loud ping
    const info = await scene({ depth, seed, near, dist: 190, snap: false, pings: [[0.6, 40], [1, 22]] });
    console.log(depth, JSON.stringify(info));
    await shot(`biome-d${depth}-${sz[0]}x${sz[1]}`);
  }
}
if (set === 'details') {
  await openGame(h, undefined, sz);
  // charging ring + preview
  await scene({ depth: 4, seed: 'r1', pings: [[0.5, 70]], charge: 0.7 }); await shot('charge');
  // danger + flash
  await scene({ depth: 7, seed: 'r1', near: 'eel', dist: 120, pings: [[1, 14]], danger: 0.9, flash: 0.8 }); await shot('danger');
  // decoy
  await page.evaluate(() => { const g = window.__fathom.game; g.player.buoys = 3; g.buoys.push({ x: g.player.x + 60, y: g.player.y - 20, life: 6, beep: 0.5, seen: g.time, phase: 0, type: 'buoy' }); for (let i = 0; i < 30; i++) g.update(1 / 60); window.__fathom.renderer.frame(); });
  await shot('decoy');
}
if (set === 'title') {
  await page.setViewport({ width: sz[0], height: sz[1], deviceScaleFactor: sz[2] || 1 });
  await page.goto(h.url + '/index.html?seed=t1', { waitUntil: 'load' });
  await sleep(500);
  await page.evaluate(() => window.__fathom.freeze(true));
  for (let k = 0; k < 3; k++) {
    await page.evaluate(() => { const f = window.__fathom; for (let i = 0; i < 420; i++) f.game.update(1 / 60); f.renderer.frame(); });
    await sleep(k === 0 ? 3600 : 100);
    await shot(`title-${k}`);
  }
}
console.log('errors', h.errors);
await h.close();
