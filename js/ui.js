// DOM user interface: menus, HUD, toasts, upgrade picker, end screens.
import { UPGRADES, DEPTH_METERS, MAX_DEPTH, PING } from './config.js';
import { save } from './storage.js';

const $ = (id) => document.getElementById(id);

const ICONS = {
  lens: '<circle cx="12" cy="12" r="3"/><path d="M5 12a7 7 0 0 1 7-7M19 12a7 7 0 0 1-7 7M2.5 12A9.5 9.5 0 0 1 12 2.5M21.5 12a9.5 9.5 0 0 1-9.5 9.5"/>',
  cell: '<path d="M13 2 5 13h6l-1 9 8-12h-6z"/>',
  hull: '<path d="M12 2l8.5 5v10L12 22 3.5 17V7z"/><path d="M12 7v10M7.5 9.5l9 5"/>',
  decoy: '<circle cx="12" cy="12" r="2.5"/><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16"/>',
  fins: '<path d="M3 6c3-3 5 3 9 0s6 3 9 0M3 12c3-3 5 3 9 0s6 3 9 0M3 18c3-3 5 3 9 0s6 3 9 0"/>',
  memory: '<circle cx="12" cy="12" r="9" stroke-dasharray="2 3"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  dowse: '<path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z"/>',
  burst: '<path d="M5 6l6 6-6 6M12 6l6 6-6 6"/>',
  capacitor: '<path d="M20 12a8 8 0 1 1-3-6.2"/><path d="M20 3v5h-5"/>',
};

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export class UI {
  constructor(settings, handlers) {
    this.settings = settings;
    this.h = handlers;
    this.game = null;
    this.mode = 'title';
    this.modalStack = [];
    this.cache = {};
    this.hudVisible = false;
    this.toastEls = [];
    this.focusStack = [];
    this.guardUntil = 0;     // screens that pop up mid-action ignore keyboard activation (Space/Enter) for a moment
    this.lastKeyAt = 0;
    this.bound = false;
    this.bind();
    this.applySettingsToControls();
  }

  attach(game) { this.game = game; this.refreshTitle(); }

  /* ---------- wiring ---------- */
  // a click that is really a key-repeat / late release of Space or Enter right after a screen popped up (e.g. while mashing
  // SPACE to ping at the gate) must not pick an upgrade or restart the dive by accident
  stray(e) { return e.detail === 0 && performance.now() < this.guardUntil && performance.now() - this.lastKeyAt < 250; }

  bind() {
    if (this.bound) return;
    this.bound = true;
    const click = (id, fn) => $(id).addEventListener('click', (e) => {
      if (this.stray(e)) return;
      if (e.detail) e.currentTarget.blur();   // mouse clicks release focus so a later SPACE can never re-trigger the button; keyboard users keep their place
      this.h.sfx && this.h.sfx('click'); fn(e);
    });
    // keyboard navigation inside whichever menu layer is on top (Tab / Shift+Tab / arrows), trapped so focus never leaks behind a modal
    const keyNote = (e) => { if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') this.lastKeyAt = performance.now(); };
    document.addEventListener('keyup', keyNote, true);
    document.addEventListener('keydown', (e) => {
      keyNote(e);
      if (e.ctrlKey || e.metaKey || e.altKey || this.mode === 'play') return;
      const layer = this.layer();
      if (!layer) return;
      const range = e.target && e.target.type === 'range';
      let d = 0;
      if (e.code === 'Tab') d = e.shiftKey ? -1 : 1;
      else if (e.code === 'ArrowDown' || (e.code === 'ArrowRight' && !range)) d = 1;
      else if (e.code === 'ArrowUp' || (e.code === 'ArrowLeft' && !range)) d = -1;
      if (d) { e.preventDefault(); this.menuMove(d); }
    }, true);
    click('btnDive', () => this.h.dive(false));
    click('btnDaily', () => this.h.dive(true));
    click('btnHow', () => this.openModal('howto'));
    click('btnSettings', () => this.openModal('settings'));
    click('btnResume', () => this.h.resume());
    click('btnPauseSettings', () => this.openModal('settings'));
    click('btnPauseHow', () => this.openModal('howto'));
    click('btnQuit', () => this.h.quit());
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', (e) => { if (e.detail) e.currentTarget.blur(); this.h.sfx && this.h.sfx('back'); this.closeModal(); }));
    document.querySelectorAll('.btn, .card').forEach((b) => b.addEventListener('mouseenter', () => this.h.sfx && this.h.sfx('hover')));

    const s = this.settings;
    $('setMaster').addEventListener('input', (e) => { s.master = e.target.value / 100; this.changed(); });
    $('setMaster').addEventListener('change', () => this.h.sfx && this.h.sfx('click'));   // audible feedback for the new volume
    $('setMusic').addEventListener('input', (e) => { s.music = e.target.value / 100; this.changed(); });
    $('setShake').addEventListener('change', (e) => { s.shake = e.target.checked; this.changed(); });
    $('setFlash').addEventListener('change', (e) => { s.reduceFlash = e.target.checked; this.changed(); });
    $('setHints').addEventListener('change', (e) => { s.hints = e.target.checked; this.changed(); });
    $('setBloom').addEventListener('change', (e) => { s.bloom = e.target.checked; this.changed(); });
    $('btnResetHints').addEventListener('click', (e) => { if (e.detail) e.currentTarget.blur(); this.h.resetHints(); this.toast('Hints reset.', 2000, 'sys'); });
    $('btnResetBest').addEventListener('click', (e) => {
      if (e.detail) e.currentTarget.blur();
      if (e.currentTarget.dataset.armed) { this.h.resetBest(); e.currentTarget.textContent = 'Erase records'; delete e.currentTarget.dataset.armed; this.refreshTitle(); }
      else { e.currentTarget.dataset.armed = '1'; e.currentTarget.textContent = 'Click again to confirm'; setTimeout(() => { e.currentTarget.textContent = 'Erase records'; delete e.currentTarget.dataset.armed; }, 3000); }
    });
  }

  changed() { save('settings', this.settings); this.h.settingsChanged(); }

  applySettingsToControls() {
    const s = this.settings;
    $('setMaster').value = Math.round(s.master * 100);
    $('setMusic').value = Math.round(s.music * 100);
    $('setShake').checked = !!s.shake;
    $('setFlash').checked = !!s.reduceFlash;
    $('setHints').checked = !!s.hints;
    $('setBloom').checked = !!s.bloom;
  }

  /* ---------- modes ---------- */
  show(id, on) { $(id).classList.toggle('show', !!on); }

  setMode(mode) {
    this.mode = mode;
    document.body.classList.toggle('playing', mode === 'play');
    const inRun = ['play', 'paused', 'dying'].includes(mode);
    this.hudVisible = inRun || mode === 'levelend';
    $('hud').classList.toggle('hidden', !this.hudVisible);
    this.show('title', mode === 'title');
    this.show('upgrade', mode === 'upgrade');
    this.show('end', mode === 'gameover' || mode === 'victory');
    if (mode !== 'paused') { this.modalStack = []; ['pause', 'settings', 'howto'].forEach((id) => this.show(id, false)); }
    if (mode === 'paused') { this.modalStack = []; this.focusStack = []; this.show('pause', true); $('btnResume').focus({ preventScroll: true }); }
    if (mode === 'title') this.refreshTitle();
    // popping up mid-action: swallow stray Space/Enter for a moment, and never pre-focus a card that a key-repeat could pick
    if (mode === 'upgrade' || mode === 'gameover' || mode === 'victory') this.guardUntil = performance.now() + 700;
    if (mode === 'upgrade' && document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    if (mode === 'title' || mode === 'upgrade' || mode === 'gameover' || mode === 'victory') this.clearToasts();
  }

  openModal(id) {
    const cur = this.modalStack[this.modalStack.length - 1];
    const from = document.activeElement;
    if (cur) this.show(cur, false);
    else if (this.mode === 'paused') this.show('pause', false);
    this.modalStack.push(id);
    this.focusStack.push(from && from.tagName === 'BUTTON' ? from : null);
    this.show(id, true);
    const first = $(id).querySelector('button, input');
    if (first) first.focus({ preventScroll: true });
  }

  closeModal() {
    const cur = this.modalStack.pop();
    const back = this.focusStack.pop();
    if (cur) this.show(cur, false);
    const prev = this.modalStack[this.modalStack.length - 1];
    if (prev) this.show(prev, true);
    else if (this.mode === 'paused') this.show('pause', true);
    if (!this.modalStack.length) this.applySettingsToControls();
    if (back && back.offsetParent !== null) back.focus({ preventScroll: true });   // keyboard users land where they were
    else if (this.mode === 'paused' && !this.modalStack.length) $('btnResume').focus({ preventScroll: true });
  }

  /* ---------- menu navigation (keyboard Tab/arrows, gamepad d-pad) ---------- */
  layer() {   // the layer that currently owns input
    for (const id of ['howto', 'settings', 'pause', 'upgrade', 'end', 'title']) { const el = $(id); if (el.classList.contains('show')) return el; }
    return null;
  }

  focusables(layer) {
    return Array.from(layer.querySelectorAll('button, input')).filter((el) => !el.disabled && el.offsetParent !== null);
  }

  menuMove(d) {
    const layer = this.layer();
    if (!layer) return false;
    const list = this.focusables(layer);
    if (!list.length) return false;
    const i = list.indexOf(document.activeElement);
    const n = i < 0 ? (d > 0 ? 0 : list.length - 1) : (i + d + list.length) % list.length;
    list[n].focus({ preventScroll: true });
    this.h.sfx && this.h.sfx('hover');
    return true;
  }

  // gamepad A / Enter on a focused control; true when it did something
  menuOk() {
    const layer = this.layer(), a = document.activeElement;
    if (!layer) return false;
    if (a && layer.contains(a) && (a.tagName === 'BUTTON' || a.type === 'checkbox')) { a.click(); return true; }
    const list = this.focusables(layer);
    if (list[0]) { list[0].focus({ preventScroll: true }); return true; }
    return false;
  }

  // left/right on a focused slider (gamepad); false when the focus is not a slider
  menuAdjust(d) {
    const a = document.activeElement;
    if (!a || a.type !== 'range') return false;
    a.value = Math.max(0, Math.min(100, +a.value + d * 5));
    a.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  hasModal() { return this.modalStack.length > 0; }

  refreshTitle() {
    const g = this.game;
    const best = g ? g.best : { depth: 0, score: 0 };
    $('bestLine').textContent = best.depth > 0 ? `Deepest dive  ${best.depth}   ·   Best score  ${fmt(best.score)}` : 'No dives recorded yet';
    const today = new Date().toISOString().slice(0, 10);
    const d = best.daily && best.daily.date === today ? best.daily : null;
    $('dailyBest').textContent = d && d.depth ? `today's best: depth ${d.depth}` : 'same cave for everyone, today';
  }

  setHue(h) {
    if (this.cache.hue === h) return;
    this.cache.hue = h;
    document.documentElement.style.setProperty('--h', h);
  }

  /* ---------- HUD ---------- */
  updateHud(g) {
    if (g.lv) this.setHue(g.lv.biome.hue);
    if (!this.hudVisible || !g.run) return;
    const p = g.player, st = g.stats, c = this.cache;
    if (c.maxHull !== p.maxHull) {
      c.maxHull = p.maxHull; c.hull = -1;
      $('hull').innerHTML = '<i></i>'.repeat(p.maxHull);
    }
    if (c.hull !== p.hull) {
      const pips = $('hull').children;
      for (let i = 0; i < pips.length; i++) {
        pips[i].classList.toggle('off', i >= p.hull);
        if (c.hull > p.hull && i === p.hull) { pips[i].classList.remove('hit'); void pips[i].offsetWidth; pips[i].classList.add('hit'); }
      }
      c.hull = p.hull;
    }
    const ep = Math.round((p.energy / st.maxEnergy) * 1000) / 10;
    if (c.ep !== ep) { c.ep = ep; $('energyFill').style.width = ep + '%'; }
    let cw = 0, cl = 0;
    if (p.charging) {
      const cost = PING.costMin + (PING.costMax - PING.costMin) * p.charge;
      cw = (cost / st.maxEnergy) * 100; cl = ((p.energy + 0) / st.maxEnergy) * 100 - cw;
    }
    const key = cw.toFixed(1) + cl.toFixed(1);
    if (c.charge !== key) { c.charge = key; const el = $('chargeFill'); el.style.width = cw + '%'; el.style.left = Math.max(0, cl) + '%'; }
    const dashReady = p.dashCd <= 0 && p.energy >= st.dashCost;
    if (c.dash !== dashReady) { c.dash = dashReady; $('dashInd').classList.toggle('dim', !dashReady); $('dashInd').classList.toggle('ready', dashReady); }
    if (c.buoys !== p.buoys) { c.buoys = p.buoys; $('buoyCount').textContent = p.buoys; $('buoyInd').classList.toggle('dim', p.buoys <= 0); }
    const d = g.run.depth;
    if (c.depth !== d) { c.depth = d; $('depthLbl').textContent = `DEPTH ${d}`; $('metersLbl').textContent = `${d * DEPTH_METERS} m`; }
    if (c.score !== g.run.score) { c.score = g.run.score; $('scoreLbl').textContent = fmt(g.run.score); }
    if (c.pearls !== g.run.pearls) { c.pearls = g.run.pearls; $('pearlLbl').textContent = `${g.run.pearls} pearl${g.run.pearls === 1 ? '' : 's'}`; }
  }

  pulseEnergy() {
    const el = document.querySelector('.bar.energy');
    el.classList.remove('warn'); void el.offsetWidth; el.classList.add('warn');
  }

  // key: toasts sharing a key replace each other (so mashing M, or a queue of hints, never stacks)
  toast(text, ms = 5000, key = '') {
    let el = key ? this.toastEls.find((t) => t.dataset.key === key) : null;
    if (el) { clearTimeout(el._t1); clearTimeout(el._t2); el.textContent = text; el.classList.remove('out'); }
    else {
      el = document.createElement('div');
      el.className = 'toast'; el.textContent = text;
      if (key) el.dataset.key = key;
      $('toasts').appendChild(el);
      this.toastEls.push(el);
      while (this.toastEls.length > 3) this.removeToast(this.toastEls[0]);
    }
    el._t1 = setTimeout(() => el.classList.add('out'), Math.max(500, ms - 800));
    el._t2 = setTimeout(() => this.removeToast(el), ms);
    return el;
  }

  removeToast(el) {
    clearTimeout(el._t1); clearTimeout(el._t2);
    el.remove();
    this.toastEls = this.toastEls.filter((x) => x !== el);
  }

  fadeToast(el) {   // start fading right now, then clean up
    if (!el || !this.toastEls.includes(el)) return;
    clearTimeout(el._t1); clearTimeout(el._t2);
    el.classList.add('out');
    el._t2 = setTimeout(() => this.removeToast(el), 800);
  }

  clearToasts() {
    for (const el of this.toastEls.slice()) this.removeToast(el);
    $('toasts').textContent = '';
  }

  banner(zone, depthLine, tag) {
    const b = $('banner');
    b.querySelector('.b-zone').textContent = zone;
    b.querySelector('.b-depth').textContent = depthLine;
    b.querySelector('.b-tag').textContent = tag;
    b.classList.remove('go'); void b.offsetWidth; b.classList.add('go');
  }

  /* ---------- upgrade picker ---------- */
  showUpgrade(choices, run, summary) {
    const host = $('cards');
    host.innerHTML = '';
    $('upKicker').textContent = `DEPTH ${run.depth} CLEARED`;
    const s = summary;
    $('upSum').innerHTML = s
      ? `<span>Depth bonus <b>+${s.base}</b></span><span>Speed <b>+${s.timeBonus}</b></span><span>Flawless <b>+${s.flawless}</b></span><span>Pearls <b>${s.pearls}</b></span><span>Score <b>${fmt(run.score)}</b></span>`
      : '';
    choices.forEach((u, i) => {
      const have = run.ups[u.id] || 0;
      const b = document.createElement('button');
      b.className = 'card';
      b.type = 'button';
      let pips = '';
      for (let k = 0; k < u.max; k++) pips += `<i class="${k < have ? 'on' : k === have ? 'next' : ''}"></i>`;
      b.innerHTML = `<span class="num">${i + 1}</span><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[u.id] || ''}</svg><h4>${u.name}</h4><p>${u.desc}</p><div class="lvl">${pips}</div>`;
      b.addEventListener('click', (e) => { if (!this.stray(e)) this.h.upgrade(u.id); });
      b.addEventListener('mouseenter', () => this.h.sfx && this.h.sfx('hover'));
      host.appendChild(b);
    });
  }

  hideUpgrade() { $('cards').innerHTML = ''; }

  /* ---------- end screens ---------- */
  showEnd(won, run, info) {
    const panel = document.querySelector('#end .panel');
    panel.classList.toggle('win', won);
    $('endKicker').textContent = (run.daily ? 'DAILY DIVE  ·  ' : '') + (won ? 'YOU REACHED THE HEART' : 'THE DARK TAKES YOU');
    $('endTitle').textContent = won ? 'Fathomless' : `Lost at ${run.depth * DEPTH_METERS} m`;
    $('endSub').textContent = won
      ? 'Twelve depths. The leviathan sleeps again, and your song echoes in the hollow.'
      : run.daily ? 'The daily cave keeps its secrets until tomorrow.' : 'Every cave is different. Every silence is a choice.';
    const stat = (v, l, hi) => `<div class="stat${hi ? ' hi' : ''}"><b>${v}</b><span>${l}</span></div>`;
    $('endStats').innerHTML =
      stat(run.depth, 'Depth', info.newDepth) + stat(fmt(run.score), 'Score', info.newScore) + stat(run.pearls, 'Pearls') +
      stat(fmtTime(run.time), 'Time') + stat(run.pings, 'Pings') + stat(run.hits, 'Hits taken');
    const btns = $('endBtns');
    btns.innerHTML = '';
    const mk = (label, cls, fn) => {
      const b = document.createElement('button');
      b.className = 'btn ' + cls; b.textContent = label;
      b.addEventListener('mouseenter', () => this.h.sfx && this.h.sfx('hover'));
      b.addEventListener('click', (e) => { if (this.stray(e)) return; if (e.detail) e.currentTarget.blur(); this.h.sfx && this.h.sfx('click'); fn(); });
      btns.appendChild(b); return b;
    };
    const first = won
      ? mk('Descend further', 'primary', () => this.h.continueEndless())
      : mk(run.daily ? 'Retry daily' : 'Dive again', 'primary', () => this.h.dive(run.daily));
    mk('Title', '', () => this.h.quit());
    panel.querySelectorAll('.newbest').forEach((n) => n.remove());
    if (info.newScore || info.newDepth || info.newDaily) {
      const n = document.createElement('div'); n.className = 'newbest';
      n.textContent = [info.newScore && 'New best score', info.newDepth && 'New deepest dive', info.newDaily && !info.newScore && 'New daily best'].filter(Boolean).join('  ·  ');
      panel.insertBefore(n, $('endStats'));
    }
    setTimeout(() => first.focus({ preventScroll: true }), 50);
  }
}
