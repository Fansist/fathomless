// Resize / DPR stress: canvas must track the window, stay crisp (device-pixel sized) and not leak elements or memory.
import { launch, openGame, sceneFn, sleep, out } from './render-lib.mjs';
const h = await launch({ width: 1280, height: 720 });
const { page } = h;
await openGame(h, 'start=1&seed=r1&depth=4&god=1&noaudio=1', [1280, 720]);
await page.evaluate(sceneFn, { depth: 4, seed: 'r1', pings: [[0.8, 30]] });
const sizes = [[1920, 1080, 1], [1024, 600, 1], [2560, 1080, 1], [1280, 720, 2], [1366, 768, 1], [1024, 768, 1], [2560, 1440, 1], [1280, 720, 1]];
const probe = () => page.evaluate(() => {
  const f = window.__fathom, R = f.renderer, c = R.canvas, g = f.game;
  R.frame();
  const heap = performance.memory ? performance.memory.usedJSHeapSize : 0;
  return {
    inner: [innerWidth, innerHeight, devicePixelRatio], canvas: [c.width, c.height], css: [c.style.width, c.style.height],
    bloom: R.bloom.map((b) => [b.width, b.height]), view: [Math.round(g.view.w), Math.round(g.view.h)], px: +R.px.toFixed(3),
    canvases: document.querySelectorAll('canvas').length, fx: document.querySelectorAll('.fx').length, fxb: document.querySelectorAll('.fxb').length,
    heapMB: +(heap / 1048576).toFixed(1),
  };
});
const rows = [];
for (let loop = 0; loop < 3; loop++) {
  for (const [w, hh, d] of sizes) {
    await page.setViewport({ width: w, height: hh, deviceScaleFactor: d });
    await sleep(120);
    const r = await probe();
    const exp = [Math.round(Math.min(Math.max(320, w), 99999) * Math.min(d, 2, 2560 / w)), 0];
    r.ok = r.canvas[0] === Math.round(w * (w * d > 2560 ? 2560 / w : d)) && r.canvas[1] === Math.round(hh * (w * d > 2560 ? 2560 / w : d));
    rows.push(r);
    if (loop === 0) { await page.screenshot({ path: out(`qa-resize-${w}x${hh}@${d}.png`) }); }
  }
}
console.table(rows.map((r) => ({ inner: r.inner.join('x'), canvas: r.canvas.join('x'), ok: r.ok, bloom1: r.bloom[1].join('x'), view: r.view.join('x'), px: r.px, canv: r.canvases, fx: r.fx, fxb: r.fxb, heapMB: r.heapMB })));
console.log('errors', JSON.stringify(h.errors));
await h.close();
