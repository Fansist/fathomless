// First 30 seconds as a real player would see them: wall-clock timeline of toasts + screenshots (real keyboard input).
// Usage: node tools/ux-onboarding.mjs   (writes tools/out/ux-ob-*.png)
import { launch, sleep } from './harness.mjs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
fs.mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
const shot = (n) => fileURLToPath(new URL('./out/ux-ob-' + n + '.png', import.meta.url));
let fails = 0, total = 0;
const check = (name, ok, info) => { total++; if (!ok) { fails++; console.log('  FAIL  ' + name + (info !== undefined ? '  -> ' + JSON.stringify(info) : '')); } else console.log('  ok    ' + name); };

const h = await launch({ width: 1280, height: 720 });
const { page } = h;
await page.goto(h.url + '/index.html?noaudio=1&seed=onboard', { waitUntil: 'load' });
await sleep(800);
await page.evaluate(() => {
  const r = window.__fathom.renderer; window.__orig = r.frame; r.frame = function () {};
  window.__tl = []; window.__max = 0;
  const host = document.getElementById('toasts');
  new MutationObserver(() => {
    const els = [...host.querySelectorAll('.toast')];
    window.__max = Math.max(window.__max, els.length);
    for (const el of els) if (!el.__seen) { el.__seen = true; window.__tl.push({ t: +(performance.now() / 1000 - window.__t0).toFixed(1), text: el.textContent }); }
  }).observe(host, { childList: true, subtree: true, characterData: true });
});
// screenshots freeze the sim for a moment (draw one real frame) so they do not distort the game-time hint timeline
const snap = async (name) => {
  await page.evaluate(() => { const f = window.__fathom; f.freeze(true); f.renderer.frame = window.__orig; f.step(0, true); f.step(0, true); });
  await sleep(150);
  await page.screenshot({ path: shot(name) });
  await page.evaluate(() => { const f = window.__fathom; f.renderer.frame = function () {}; f.freeze(false); });
};
await snap('0-title');
await page.click('#btnHow'); await sleep(300); await snap('1-howto'); await page.keyboard.press('Escape'); await sleep(200);
await page.evaluate(() => { window.__t0 = performance.now() / 1000; });
await page.click('#btnDive');
await sleep(2200);
await snap('2-banner-and-intro-hint');
// player pings once at ~3 s, then keeps swimming toward the gate for the rest of the half minute
await sleep(800);
// make sure a creature is in plain view of the first ping so the "orange" hint is exercised
await page.evaluate(async () => {
  const W = await import('/js/world.js'); const g = window.__fathom.game, p = g.player;
  let ang = 0, best = 0; for (let a = 0; a < 6.28; a += 0.2) { const d = W.rayMarch(g.lv, p.x, p.y, Math.cos(a), Math.sin(a), 300); if (d > best) { best = d; ang = a; } }
  const j = g.enemies.find((e) => e.type === 'jelly');
  if (j) { j.x = p.x + Math.cos(ang) * Math.min(130, best - 30); j.y = p.y + Math.sin(ang) * Math.min(130, best - 30); j.vx = j.vy = 0; j.state = 'drift'; }
});
await page.keyboard.down('Space'); await sleep(600); await page.keyboard.up('Space');
await sleep(2200);
await snap('3-after-ping-hint');
await page.keyboard.down('KeyD'); await sleep(2500); await page.keyboard.up('KeyD');
await sleep(2500);
await snap('4-creature-hint');
await sleep(14000);
await snap('5-t30');
const r = await page.evaluate(() => ({ tl: window.__tl, max: window.__max, state: window.__fathom.game.state, pings: window.__fathom.game.run.pings }));
for (const e of r.tl) console.log(`   t+${String(e.t).padStart(4)}s  "${e.text}"`);
const idx = (s) => r.tl.findIndex((x) => x.text.startsWith(s));
check('controls hint shows within the first 3 s', idx('Swim with WASD') === 0 && r.tl[0].t <= 3, r.tl[0]);
check('ping explanation follows right after the first ping', idx('Louder pings') > 0, r.tl.map((x) => x.text.slice(0, 20)));
check('creature (orange) hint follows', idx('Orange echoes') > idx('Louder pings'), r.tl.map((x) => x.text.slice(0, 20)));
check('never more than one hint on screen', r.max <= 1, r.max);
check('whole sequence fits in the first 30 s', r.tl.length >= 3 && r.tl[2].t < 30, r.tl.map((x) => x.t));
check('still playing after 30 s', r.state === 'play', r.state);
check('no page errors', h.errors.filter((e) => !/AudioContext encountered/.test(e)).length === 0, h.errors.slice(0, 3));
console.log(`\n${total - fails}/${total} checks passed`);
await h.close();
process.exit(fails ? 1 : 0);
