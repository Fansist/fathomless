// Boot, main loop and global key handling.
import { Input } from './input.js';
import { AudioEngine } from './audio.js';
import { Game } from './game.js';
import { Renderer } from './render.js';
import { UI } from './ui.js';
import { load, save } from './storage.js';

const q = new URLSearchParams(location.search);
const DEFAULTS = { master: 0.8, music: 0.7, shake: true, reduceFlash: false, hints: true, bloom: true, muted: false };
const settings = Object.assign({}, DEFAULTS, load('settings', {}));
// hand-edited / corrupted settings must never reach the audio graph or the UI as NaN / strings
for (const k of ['master', 'music']) settings[k] = Number.isFinite(settings[k]) ? Math.min(1, Math.max(0, settings[k])) : DEFAULTS[k];
for (const k of ['shake', 'reduceFlash', 'hints', 'bloom', 'muted']) if (typeof settings[k] !== 'boolean') settings[k] = DEFAULTS[k];
if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches && load('settings', null) === null) {
  settings.shake = false; settings.reduceFlash = true;
}

const canvas = document.getElementById('view');
const audio = new AudioEngine();
audio.volume = settings.master; audio.musicVol = settings.music;
if (q.has('mute') || settings.muted) audio.muted = true;
const input = new Input(canvas);

let game, renderer;
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  if (!q.has('noaudio')) audio.init();
}
window.addEventListener('pointerdown', unlockAudio, { capture: true });
window.addEventListener('keydown', unlockAudio, { capture: true });

const ui = new UI(settings, {
  sfx: (k) => audio.ui(k),
  dive: (daily) => { unlockAudio(); game.startRun({ daily }); },
  resume: () => { if (ui.hasModal()) ui.closeModal(); game.resume(); },
  quit: () => { audio.ui('back'); game.abandonRun(); game.startTitle(); ui.setMode('title'); },
  upgrade: (id) => game.chooseUpgrade(id),
  continueEndless: () => { game.continueEndless(); },
  settingsChanged: () => applySettings(),
  resetHints: () => { game.hintsSeen = {}; save('hints', {}); },
  resetBest: () => { game.best = { depth: 0, score: 0, endless: 0, daily: { date: '', depth: 0, score: 0 } }; save('best', game.best); },
});

function applySettings() {
  const taper = (v) => Math.min(1, v * v * 1.25);   // squared curve: the low end of a slider stays usable
  audio.setVolumes(taper(settings.master), taper(settings.music));
  if (renderer) renderer.quality = settings.bloom ? 'high' : 'low';
}

game = new Game({ input, audio, ui, settings });
ui.attach(game);
renderer = new Renderer(canvas, game);
applySettings();
game.startTitle();
ui.setMode('title');
window.addEventListener('resize', () => renderer.resize());
// there are no touch controls: say so instead of leaving a phone visitor poking at a dark screen
if (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches) ui.toast('FATHOMLESS is played with a keyboard or gamepad. Best on desktop.', 9000, 'sys');

// handy for automated tests and tinkering
let frozen = false;
window.__fathom = {
  game, audio, renderer, input, ui, settings,
  freeze(b = true) { frozen = !!b; },
  step(n = 1, draw = true) {
    for (let i = 0; i < n; i++) game.update(1 / 60);
    if (draw) { renderer.frame(); ui.updateHud(game); }
    return game.state;
  },
  start(seed, depth = 1) {
    unlockAudio();
    game.startRun({ seed });
    if (depth > 1) game.loadLevel(depth);
    return game;
  },
};
if (q.has('god')) game.god = true;
if (q.has('low')) { settings.bloom = false; applySettings(); }
if (q.has('start')) window.__fathom.start(q.get('seed') || undefined, parseInt(q.get('depth') || '1', 10));

