// Visual QA screenshot sets for the render lens.
//   node tools/render-qa.mjs <set[,set...]> [WxH[xDPR]] [tag]
// sets: title | play | biomes | ui | trans | all
// Screens land in tools/out/qa-<set>-<name>-<WxH>[tag].png ; console errors are listed at the end.
import { launch, sleep, openGame, sceneFn, out } from './render-lib.mjs';
const sets = (process.argv[2] || 'all').split(',');
const sz = (process.argv[3] || '1280x720').split('x').map(Number);
const tag = process.argv[4] || '';
const want = (s) => sets.includes('all') || sets.includes(s);
const h = await launch({ width: sz[0], height: sz[1], dpr: sz[2] || 1 });
const { page } = h;
const sizeTag = `${sz[0]}x${sz[1]}${sz[2] && sz[2] > 1 ? '@' + sz[2] : ''}`;
const shot = async (set, name) => { await page.screenshot({ path: out(`qa-${set}-${name}-${sizeTag}${tag}.png`) }); console.log('shot', set, name); };
const scene = (o) => page.evaluate(sceneFn, o);
const finishAnims = () => page.evaluate(() => document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) { /* infinite */ } }));
const ev = (fn, ...a) => page.evaluate(fn, ...a);

if (want('title')) {
  await page.setViewport({ width: sz[0], height: sz[1], deviceScaleFactor: sz[2] || 1 });
  for (const seed of ['t1', 't2']) {
    await page.goto(h.url + '/index.html?seed=' + seed + '&noaudio=1', { waitUntil: 'load' });
    await sleep(500);
    await ev(() => window.__fathom.freeze(true));
    await ev(() => { const f = window.__fathom; for (let i = 0; i < 540; i++) f.game.update(1 / 60); f.renderer.frame(); });
    await finishAnims(); await sleep(250);
    await shot('title', seed);
  }
}

if (want('play')) {
  await page.goto(h.url + '/index.html?start=1&seed=r1&depth=1&god=1&noaudio=1', { waitUntil: 'load' });
  await sleep(700);
  await ev(() => window.__fathom.freeze(true));
  // banner + toasts overlap check
  await ev(() => { const u = window.__fathom.ui; u.toast('Hold SPACE to charge a sonar ping. Release to sing into the dark.', 9000); u.toast('Orange echoes are creatures. Drift slowly to stay silent.', 9000); u.toast('Louder pings travel farther, and wake the hunters. Tap for a quiet one.', 9000); });
  await scene({ depth: 1, seed: 'r1', pings: [[0.7, 30]] });
  await sleep(1200); await shot('play', 'd1-banner-toasts');
  await ev(() => document.querySelectorAll('.toast').forEach((n) => n.remove()));
  await page.evaluate(() => { document.getElementById('banner').classList.remove('go'); });
  await scene({ depth: 1, seed: 'r1', pings: [[0.5, 100], [1, 25]], snap: true }); await sleep(200); await shot('play', 'd1-ping');
  await scene({ depth: 1, seed: 'r1', pings: [[0.4, 80]], charge: 0.65 }); await sleep(200); await shot('play', 'd1-charge');
  await ev(() => { const g = window.__fathom.game; g.player.buoys = 3; g.placeBuoy(); for (let i = 0; i < 70; i++) g.update(1 / 60); window.__fathom.renderer.frame(); });
  await sleep(200); await shot('play', 'd1-decoy');
  await scene({ depth: 4, seed: 'r1', near: 'eel', dist: 120, pings: [[1, 14]], danger: 0.9, flash: 0.8 }); await sleep(200); await shot('play', 'd4-danger-flash');
  await scene({ depth: 7, seed: 'r1', pings: [[0.8, 60]] }); await ev(() => { const g = window.__fathom.game; const f = window.__fathom; f.renderer.frame(); }); await sleep(200); await shot('play', 'd7-currents');
}

if (want('biomes')) {
  await openGame(h, undefined, sz);
  await ev(() => document.getElementById('banner').classList.remove('go'));
  const plan = [[1, 'jelly'], [4, 'eel'], [7, 'angler'], [10, 'eel'], [12, 'leviathan']];
  for (const [depth, near] of plan) {
    const info = await scene({ depth, seed: 'r1', near, dist: 190, pings: [[0.6, 40], [1, 22]] });
    await ev(() => document.getElementById('banner').classList.remove('go'));
    console.log(depth, JSON.stringify(info));
    await sleep(150); await shot('biomes', `d${depth}`);
  }
}

