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
    this.bind();
    this.applySettingsToControls();
  }

  attach(game) { this.game = game; this.refreshTitle(); }

  /* ---------- wiring ---------- */
  bind() {
    const click = (id, fn) => $(id).addEventListener('click', (e) => { e.currentTarget.blur(); this.h.sfx && this.h.sfx('click'); fn(e); });
    click('btnDive', () => this.h.dive(false));
    click('btnDaily', () => this.h.dive(true));
    click('btnHow', () => this.openModal('howto'));
    click('btnSettings', () => this.openModal('settings'));
    click('btnResume', () => this.h.resume());
    click('btnPauseSettings', () => this.openModal('settings'));
    click('btnPauseHow', () => this.openModal('howto'));
    click('btnQuit', () => this.h.quit());
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', (e) => { e.currentTarget.blur(); this.h.sfx && this.h.sfx('back'); this.closeModal(); }));
    document.querySelectorAll('.btn, .card').forEach((b) => b.addEventListener('mouseenter', () => this.h.sfx && this.h.sfx('hover')));

    const s = this.settings;
    $('setMaster').addEventListener('input', (e) => { s.master = e.target.value / 100; this.changed(); });
    $('setMusic').addEventListener('input', (e) => { s.music = e.target.value / 100; this.changed(); });
    $('setShake').addEventListener('change', (e) => { s.shake = e.target.checked; this.changed(); });
    $('setFlash').addEventListener('change', (e) => { s.reduceFlash = e.target.checked; this.changed(); });
    $('setHints').addEventListener('change', (e) => { s.hints = e.target.checked; this.changed(); });
    $('setBloom').addEventListener('change', (e) => { s.bloom = e.target.checked; this.changed(); });
    $('btnResetHints').addEventListener('click', (e) => { e.currentTarget.blur(); this.h.resetHints(); this.toast('Hints reset.', 2000); });
    $('btnResetBest').addEventListener('click', (e) => {
      e.currentTarget.blur();
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
    if (mode === 'paused') { this.modalStack = []; this.show('pause', true); $('btnResume').focus({ preventScroll: true }); }
    if (mode === 'title') this.refreshTitle();
    if (mode === 'upgrade') { const c = document.querySelector('#cards .card'); if (c) c.focus({ preventScroll: true }); }
    if (mode === 'title' || mode === 'gameover' || mode === 'victory') {
      document.querySelectorAll('#toasts .toast').forEach((n) => n.remove());
    }
  }

  openModal(id) {
    const cur = this.modalStack[this.modalStack.length - 1];
    if (cur) this.show(cur, false);
    else if (this.mode === 'paused') this.show('pause', false);
    this.modalStack.push(id);
    this.show(id, true);
    const first = $(id).querySelector('button, input');
    if (first) first.focus({ preventScroll: true });
  }

  closeModal() {
    const cur = this.modalStack.pop();
    if (cur) this.show(cur, false);
    const prev = this.modalStack[this.modalStack.length - 1];
    if (prev) this.show(prev, true);
    else if (this.mode === 'paused') this.show('pause', true);
    if (!this.modalStack.length) this.applySettingsToControls();
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

  toast(text, ms = 5000) {
    const host = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = text;
    host.appendChild(el);
    this.toastEls.push(el);
    while (this.toastEls.length > 3) { const o = this.toastEls.shift(); o.remove(); }
    setTimeout(() => el.classList.add('out'), Math.max(500, ms - 800));
    setTimeout(() => { el.remove(); this.toastEls = this.toastEls.filter((x) => x !== el); }, ms);
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
      b.addEventListener('click', () => this.h.upgrade(u.id));
      b.addEventListener('mouseenter', () => this.h.sfx && this.h.sfx('hover'));
      host.appendChild(b);
    });
  }

  hideUpgrade() { $('cards').innerHTML = ''; }

  /* ---------- end screens ---------- */
  showEnd(won, run, info) {
    const panel = document.querySelector('#end .panel');
    panel.classList.toggle('win', won);
    $('endKicker').textContent = won ? 'YOU REACHED THE HEART' : 'THE DARK TAKES YOU';
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
      b.addEventListener('click', (e) => { e.currentTarget.blur(); this.h.sfx && this.h.sfx('click'); fn(); });
      btns.appendChild(b); return b;
    };
    const first = won
      ? mk('Descend further', 'primary', () => this.h.continueEndless())
      : mk(run.daily ? 'Retry daily' : 'Dive again', 'primary', () => this.h.dive(run.daily));
    mk('Title', '', () => this.h.quit());
    panel.querySelectorAll('.newbest').forEach((n) => n.remove());
    if (info.newScore || info.newDepth) {
      const n = document.createElement('div'); n.className = 'newbest'; n.textContent = info.newScore ? 'New best score' : 'New deepest dive';
      panel.insertBefore(n, $('endStats'));
    }
    setTimeout(() => first.focus({ preventScroll: true }), 50);
  }
}
