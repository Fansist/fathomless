// UX end-to-end flow test: REAL keyboard / mouse events (puppeteer page.keyboard / page.mouse) in a normal,
// non-frozen, real-time page. To keep the loop near 60 fps in software-rendered headless Chrome the canvas draw is
// skipped (renderer.frame no-op) unless RENDER=1; screenshots temporarily re-enable it.
// Usage: node tools/ux-flows.mjs     (exit code 1 when any check fails)
import { launch, sleep } from './harness.mjs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
fs.mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
const shot = (n) => fileURLToPath(new URL('./out/ux-' + n + '.png', import.meta.url));
const RENDER = !!process.env.RENDER;

const h = await launch({ width: 1280, height: 720 });
const { page } = h;
const ev = (fn, ...a) => page.evaluate(fn, ...a);
let fails = 0, total = 0;
const check = (name, ok, info) => {
  total++;
  if (!ok) { fails++; console.log('  FAIL  ' + name + (info !== undefined ? '  -> ' + JSON.stringify(info) : '')); }
  else console.log('  ok    ' + name);
};
const frames = (n = 4) => ev((n) => new Promise((r) => { let i = 0; (function f() { if (++i >= n) r(); else requestAnimationFrame(f); })(); }), n);
const until = async (fn, ms = 8000, ...a) => {
  ms *= RENDER ? 4 : 1;   // with real drawing headless Chrome manages ~4 fps, so game-time waits take ~4x longer
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await page.evaluate(fn, ...a)) return true; await sleep(50); }
  return false;
};
const snap = () => ev(() => {
  const f = window.__fathom, g = f.game, ui = f.ui;
  const vis = (id) => { const el = document.getElementById(id); if (!el) return false; const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && !el.classList.contains('hidden'); };
  const a = document.activeElement;
  const p = g.player;
  return {
    state: g.state, mode: ui.mode,
    layers: ['title', 'upgrade', 'end', 'pause', 'settings', 'howto'].filter(vis),
    hud: vis('hud'), toasts: document.querySelectorAll('#toasts .toast').length,
    active: a && a !== document.body ? (a.id || a.tagName + '.' + a.className) : 'body',
    depth: g.run && g.run.depth, run: !!g.run,
    pings: g.run ? g.run.pings : -1, dashes: g.run ? g.run.dashes : -1, buoysUsed: g.run ? g.run.buoysUsed : -1,
    hull: p.hull, energy: +p.energy.toFixed(1), buoys: p.buoys, charging: p.charging, x: +p.x.toFixed(1), y: +p.y.toFixed(1),
    muted: f.audio.muted, score: g.run ? g.run.score : 0, ups: g.run ? JSON.stringify(g.run.ups) : '',
  };
});
const MODE = { title: 'title', play: 'play', paused: 'paused', dying: 'dying', levelend: 'levelend', upgrade: 'upgrade', gameover: 'gameover', victory: 'victory' };
const LAYERS = { title: ['title'], play: [], paused: ['pause'], dying: [], levelend: [], upgrade: ['upgrade'], gameover: ['end'], victory: ['end'] };
const HUD = { title: false, play: true, paused: true, dying: true, levelend: true, upgrade: false, gameover: false, victory: false };
// exactly the right primary layer(s) are visible for the state, and ui.mode agrees with game.state
const consistent = async (label, extraLayers = null) => {
  await frames(4);
  const s = await snap();
  const want = extraLayers || LAYERS[s.state];
  const ok = s.mode === MODE[s.state] && JSON.stringify(s.layers.slice().sort()) === JSON.stringify(want.slice().sort()) && s.hud === HUD[s.state];
  check(label + ' [state ' + s.state + ': layers ' + s.layers.join('+') + ' hud ' + s.hud + ']', ok, ok ? undefined : { s, want });
  return s;
};
const center = (sel) => ev((q) => { const r = document.querySelector(q).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);
const clickSel = async (sel) => { const [x, y] = await center(sel); await page.mouse.move(x, y); await page.mouse.down(); await sleep(40); await page.mouse.up(); await frames(4); };
const press = async (k, hold = 90) => { await page.keyboard.down(k); await sleep(hold); await page.keyboard.up(k); await frames(4); };
const screenshot = async (name) => {
  if (!RENDER) await ev(() => { const r = window.__fathom.renderer; if (window.__origFrame) r.frame = window.__origFrame; });
  await frames(6);
  await page.screenshot({ path: shot(name) });
  if (!RENDER) await ev(() => { window.__fathom.renderer.frame = function () {}; });
};

console.log('== 1. boot & title');
await page.goto(h.url + '/index.html', { waitUntil: 'load' });
check('game booted', await until(() => !!(window.__fathom && window.__fathom.game), 15000));
if (!RENDER) await ev(() => { const r = window.__fathom.renderer; window.__origFrame = r.frame; r.frame = function () {}; });
await frames(10);
let s = await consistent('title layers');
check('title: no run', !s.run);
check('title: demo level exists', await ev(() => !!window.__fathom.game.lv && window.__fathom.game.enemies.length > 0));
await screenshot('01-title');

console.log('== 2. modals from title');
await clickSel('#btnHow'); s = await snap();
check('howto modal opens over title', s.layers.includes('howto') && !s.layers.includes('settings'), s.layers);
await press('Escape'); s = await snap();
check('Esc closes howto', !s.layers.includes('howto') && s.layers.includes('title'), s.layers);
await press('Space'); s = await snap();
check('Space after a mouse-clicked button does not re-trigger it (focus was released)', !s.layers.includes('howto') && s.state === 'title', { layers: s.layers, state: s.state });
await clickSel('#btnSettings'); s = await snap();
check('settings modal opens', s.layers.includes('settings'), s.layers);
const before = await ev(() => window.__fathom.settings.hints);
await clickSel('#setHints');
const after = await ev(() => window.__fathom.settings.hints);
check('settings checkbox toggles value', before !== after, { before, after });
await clickSel('#setHints');
await screenshot('02-settings');
await clickSel('#settings [data-close]'); s = await snap();
check('Done closes settings', !s.layers.includes('settings'), s.layers);
await press('Tab'); s = await snap();
check('Tab moves focus onto a menu button on title (keyboard reachable)', s.active !== 'body', s.active);
// Enter on the focused button activates it; make sure focus stays inside the visible layer when a modal is up
await clickSel('#btnHow');
for (let i = 0; i < 8; i++) await press('Tab', 30);
s = await snap();
check('Tab inside a modal stays inside the modal (focus trap)', await ev(() => !!document.activeElement.closest('#howto')), s.active);
await press('Escape');
await ev(() => document.activeElement && document.activeElement.blur());

console.log('== 3. dive with a real click (double-click safe)');
const [bx, by] = await center('#btnDive');
await page.mouse.move(bx, by); await page.mouse.down(); await sleep(30); await page.mouse.up();
await sleep(70); await page.mouse.down(); await sleep(30); await page.mouse.up();   // second click of a double click
await until(() => window.__fathom.game.state === 'play', 4000);
s = await consistent('after Dive');
check('run depth 1', s.depth === 1, s);
await sleep(1500);
s = await snap();
check('double-click on Dive fired no stray ping', s.pings === 0 && !s.charging, { pings: s.pings, charging: s.charging });
await screenshot('03-play');

console.log('== 4. swimming (WASD + arrows)');
let a = await snap();
await page.keyboard.down('KeyD'); await sleep(900); await page.keyboard.up('KeyD'); await frames(3);
let b = await snap();
const moved = Math.hypot(b.x - a.x, b.y - a.y);
check('hold D moves the sub', moved > 15, { moved: +moved.toFixed(1) });
a = b;
await page.keyboard.down('ArrowLeft'); await sleep(900); await page.keyboard.up('ArrowLeft'); await frames(3);
b = await snap();
check('hold ArrowLeft moves the sub (and does not scroll/focus anything)', Math.hypot(b.x - a.x, b.y - a.y) > 15, { dx: b.x - a.x });
await ev(() => { const g = window.__fathom.game; g.player.x = g.lv.start.x; g.player.y = g.lv.start.y; g.player.vx = g.player.vy = 0; });

console.log('== 5. ping with SPACE (hold = charge, release = fire)');
await sleep(500);
a = await snap();
await page.keyboard.down('Space'); await sleep(700); s = await snap();
check('charging while SPACE held', s.charging === true, s.charging);
await page.keyboard.up('Space'); await frames(5); b = await snap();
check('release fires exactly one ping', b.pings === a.pings + 1 && !b.charging, { before: a.pings, after: b.pings });
check('ping spent energy', b.energy < a.energy - 8 || a.energy < 12, { a: a.energy, b: b.energy });
// a very quick tap (shorter than one frame at low fps) must still produce a whisper ping
await sleep(900);
a = await snap();
await page.keyboard.down('Space'); await page.keyboard.up('Space'); await frames(6); b = await snap();
check('instant Space tap still fires a (whisper) ping', b.pings === a.pings + 1, { before: a.pings, after: b.pings });

console.log('== 6. ping with the mouse button (hold)');
await sleep(1500);
a = await snap();
await page.mouse.move(640, 360); await page.mouse.down(); await sleep(500); s = await snap();
check('charging while mouse held', s.charging === true);
await page.mouse.up(); await frames(5); b = await snap();
check('mouse release fires one ping', b.pings === a.pings + 1, { before: a.pings, after: b.pings });

console.log('== 7. dash (SHIFT), decoy (E + right click)');
await sleep(1500);
a = await snap();
await press('ShiftLeft'); b = await snap();
check('SHIFT dashes once', b.dashes === a.dashes + 1, { before: a.dashes, after: b.dashes });
a = b;
await page.keyboard.down('KeyE'); await sleep(60); await page.keyboard.down('KeyE'); await sleep(60); await page.keyboard.down('KeyE'); await sleep(60); await page.keyboard.up('KeyE'); await frames(5); b = await snap();
check('E (with key repeat) drops exactly one decoy', b.buoysUsed === a.buoysUsed + 1 && b.buoys === a.buoys - 1, { a: a.buoys, b: b.buoys });
a = b;
await page.mouse.click(640, 360, { button: 'right' }); await frames(5); b = await snap();
check('right click drops one decoy', b.buoysUsed === a.buoysUsed + 1 || a.buoys === 0, { a: a.buoys, b: b.buoys });
check('right click did not ping / pause', b.pings === a.pings && b.state === 'play', b);

console.log('== 8. pause with Esc and P, settings from pause, resume');
await press('Escape');
s = await consistent('Esc pauses');
check('pause focus on Resume', s.active === 'btnResume', s.active);
await press('Escape');
s = await consistent('Esc resumes');
await press('KeyP');
s = await consistent('P pauses');
await clickSel('#btnPauseSettings'); s = await consistent('settings from pause', ['settings']);
await press('Escape');
s = await consistent('Esc leaves settings back to pause menu', ['pause']);
check('still paused', s.state === 'paused');
await clickSel('#btnPauseHow'); s = await consistent('howto from pause', ['howto']);
await clickSel('#howto [data-close]'); s = await consistent('howto closed -> pause menu', ['pause']);
await clickSel('#btnResume');
s = await consistent('Resume button resumes');
a = await snap();
await sleep(700); b = await snap();
check('no stray ping after clicking Resume with the mouse', b.pings === a.pings && !b.charging, { a: a.pings, b: b.pings });
// Esc / P spam
for (let i = 0; i < 9; i++) { await page.keyboard.press(i % 2 ? 'KeyP' : 'Escape'); await sleep(25); }
await frames(6);
s = await snap();
check('Esc/P spam leaves a coherent state', (s.state === 'play' && s.layers.length === 0) || (s.state === 'paused' && s.layers.join() === 'pause'), s);
if (s.state === 'paused') await press('Escape');
// pause while holding SPACE: the charge is cancelled; after resume no ping until the key is released and pressed again
await sleep(800);
await page.keyboard.down('Space'); await sleep(400);
await page.keyboard.press('Escape'); await frames(5);
s = await snap(); check('paused while charging cancels the charge', s.state === 'paused' && !s.charging, s);
await page.keyboard.up('Space'); await frames(3);
a = await snap();
await page.keyboard.press('Escape'); await frames(5);
s = await snap();
check('Space released while paused + resumed: no stray ping', s.state === 'play' && s.pings === a.pings && !s.charging, s);
// Space still held while resuming: must not fire/charge until released
await sleep(500);
await page.keyboard.down('Space'); await frames(2);
await page.keyboard.press('Escape'); await frames(4);
await page.keyboard.press('Escape'); await frames(4);
s = await snap();
check('resume with SPACE still held does not auto-charge', s.state === 'play' && !s.charging, s);
await page.keyboard.up('Space'); await frames(4);
s = await snap();
check('...and releasing it fires nothing', s.pings === a.pings, { a: a.pings, now: s.pings });

console.log('== 9. blur / visibility auto-pause, resize, mute, fullscreen, tab');
await ev(() => window.dispatchEvent(new Event('blur'))); await frames(4);
s = await consistent('window blur auto-pauses');
await press('Escape');
await ev(() => { Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }); await frames(4);
s = await consistent('hidden tab auto-pauses');
await ev(() => { Object.defineProperty(document, 'hidden', { get: () => false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
await press('Escape');
await page.setViewport({ width: 900, height: 600 }); await frames(8);
let cw = await ev(() => { const c = document.getElementById('view'); const g = window.__fathom.game; return [c.clientWidth, c.clientHeight, innerWidth, innerHeight, g.view.w, g.view.h]; });
check('resize mid-play updates canvas/view', cw[0] === 900 && cw[1] === 600, cw);
check('game.view (logical units for the camera clamp) keeps the window aspect ratio', Math.abs(cw[4] / cw[5] - cw[2] / cw[3]) < 0.01, cw);
await page.setViewport({ width: 1280, height: 720 }); await frames(8);
a = await snap();
await press('KeyM'); b = await snap();
check('M toggles mute', a.muted !== b.muted, { a: a.muted, b: b.muted });
check('M shows a Sound on/off toast and persists the choice', b.toasts >= 1 && (await ev(() => JSON.parse(localStorage.getItem('fathomless.settings')).muted === window.__fathom.audio.muted)), b.toasts);
await press('KeyM');
await press('KeyF'); await press('KeyF');
await press('Tab'); b = await snap();
check('Tab during play does nothing harmful', b.state === 'play' && b.layers.length === 0, b);
await ev(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
s = await consistent('still playing after M/F/Tab');

console.log('== 10. death and game over');
await ev(() => { const g = window.__fathom.game; g.god = false; });
await sleep(1500);
for (let i = 0; i < 3; i++) {
  await ev(() => { const g = window.__fathom.game; g.player.invul = 0; const p = g.player; g.hurt(1, p.x + 4, p.y); });
  await frames(6);
}
s = await snap();
check('3 hits kills (3 hull pips)', s.state === 'dying' || s.state === 'gameover', s.state);
await consistent('dying layers');
await page.keyboard.press('Escape'); await page.keyboard.press('KeyP'); await frames(5);
s = await snap();
check('pause ignored while dying', s.state !== 'paused', s.state);
check('game over screen shows', await until(() => window.__fathom.game.state === 'gameover', 12000));
s = await consistent('gameover layers');
await sleep(200);
s = await snap();
check('"Dive again" focused', s.active !== 'body', s.active);
await screenshot('04-gameover');

console.log('== 11. Dive again');
await clickSel('#endBtns .btn.primary');
s = await consistent('Dive again starts a new run');
check('new run: depth 1 hull 3 buoys 2', s.depth === 1 && s.hull === 3 && s.buoys === 2, s);

console.log('== 12. complete level -> upgrade picker (keys, then mouse)');
await sleep(800);
await ev(() => window.__fathom.game.completeLevel());
await frames(4);
s = await consistent('levelend layers');
await page.keyboard.press('Escape'); await frames(4);
check('pause ignored in levelend', (await snap()).state === 'levelend');
await ev(() => window.__fathom.game.completeLevel());   // double completion must be a no-op
check('upgrade screen appears', await until(() => window.__fathom.game.state === 'upgrade', 20000));
s = await consistent('upgrade layers');
let n = await ev(() => document.querySelectorAll('#cards .card').length);
check('3 upgrade cards', n === 3, n);
await screenshot('05-upgrade');
await page.keyboard.press('Escape'); await frames(3);
check('Esc does nothing in upgrade', (await snap()).state === 'upgrade');
const picked = await ev(() => window.__fathom.game.upgradeChoices.map((u) => u.id));
await sleep(450);
await press('Digit2');
s = await consistent('after key 2');
check('picked option 2 applied, depth 2', s.depth === 2 && JSON.parse(s.ups)[picked[1]] === 1, { s, picked });
check('upgrade DOM cleaned', await ev(() => document.querySelectorAll('#cards .card').length === 0));
await sleep(600);
await ev(() => window.__fathom.game.completeLevel());
check('second upgrade screen', await until(() => window.__fathom.game.state === 'upgrade', 20000));
await sleep(600);
await clickSel('#cards .card:nth-child(3)');
s = await consistent('after mouse pick');
check('mouse pick advanced to depth 3', s.depth === 3, s);

console.log('== 13. quit to title via pause menu; Daily Dive');
await sleep(500);
await press('Escape');
await clickSel('#btnQuit');
s = await consistent('abandon -> title');
await clickSel('#btnDaily');
s = await consistent('Daily Dive starts');
const seed = await ev(() => window.__fathom.game.run.seed);
check('daily seed format', /^daily-\d{4}-\d{2}-\d{2}$/.test(seed), seed);

console.log('== 14. forced victory at depth 12, endless to depth 13');
await ev(() => { const g = window.__fathom.game; g.loadLevel(12); });
await sleep(400);
await ev(() => window.__fathom.game.completeLevel());
check('victory screen after depth 12', await until(() => window.__fathom.game.state === 'victory', 20000));
s = await consistent('victory layers');
await screenshot('06-victory');
await sleep(300);
await clickSel('#endBtns .btn.primary');
s = await consistent('Descend further -> upgrade picker');
await sleep(500);
await press('Digit1');
s = await consistent('endless: playing');
check('depth 13 reached', s.depth === 13, s.depth);
await ev(() => { const g = window.__fathom.game; g.player.invul = 0; g.player.hull = 1; g.hurt(1, g.player.x + 3, g.player.y); });
check('death in endless -> gameover', await until(() => window.__fathom.game.state === 'gameover', 12000));
await sleep(200);
await clickSel('#endBtns .btn:not(.primary)');
s = await consistent('Title button -> title');

console.log('== 15. keyboard-only: Tab/arrows/Enter through the menus');
await press('Tab'); s = await snap();
check('first Tab focuses a title button', s.active !== 'body' && s.layers.join() === 'title', s.active);
await press('ArrowDown'); await press('ArrowDown'); s = await snap();
check('ArrowDown moves focus down the menu', s.active === 'btnHow', s.active);
await press('Enter'); s = await snap();
check('Enter on a focused button activates it (How to Play)', s.layers.includes('howto'), s.layers);
check('modal grabbed the focus', await ev(() => !!document.activeElement.closest('#howto')));
for (let i = 0; i < 6; i++) await press('Tab', 30);
check('Tab inside a modal cycles within the modal (focus trap)', await ev(() => !!document.activeElement.closest('#howto')));
await press('Escape'); s = await snap();
check('Esc closes the modal and focus returns to the opener', !s.layers.includes('howto') && s.active === 'btnHow', s);
await ev(() => document.activeElement && document.activeElement.blur());
await press('Enter');   // nothing focused on the title: Enter dives
s = await consistent('Enter on the bare title starts a dive');
check('Enter-started dive is in play at depth 1', s.state === 'play' && s.depth === 1, s);
await press('Escape'); await press('ArrowDown'); s = await snap();
check('pause menu: arrows move between buttons', s.state === 'paused' && s.active !== 'btnResume', s.active);
await press('Escape');
await consistent('resumed');

console.log('== 16. mashing SPACE through the level-end must not pick an upgrade');
await sleep(500);
await ev(() => window.__fathom.game.completeLevel());
// hold SPACE with auto-repeat the whole way through the 2 s gate animation and into the upgrade screen
await page.keyboard.down('Space');
const t0 = Date.now();
while (Date.now() - t0 < 6000 && (await ev(() => window.__fathom.game.state)) !== 'upgrade') { await page.keyboard.down('Space'); await sleep(40); }
for (let i = 0; i < 6; i++) { await page.keyboard.down('Space'); await sleep(40); }
await page.keyboard.up('Space'); await frames(6);
s = await snap();
check('held SPACE across the upgrade popup picked nothing', s.state === 'upgrade', { state: s.state, depth: s.depth });
await sleep(400);
await press('Digit3');
s = await consistent('explicit pick still works afterwards');
check('...and advanced to depth 2', s.depth === 2, s.depth);

console.log('== 17. slow machine: 230 ms frames, short taps still register');
await ev(() => { const r = window.__fathom.renderer; r.frame = function () { const t = performance.now(); while (performance.now() - t < 230); }; });
await sleep(2500);
a = await snap();
let fired = 0;
for (let i = 0; i < 5; i++) {
  const p0 = (await snap()).pings;
  await page.keyboard.down('Space'); await sleep(20); await page.keyboard.up('Space');
  await sleep(1100);
  if ((await snap()).pings === p0 + 1) fired++;
}
check('slow frames: 5 x 20 ms Space taps all fire a whisper ping', fired === 5, fired);
a = await snap();
await page.keyboard.down('KeyE'); await sleep(20); await page.keyboard.up('KeyE'); await sleep(900); b = await snap();
check('slow frames: 20 ms E tap drops a decoy', b.buoysUsed === a.buoysUsed + 1 || a.buoys === 0, { a: a.buoysUsed, b: b.buoysUsed });

console.log('== 16. errors');
const real = h.errors.filter((e) => !/AudioContext encountered an error from the audio device/.test(e));
check('no page errors / console errors (headless audio-device warning ignored)', real.length === 0, real.slice(0, 5));
console.log(`\n${total - fails}/${total} checks passed`);
await h.close();
process.exit(fails ? 1 : 0);