if (want('ui')) {
  await page.goto(h.url + '/index.html?seed=u1&noaudio=1', { waitUntil: 'load' });
  await sleep(500);
  await ev(() => window.__fathom.freeze(true));
  await ev(() => { const f = window.__fathom; for (let i = 0; i < 300; i++) f.game.update(1 / 60); f.renderer.frame(); });
  await page.click('#btnHow'); await finishAnims(); await sleep(400); await shot('ui', 'howto');
  await page.click('#howto [data-close]'); await sleep(200);
  await page.click('#btnSettings'); await finishAnims(); await sleep(400); await shot('ui', 'settings');
  await page.click('#settings [data-close]'); await sleep(200);
  await page.click('#btnDive'); await sleep(600);
  await ev(() => { const f = window.__fathom; f.freeze(true); const g = f.game; g.loadLevel(4); for (let i = 0; i < 40; i++) f.step(1, false); g.firePing(0.8); for (let i = 0; i < 30; i++) f.step(1, false); f.step(1, true); g.pause(); f.step(1); });
  await finishAnims(); await sleep(400); await shot('ui', 'pause');
  await ev(() => { window.__fathom.game.resume(); });
  await ev(() => { const f = window.__fathom, g = f.game; g.completeLevel(); for (let i = 0; i < 130; i++) f.step(1, false); f.step(1, true); });
  await finishAnims(); await sleep(500); await shot('ui', 'upgrade');
  await page.keyboard.press('Digit2'); await sleep(300);
  await ev(() => { const f = window.__fathom, g = f.game; g.god = false; g.player.invul = 0; g.hurt(5, g.player.x, g.player.y); for (let i = 0; i < 220; i++) f.step(1, false); f.step(1, true); });
  await finishAnims(); await sleep(500); await shot('ui', 'gameover');
  await page.click('#endBtns .btn.primary'); await sleep(500);
  await ev(() => { const f = window.__fathom, g = f.game; g.god = true; g.loadLevel(12); g.completeLevel(); for (let i = 0; i < 130; i++) f.step(1, false); f.step(1, true); });
  await finishAnims(); await sleep(500); await shot('ui', 'victory');
}

if (want('trans')) {
  await openGame(h, 'start=1&seed=r1&depth=1&god=1&noaudio=1', sz);
  await ev(() => document.getElementById('banner').classList.remove('go'));
  await scene({ depth: 4, seed: 'r1', pings: [[0.6, 60]] });
  // level end: walk the player next to the gate then complete
  await ev(() => { const f = window.__fathom, g = f.game; const ex = g.exitObj; g.player.x = ex.x - 40; g.player.y = ex.y; g.cam.x = ex.x; g.cam.y = ex.y; g.pings = []; g.completeLevel(); });
  for (const n of [20, 40, 40]) { await ev((n) => { const f = window.__fathom; for (let i = 0; i < n; i++) f.step(1, false); f.step(1, true); }, n); await sleep(150); await shot('trans', 'levelend-' + (await ev(() => (window.__fathom.game.stateT * 100) | 0))); }
  await scene({ depth: 7, seed: 'r1', near: 'eel', dist: 100, pings: [[0.6, 40]] });
  await ev(() => { const f = window.__fathom, g = f.game; g.god = false; g.hurt(9, g.player.x + 20, g.player.y); });
  for (const n of [30, 50, 50]) { await ev((n) => { const f = window.__fathom; for (let i = 0; i < n; i++) f.step(1, false); f.step(1, true); }, n); await sleep(150); await shot('trans', 'dying-' + (await ev(() => (window.__fathom.game.stateT * 100) | 0))); }
}
if (want('detail')) {
  // native-resolution crops (DPR 2) around the craft: wall style, hatching, ghosts
  await openGame(h, undefined, [sz[0], sz[1], 2]);
  await ev(() => document.getElementById('banner').classList.remove('go'));
  for (const [depth, near] of [[1, 'jelly'], [7, 'angler'], [10, 'eel'], [12, 'leviathan']]) {
    await scene({ depth, seed: 'r1', near, dist: 130, pings: [[0.6, 40], [1, 20]] });
    await ev(() => document.getElementById('banner').classList.remove('go'));
    await sleep(150);
    await page.screenshot({ path: out(`qa-detail-d${depth}-${sizeTag}${tag}.png`), clip: { x: sz[0] / 2 - 320, y: sz[1] / 2 - 180, width: 640, height: 360 } });
    console.log('shot detail', depth);
  }
}
console.log('errors', JSON.stringify(h.errors));
await h.close();
