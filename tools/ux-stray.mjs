// Does holding SPACE (OS auto-repeat) through the death animation restart the dive when "Dive again" pops up focused?
import { launch, sleep } from './harness.mjs';
const h = await launch({});
const { page } = h;
await page.goto(h.url + '/index.html?noaudio=1', { waitUntil: 'load' });
await sleep(800);
await page.evaluate(() => { const r = window.__fathom.renderer; r.frame = function () {}; });
for (const guard of [true, false]) {
  await page.evaluate((guard) => { const f = window.__fathom; if (!guard) f.ui.stray = () => false; f.start('stray1', 1); }, guard);
  await sleep(600);
  await page.evaluate(() => { const g = window.__fathom.game; g.player.invul = 0; g.hull = 1; g.player.hull = 1; g.hurt(1, g.player.x + 3, g.player.y); });
  await page.keyboard.down('Space');
  const t0 = Date.now();
  while (Date.now() - t0 < 9000 && (await page.evaluate(() => window.__fathom.game.state)) !== 'gameover') { await page.keyboard.down('Space'); await sleep(40); }
  for (let i = 0; i < 4; i++) { await page.keyboard.down('Space'); await sleep(40); }
  await page.keyboard.up('Space'); await sleep(300);
  console.log('guard', guard, '->', await page.evaluate(() => window.__fathom.game.state), '(gameover = survived the mash, play = stray restart)');
}
await h.close();
