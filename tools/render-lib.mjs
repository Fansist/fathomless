// Shared helpers for the render-lens QA scripts (screenshots + perf).
import puppeteer from 'puppeteer-core';
import { serve, findBrowser, sleep } from './harness.mjs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

export { sleep };
export const outDir = fileURLToPath(new URL('./out/', import.meta.url));
fs.mkdirSync(outDir, { recursive: true });
export const out = (n) => outDir + n;

// like harness.launch() but with a long protocol timeout (software GL frames can take seconds)
export async function launch({ width = 1280, height = 720, dpr = 1, args = [] } = {}) {
  const { srv, url } = await serve();
  const browser = await puppeteer.launch({
    executablePath: findBrowser(), headless: 'new', protocolTimeout: 900000,
    defaultViewport: { width, height, deviceScaleFactor: dpr },
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...args],
  });
  const page = await browser.newPage();
  const errors = [], logs = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
  page.on('console', (m) => { const t = m.type(); if (t === 'error') errors.push('console.error: ' + m.text()); else logs.push(t + ': ' + m.text()); });
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url()));
  const close = async () => { try { await browser.close(); } catch (e) { /* windows profile lock; ignore */ } srv.close(); };
  return { browser, page, errors, logs, url, close };
}

export async function openGame(h, params = 'start=1&seed=r1&depth=1&god=1&noaudio=1', size) {
  const { page } = h;
  if (size) await page.setViewport({ width: size[0], height: size[1], deviceScaleFactor: size[2] || 1 });
  await page.goto(h.url + '/index.html?' + params, { waitUntil: 'load' });
  await sleep(400);
  await page.evaluate(() => window.__fathom.freeze(true));
}

// Build a deterministic gameplay scene inside the page (runs in the browser).
// o: { depth, seed, near:'eel', idx, dist, pos:[x,y], pings:[[power, framesAfter]], settle, charge, danger, flash, snap }
export async function sceneFn(o) {
  const W = await import('/js/world.js');
  const f = window.__fathom, g = f.game;
  g.god = true;
  if (!g.run || o.depth !== g.run.depth || (o.seed && o.seed !== g.run.seed)) { f.start(o.seed || 'r1', 1); g.loadLevel(o.depth || 1); }
  g.bot = () => ({ mx: 0, my: 0, ping: false });
  const lv = g.lv, P = g.player;
  if (o.near) {
    const e = g.enemies.filter((x) => x.type === o.near)[o.idx || 0];
    if (e) {
      let done = false;
      for (let d = o.dist || 150; d > 40 && !done; d -= 15) {
        for (let a = 0; a < 72 && !done; a++) {
          const ang = (a / 72) * Math.PI * 2;
          const x = e.x + Math.cos(ang) * d, y = e.y + Math.sin(ang) * d;
          if (W.sdfAt(lv, x, y) > 20 && W.lineClear(lv, x, y, e.x, e.y, 4)) { P.x = x; P.y = y; P.angle = ang + Math.PI; done = true; }
        }
      }
    }
  }
  if (o.pos) { P.x = o.pos[0]; P.y = o.pos[1]; }
  P.vx = 0; P.vy = 0; P.invul = 0; P.dead = false;
  g.cam.x = P.x; g.cam.y = P.y; g.cam.zoom = 1;
  g.pings = []; g.particles = [];
  if (o.snap) for (const e of g.enemies) e.snapshot(g.time);
  for (const [pw, fr] of (o.pings || [])) { g.firePing(pw); for (let i = 0; i < fr; i++) g.update(1 / 60); }
  for (let i = 0; i < (o.settle || 0); i++) g.update(1 / 60);
  if (o.charge) { P.charging = true; P.charge = o.charge; g.cam.zoom = 1 - 0.06 * o.charge; }
  if (o.danger) g.danger = o.danger;
  if (o.flash) g.flash = o.flash;
  f.renderer.frame();
  f.ui.updateHud(g);
  return { depth: g.run.depth, biome: lv.biome.name, enemies: g.enemies.map((e) => e.type).join(','), pos: [P.x | 0, P.y | 0] };
}
