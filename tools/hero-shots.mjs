// Captures README screenshots into docs/.
import { launch, sleep } from './harness.mjs';
import { fileURLToPath } from 'node:url';
const out = (n) => fileURLToPath(new URL('../docs/' + n, import.meta.url));
const h = await launch({ width: 1600, height: 900 });
const { page } = h;
await page.goto(h.url + '/index.html?seed=hero&noaudio=1', { waitUntil: 'load' });
await sleep(6000);
await page.screenshot({ path: out('title.png') });
await page.evaluate(() => { window.__fathom.start('hero-run', 5); window.__fathom.freeze(true); const s = document.createElement('style'); s.textContent = '#banner, #toasts { display: none !important }'; document.head.appendChild(s); });
await page.evaluate(async () => {
  const W = await import('/js/world.js');
  const f = window.__fathom, g = f.game;
  g.god = true;
  const nav = new W.NavField(g.lv); nav.compute(g.lv, 'S', g.lv.exit.x, g.lv.exit.y);
  const d = { x: 0, y: 0 }; let t = 0;
  g.bot = (g) => { const p = g.player; const ok = nav.dir(g.lv, p.x, p.y, d); t += 1 / 60;
    const phase = t % 2.4; return { mx: ok ? d.x * 0.7 : 0, my: ok ? d.y * 0.7 : 0, ping: phase < (Math.floor(t / 2.4) % 2 ? 0.9 : 0.1), dash: false, buoy: false }; };
});
for (let i = 0; i < 9; i++) {
  await page.evaluate((n) => { const f = window.__fathom; for (let k = 0; k < n; k++) f.step(1, false); f.step(0, true); }, 240);
  await page.screenshot({ path: out(`play${i}.png`) });
}
console.log(await page.evaluate(() => ({ s: window.__fathom.game.state, depth: window.__fathom.game.run.depth, ghosts: window.__fathom.game.enemies.filter((e) => window.__fathom.game.time - e.seen < 4).length })));
console.log('errors', h.errors);
await h.close();
