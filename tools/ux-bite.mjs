// How long is the real escape window after an eel bite? Compares the build as-is with the proposed entities.js patch
// (Eel.update ignores the 62 px proximity trigger while `this.calm > 0`, emulated here by masking player.dead during that call).
import { launch, sleep } from './harness.mjs';
const h = await launch({});
const { page } = h;
await page.goto(h.url + '/index.html?noaudio=1', { waitUntil: 'load' });
await sleep(500);
await page.evaluate(async () => {
  const f = window.__fathom; f.freeze(true); f.renderer.frame = function () {};
  window.E = await import('/js/entities.js'); window.W = await import('/js/world.js');
  window.origEelUpdate = window.E.Eel.prototype.update;
});
for (const patched of [false, true]) {
  for (const mode of ['still', 'flee']) {
    const r = await page.evaluate((mode, patched) => {
      const f = window.__fathom, g = f.game;
      window.E.Eel.prototype.update = patched ? function (gg, dt) {
        if (this.calm > 0) { const p = gg.player, d = p.dead; p.dead = true; window.origEelUpdate.call(this, gg, dt); p.dead = d; } else window.origEelUpdate.call(this, gg, dt);
      } : window.origEelUpdate;
      f.start('bite-' + mode, 6);
      g.enemies.length = 0; g.pickups.length = 0;
      const p = g.player; p.invul = 0; p.hull = 3;
      let ang = 0, best = 0;
      for (let a = 0; a < 6.28; a += 0.2) { const d = window.W.rayMarch(g.lv, p.x, p.y, Math.cos(a), Math.sin(a), 400); if (d > best) { best = d; ang = a; } }
      const eel = window.E.makeEnemy('eel', { x: p.x + Math.cos(ang) * Math.min(150, best - 40), y: p.y + Math.sin(ang) * Math.min(150, best - 40) }, 6);
      eel.state = 'chase'; eel.alert = 30; g.enemies.push(eel);
      let biteAt = -1, rebite = -1, chaseAgain = -1;
      // flee along the most open direction that is not towards the eel
      let open = ang + Math.PI;
      { let bb = 0; for (let a = 0; a < 6.28; a += 0.2) { const d = window.W.rayMarch(g.lv, p.x, p.y, Math.cos(a), Math.sin(a), 600); if (d > bb && Math.abs(Math.atan2(Math.sin(a - ang), Math.cos(a - ang))) > 1.2) { bb = d; open = a; } } }
      g.bot = () => ({ mx: mode === 'flee' && biteAt >= 0 ? Math.cos(open) : 0, my: mode === 'flee' && biteAt >= 0 ? Math.sin(open) : 0, ping: false });
      for (let i = 0; i < 60 * 10 && g.state === 'play'; i++) {
        const h0 = p.hull; g.update(1 / 60);
        if (p.hull < h0) { if (biteAt < 0) biteAt = i; else if (rebite < 0) rebite = i; }
        if (biteAt >= 0 && chaseAgain < 0 && eel.state === 'chase' && i > biteAt + 3) chaseAgain = i;
      }
      return { mode, patched, biteAt, secondBiteAfterS: rebite < 0 ? null : +((rebite - biteAt) / 60).toFixed(1), chaseAgainAfterS: chaseAgain < 0 ? null : +((chaseAgain - biteAt) / 60).toFixed(1), hull: p.hull, state: g.state };
    }, mode, patched);
    console.log(JSON.stringify(r));
  }
}
await h.close();