/* ---------- global keys ---------- */
let fsKeyAt = -1e9;
function globalKeys() {
  if (input.pressed('mute')) {
    audio.setMuted(!audio.muted);
    settings.muted = audio.muted; save('settings', settings);
    ui.toast(audio.muted ? 'Sound off' : 'Sound on', 1400, 'sys');
  }
  if (input.pressed('fullscreen')) {
    fsKeyAt = performance.now();
    try {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    } catch (e) { /* fullscreen is a nicety */ }
  }
  if (input.pressed('pause')) {
    if (game.state === 'play') game.pause();
    else if (game.state === 'paused') { if (ui.hasModal()) ui.closeModal(); else game.resume(); }
    else if (ui.hasModal()) ui.closeModal();
  }
  if (game.state === 'upgrade') {
    ['sel1', 'sel2', 'sel3'].forEach((a, i) => {
      if (input.pressed(a) && game.upgradeChoices && game.upgradeChoices[i]) game.chooseUpgrade(game.upgradeChoices[i].id);
    });
  }
  // title: Enter dives (when no button has the focus); gamepad: d-pad / stick moves, A presses
  if (game.state === 'title' && !ui.hasModal() && input.pressed('confirm') && !(document.activeElement && document.activeElement.tagName === 'BUTTON')) {
    unlockAudio(); audio.ui('click'); game.startRun({});
  }
  if (input.pressed('menuUp')) ui.menuMove(-1);
  if (input.pressed('menuDown')) ui.menuMove(1);
  if (input.pressed('menuLeft') && !ui.menuAdjust(-1)) ui.menuMove(-1);
  if (input.pressed('menuRight') && !ui.menuAdjust(1)) ui.menuMove(1);
  if (input.pressed('padOk')) {
    const L = ui.layer();
    if (game.state === 'title' && L && !ui.hasModal() && !L.contains(document.activeElement)) { unlockAudio(); audio.ui('click'); game.startRun({}); }
    else ui.menuOk();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (game.state === 'play') game.pause();
    audio.suspend();
  } else audio.resume();
});
window.addEventListener('blur', () => { if (game.state === 'play') game.pause(); });
window.addEventListener('pagehide', () => { try { game.abandonRun(); } catch (e) { /* closing anyway */ } });
// leaving fullscreen with Esc (the browser swallows that key, so the game never sees it) parks the dive; the F key just toggles
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && game.state === 'play' && performance.now() - fsKeyAt > 1500) game.pause(); });

/* ---------- adaptive quality ---------- */
// If the game stays under ~26 fps for a few seconds of play, drop the glow first, then the resolution.
let slowT = 0, adaptStage = 0;
function adapt(dt) {
  if (navigator.webdriver || q.has('noadapt') || game.state !== 'play' || document.hidden) { slowT = 0; return; }
  if (dt > 1 / 26) slowT += dt; else slowT = Math.max(0, slowT - dt * 2);
  if (slowT < 4 || adaptStage >= 2) return;
  slowT = 0; adaptStage++;
  if (adaptStage === 1 && renderer.quality === 'high') {
    renderer.quality = 'low';
    ui.toast('Running slowly: glow effect switched off (Settings to change).', 5000);
  } else {
    renderer.resScale = adaptStage >= 2 ? 0.55 : 0.75; renderer.resize();
    ui.toast('Running slowly: render resolution lowered.', 5000);
  }
}

/* ---------- loop ---------- */
const STEP = 1 / 60;
let last = performance.now(), acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (frozen) return;
  if (!(dt > 0)) dt = STEP;
  if (dt > 0.25) dt = 0.25;
  acc += dt;
  input.poll();
  globalKeys();
  let steps = 0;
  while (acc >= STEP && steps < 5) {
    game.update(STEP);
    acc -= STEP; steps++;
  }
  if (steps === 5) acc = 0;
  adapt(dt);
  audio.tick(dt, game.state === 'play' || game.state === 'levelend');
  renderer.frame();
  ui.updateHud(game);
  if (steps > 0) input.endFrame();
}
requestAnimationFrame((t) => { last = t; frame(t); });
