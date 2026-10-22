// Canvas renderer. Everything is vector art drawn additively on a near-black ocean.
import { PING, MAX_DEPTH } from './config.js';
import { HK } from './sonar.js';
import { rayMarch, sdfAt, gradAt } from './world.js';
import { clamp, TAU, mulberry32 } from './rng.js';

const THREAT_H = 14;
const GOLD_H = 44;
const hsla = (h, s, l, a) => `hsla(${h | 0},${s | 0}%,${l | 0}%,${a.toFixed(3)})`;
// cached variant for hot loops: alpha is snapped to 1/AQ so each distinct colour string is built once
const AQ = 48;
const _cc = new Map();
const hc = (h, s, l, a) => {
  const q = a <= 0 ? 0 : a >= 1 ? AQ : Math.round(a * AQ);
  const key = (((h | 0) * 101 + (s | 0)) * 101 + (l | 0)) * 64 + q;
  let v = _cc.get(key);
  if (v === undefined) { if (_cc.size > 30000) _cc.clear(); v = `hsla(${h | 0},${s | 0}%,${l | 0}%,${(q / AQ).toFixed(3)})`; _cc.set(key, v); }
  return v;
};
function hsl2rgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h * 12) % 12; return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255; };
  return [f(0), f(8), f(4)];
}
const BUCKETS = 6;
const MCELL = 192;   // world units per memory-map cell (spatial index for the vector map)
const MPAD = 40;     // how far a stored segment may poke out of its cell
const MIC = 1 / 1.5; // memory occupancy grid: 1.5 world units per bit

export class Renderer {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.game = game;
    this.px = 1;            // device pixels per world unit at zoom 1
    this.dpr = 1;
    this.resScale = 1;      // adaptive quality: <1 renders fewer pixels on slow machines
    this.bk = new Uint8Array(1024);
    this.bidx = []; for (let b = 0; b < BUCKETS; b++) this.bidx.push(new Int16Array(1024));
    this.bn = new Int32Array(BUCKETS);
    this.act = new Uint8Array(1024); this.dots = new Int16Array(1024);
    this.rbuf = new Int16Array(1024);
    // The persistent "memory map" is a sparse vector store now (see buildChains / drawMemory): crisp at any
    // zoom or DPR and no level-sized bitmap. `mem` stays as a 1x1 handle for older tooling.
    this.mem = document.createElement('canvas'); this.mem.width = this.mem.height = 1;
    this.mcells = []; this.mcw = 0; this.mch = 0; this.mocc = null; this.mow = 0; this.moh = 0; this.mvis = [];
    this.bloom = [document.createElement('canvas'), document.createElement('canvas'), document.createElement('canvas')];
    this.bctx = this.bloom.map((c) => c.getContext('2d'));
    this.bg = document.createElement('canvas');
    const rnd = mulberry32(7);
    this.dither = new Float32Array(128 * 128); for (let i = 0; i < this.dither.length; i++) this.dither[i] = rnd() - 0.5;
    this.snow = [];
    for (let i = 0; i < 150; i++) this.snow.push({ ox: rnd(), oy: rnd(), vx: (rnd() - 0.5) * 6, vy: 2 + rnd() * 5, s: 0.6 + rnd() * 1.2, par: i < 90 ? 1 : 0.55, tw: rnd() * TAU });
    this.orbs = [];
    for (let i = 0; i < 16; i++) this.orbs.push({ ox: rnd(), oy: rnd(), vx: (rnd() - 0.5) * 5, vy: -1 - rnd() * 3, s: 14 + rnd() * 38, par: 0.18 + rnd() * 0.3, tw: rnd() * TAU });
    this.orbSpr = null; this.orbHue = -1;
    this.glow = null;       // title-only: soft luminous silhouette of the demo cave
    this.lastPingR = new WeakMap();
    this.fcl = new Float32Array(0);
    this.fgrp = new Map(); this.tp = new Float32Array(2048);
    this.lastT = 0;
    this.quality = 'high';
    this.bgKey = '';
    this.S = 1;
    this.fx = this.makeFx(canvas);
    game.onLevel = (lv) => this.resetLevel(lv);
    this.resize();
    this.watchDpr();
  }

  // screen-space layers that need no per-pixel canvas work (vignette, danger tint, flash) live in the DOM
  makeFx(canvas) {
    const mk = (id, prev) => {
      let e = document.getElementById(id);
      if (!e) { e = document.createElement('div'); e.id = id; e.className = 'fx'; e.setAttribute('aria-hidden', 'true'); prev.parentNode.insertBefore(e, prev.nextSibling); }
      return e;
    };
    // bloom: the blurred 1/4 and 1/8 copies are real elements stretched over the canvas and added by the compositor,
    // so the full-resolution canvas is read once per frame and never rewritten
    const bl = [1, 2].map((i) => {
      const e = this.bloom[i];
      e.id = i === 1 ? 'fxBloomB' : 'fxBloomC'; e.className = 'fxb'; e.setAttribute('aria-hidden', 'true');
      try { if (window.CSS && CSS.supports && CSS.supports('mix-blend-mode', 'plus-lighter')) e.style.mixBlendMode = 'plus-lighter'; } catch (err) { /* screen fallback in css */ }
      canvas.parentNode.insertBefore(e, canvas.nextSibling);
      return e;
    });
    const vig = mk('fxVig', canvas), dng = mk('fxDanger', vig), fl = mk('fxFlash', dng);
    return { vig, dng, fl, bl, v: {}, cy: false, bloomOn: true };
  }

  fxSet(k, el, v) {
    v = Math.round(v * 400) / 400;
    if (this.fx.v[k] !== v) { this.fx.v[k] = v; el.style.opacity = v; }
  }

  watchDpr() {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    if (mq.addEventListener) mq.addEventListener('change', () => { this.resize(); this.watchDpr(); }, { once: true });
  }

  resize() {
    const cw = Math.max(320, window.innerWidth), ch = Math.max(240, window.innerHeight);
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cw * dpr > 2560) dpr = 2560 / cw;
    dpr *= this.resScale;
    this.dpr = dpr;
    const c = this.canvas;
    const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
    c.style.width = cw + 'px'; c.style.height = ch + 'px';
    if (c.width !== W || c.height !== H) {   // reassigning width/height reallocates: only do it on a real change
      c.width = W; c.height = H;
      const sizes = [2, 4, 8];
      this.bloom.forEach((b, i) => { b.width = Math.max(2, Math.ceil(W / sizes[i])); b.height = Math.max(2, Math.ceil(H / sizes[i])); });
    }
    this.px = dpr * Math.min(cw / 1280, ch / 720);
    const g = this.game;
    g.view.w = c.width / this.px; g.view.h = c.height / this.px;
  }

  resetLevel(lv) {
    // drop the previous level's memory map, flora scratch and title glow
    this.mcw = Math.ceil(lv.width / MCELL); this.mch = Math.ceil(lv.height / MCELL);
    this.mcells = new Array(this.mcw * this.mch);
    this.mow = Math.ceil(lv.width * MIC) + 2; this.moh = Math.ceil(lv.height * MIC) + 2;
    this.mocc = new Uint8Array(this.mow * this.moh);
    this.lastPingR = new WeakMap();
    this.glow = null;
    const fl = lv.flora;
    this.fcl = new Float32Array(fl.length);
    for (let i = 0; i < fl.length; i++) {
      const f = fl[i];
      f.lit = 0;
      // how far each plant can grow before it would poke through the opposite wall
      this.fcl[i] = 2.5 + rayMarch(lv, f.x + f.nx * 2.5, f.y + f.ny * 2.5, f.nx, f.ny, 120);
    }
    this.lastT = this.game.realTime;
  }

  buildBackdrop(W, H, hue) {
    const b = this.bg;
    b.width = W; b.height = H;
    const x = b.getContext('2d');
    const im = x.createImageData(W, H), d = im.data;
    const top = hsl2rgb(hue, 0.7, 0.05), bot = hsl2rgb(hue + 12, 0.8, 0.02), nz = this.dither;
    for (let y = 0; y < H; y++) {
      const t = y / Math.max(1, H - 1);
      const r = top[0] + (bot[0] - top[0]) * t, g = top[1] + (bot[1] - top[1]) * t, bl = top[2] + (bot[2] - top[2]) * t;
      const row = (y & 127) << 7;
      let o = y * W * 4;
      for (let xx = 0; xx < W; xx++, o += 4) {
        const n = nz[row + (xx & 127)];   // stochastic dither: the dark gradient never shows bands
        d[o] = r + n; d[o + 1] = g + n; d[o + 2] = bl + n; d[o + 3] = 255;
      }
    }
    x.putImageData(im, 0, 0);
  }

  /* ================================================================ */
  frame() {
    const g = this.game, lv = g.lv;
    if (!lv) return;
    const ctx = this.ctx, c = this.canvas, W = c.width, H = c.height;
    const hue = lv.biome.hue;
    const title = g.state === 'title';

    // ---- backdrop ----
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const key = lv.biome.id + ':' + W + 'x' + H;
    if (this.bgKey !== key) { this.bgKey = key; this.buildBackdrop(W, H, hue); }
    ctx.drawImage(this.bg, 0, 0);

    // ---- camera ----
    const cam = g.cam, S = this.px * cam.zoom;
    ctx.setTransform(S, 0, 0, S, W / 2 - (cam.x + cam.sx) * S, H / 2 - (cam.y + cam.sy) * S);
    const hw = g.view.w / 2 / cam.zoom + 90, hh = g.view.h / 2 / cam.zoom + 90;
    const vb = { x0: cam.x - hw, x1: cam.x + hw, y0: cam.y - hh, y1: cam.y + hh };
    const inView = (x, y, m = 0) => x > vb.x0 - m && x < vb.x1 + m && y > vb.y0 - m && y < vb.y1 + m;
    this.S = S;

    ctx.globalCompositeOperation = 'lighter';
    this.drawBokeh(ctx, g, vb, hue, title);
    this.drawSnow(ctx, g, vb, S, 0);          // far plankton layer
    if (title) this.drawCaveGlow(ctx, g, lv, vb, hue);
    this.drawCurrents(ctx, g, vb);
    this.drawMemory(ctx, g, lv, hue, vb, title);
    this.updateFlora(g, lv);
    this.drawFlora(ctx, g, lv, hue, vb);
    this.drawPings(ctx, g, lv, hue, vb);
    this.drawWhiskers(ctx, g, lv, hue);
    this.drawItems(ctx, g, lv, inView);
    this.drawEnemies(ctx, g, lv, inView);
    this.drawPlayer(ctx, g);
    this.drawParticles(ctx, g);
    this.drawSnow(ctx, g, vb, S, 1);          // near layer
    this.drawCompass(ctx, g);
    this.drawFloaters(ctx, g);

    // ---- screen space overlays (fade drawn into the canvas first so the bloom copies darken with it) ----
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    this.drawOverlays(ctx, g, W, H);

    // ---- bloom ----
    const bloomOn = this.quality === 'high';
    if (bloomOn !== this.fx.bloomOn) { this.fx.bloomOn = bloomOn; for (const e of this.fx.bl) e.style.display = bloomOn ? '' : 'none'; }
    if (bloomOn) this.drawBloom();
  }

  /* ================================================================ */
  drawBloom() {
    // 1/2 -> 1/4 -> 1/8 chain; the last two levels are composited over the page by the browser (see makeFx / css)
    const [a, b, c] = this.bloom, [ax, bx, cx] = this.bctx;
    ax.globalCompositeOperation = 'copy'; ax.imageSmoothingEnabled = true; ax.drawImage(this.canvas, 0, 0, a.width, a.height);
    bx.globalCompositeOperation = 'copy'; bx.imageSmoothingEnabled = true; bx.drawImage(a, 0, 0, b.width, b.height);
    cx.globalCompositeOperation = 'copy'; cx.imageSmoothingEnabled = true; cx.drawImage(b, 0, 0, c.width, c.height);
  }

  drawOverlays(ctx, g, W, H) {
    const reduce = g.settings.reduceFlash, fx = this.fx;
    // danger tint + damage flash are DOM layers (opacity only: free on the compositor, and the HUD stays above them)
    let da = 0;
    if (g.danger > 0.05) {
      const beat = reduce ? 0.8 : 0.65 + 0.35 * Math.sin(g.realTime * (5 + g.danger * 8));
      da = g.danger * 0.4 * beat;
    }
    this.fxSet('dng', fx.dng, da);
    const cy = g.state === 'levelend';
    if (fx.cy !== cy) { fx.cy = cy; fx.fl.classList.toggle('cy', cy); }
    this.fxSet('fl', fx.fl, g.flash > 0 ? g.flash * (reduce ? 0.12 : 0.4) : 0);
    if (g.state === 'levelend') {
      const a = clamp((g.stateT - 0.9) / 1.0, 0, 1);
      if (a > 0) this.drawFade(ctx, W, H, a, g.exitObj.x, g.exitObj.y, '2,10,14');
    } else if (g.state === 'dying') {
      const a = clamp((g.stateT - 0.6) / 1.8, 0, 1);
      if (a > 0) this.drawFade(ctx, W, H, a * 0.94, g.player.x, g.player.y, '8,0,0');
    }
  }

  // darkness closes in on a world point (the gate when you finish a depth, your hull when you die)
  drawFade(ctx, W, H, a, wx, wy, rgb) {
    const cam = this.game.cam, S = this.S;
    const sx = W / 2 + (wx - cam.x - cam.sx) * S, sy = H / 2 + (wy - cam.y - cam.sy) * S;
    const far = Math.hypot(Math.max(sx, W - sx), Math.max(sy, H - sy));
    const e = a * a * (3 - 2 * a);
    if (e >= 0.995) { ctx.fillStyle = `rgb(${rgb})`; ctx.fillRect(0, 0, W, H); return; }
    const rIn = far * (1 - e), rOut = rIn + far * 0.5 * (1 - e) + 2;
    const gr = ctx.createRadialGradient(sx, sy, rIn, sx, sy, rOut);
    gr.addColorStop(0, `rgba(${rgb},0)`); gr.addColorStop(1, `rgba(${rgb},${Math.min(1, 0.55 + e)})`);
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    if (e > 0.5) { ctx.fillStyle = `rgba(${rgb},${(e - 0.5) * 2 * 0.9})`; ctx.fillRect(0, 0, W, H); }
  }

  /* ================================================================ */
  // out-of-focus orbs on a slow parallax: depth and life without noise
  drawBokeh(ctx, g, vb, hue, title) {
    if (!this.orbSpr || this.orbHue !== hue) {
      this.orbHue = hue;
      const s = this.orbSpr || (this.orbSpr = document.createElement('canvas'));
      s.width = s.height = 64;
      const x = s.getContext('2d');
      const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, hsla(hue, 70, 62, 0.9)); gr.addColorStop(0.45, hsla(hue, 70, 55, 0.35)); gr.addColorStop(1, hsla(hue, 70, 50, 0));
      x.clearRect(0, 0, 64, 64); x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    }
    const w = vb.x1 - vb.x0, h = vb.y1 - vb.y0, t = g.realTime, cam = g.cam;
    const base = title ? 0.07 : 0.034;
    for (let i = 0; i < this.orbs.length; i++) {
      const m = this.orbs[i], par = m.par;
      const wx = cam.x + ((((m.ox * w + m.vx * t - cam.x * par) % w) + w) % w) - w / 2;
      const wy = cam.y + ((((m.oy * h + m.vy * t - cam.y * par) % h) + h) % h) - h / 2;
      ctx.globalAlpha = base * (0.6 + 0.4 * Math.sin(t * 0.5 + m.tw));
      ctx.drawImage(this.orbSpr, wx - m.s, wy - m.s, m.s * 2, m.s * 2);
    }
    ctx.globalAlpha = 1;
  }

  drawSnow(ctx, g, vb, S, layer) {
    const w = vb.x1 - vb.x0, h = vb.y1 - vb.y0, t = g.realTime;
    const pings = g.pings;
    const hue = g.lv.biome.hue;
    for (let i = 0; i < this.snow.length; i++) {
      const m = this.snow[i];
      if ((m.par === 1) !== (layer === 0)) continue;
      const par = m.par;
      // world-anchored for par=1, camera-relative parallax otherwise
      let wx, wy;
      if (par === 1) {
        wx = vb.x0 + (((m.ox * w + m.vx * t) % w) + w) % w;
        wy = vb.y0 + (((m.oy * h + m.vy * t) % h) + h) % h;
      } else {
        const px = g.cam.x * par, py = g.cam.y * par;
        wx = g.cam.x + ((((m.ox * w + m.vx * t - px) % w) + w) % w) - w / 2;
        wy = g.cam.y + ((((m.oy * h + m.vy * t - py) % h) + h) % h) - h / 2;
      }
      let a = 0.1 + 0.07 * Math.sin(t * 1.3 + m.tw);
      if (par === 1) {
        for (let k = 0; k < pings.length; k++) {
          const p = pings[k];
          if (p.r >= p.maxR) continue;
          const dx = wx - p.x, dy = wy - p.y, d2 = dx * dx + dy * dy;
          if (d2 >= p.r * p.r) continue;
          const d = Math.sqrt(d2);
          if (p.r - d < 34) a += 0.8 * (1 - (p.r - d) / 34) * (1 - p.r / p.maxR);
        }
      }
      if (a < 0.05) continue;
      ctx.fillStyle = hc(hue, 60, 75, Math.min(1, a) * (layer ? 0.6 : 1));
      const s = m.s * (layer ? 1.2 : 0.9);
      ctx.fillRect(wx - s / 2, wy - s / 2, s, s);
    }
  }

  drawCurrents(ctx, g, vb) {
    const lv = g.lv;
    if (!lv.currents.length) return;
    const t = g.realTime;
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.4;
    for (const c of lv.currents) {
      if (c.x + c.r < vb.x0 || c.x - c.r > vb.x1 || c.y + c.r < vb.y0 || c.y - c.r > vb.y1) continue;
      const dx = Math.cos(c.ang), dy = Math.sin(c.ang);
      for (let i = 0; i < 26; i++) {
        const u = ((i * 0.6180339 + t * (0.05 + c.force / 1400)) % 1);
        const v = (((i * 0.7548776) % 1) - 0.5) * 2 * 0.86;
        const px = c.x + dx * (u - 0.5) * 2 * c.r - dy * v * c.r;
        const py = c.y + dy * (u - 0.5) * 2 * c.r + dx * v * c.r;
        const edge = Math.sqrt(Math.max(0, 1 - ((u - 0.5) * 2) ** 2 - v * v));
        if (edge <= 0) continue;
        ctx.strokeStyle = hc(lv.biome.hue + 20, 80, 70, 0.22 * edge);
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + dx * 16, py + dy * 16); ctx.stroke();
      }
    }
  }

  // Title only: the whole demo cave as a soft luminous silhouette (a pre-blurred rim of its signed distance field).
  drawCaveGlow(ctx, g, lv, vb, hue) {
    if (!this.glow) {
      const W = lv.W, H = lv.H, c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d'), im = x.createImageData(W, H), d = im.data, sdf = lv.sdf;
      const [cr, cg, cb] = hsl2rgb(hue, 0.9, 0.6);
      for (let i = 0; i < W * H; i++) {
        const s = sdf[i];
        const rim = Math.exp(-Math.abs(s) / 9) * (s < 0 ? 0.5 : 0.62);
        const vol = s > 0 ? 0.075 * Math.min(1, s / 36) : 0;
        d[i * 4] = cr; d[i * 4 + 1] = cg; d[i * 4 + 2] = cb; d[i * 4 + 3] = Math.min(1, rim + vol) * 255;
      }
      x.putImageData(im, 0, 0);
      this.glow = c;
    }
    const k = 1 / 8, W = lv.W, H = lv.H;
    const sx = Math.max(0, vb.x0 * k), sy = Math.max(0, vb.y0 * k);
    const sw = Math.min(W, vb.x1 * k) - sx, sh = Math.min(H, vb.y1 * k) - sy;
    if (sw <= 0 || sh <= 0) return;
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.62 + 0.12 * Math.sin(g.realTime * 0.8);
    ctx.drawImage(this.glow, sx, sy, sw, sh, sx * 8, sy * 8, sw * 8, sh * 8);
    ctx.globalAlpha = 1;
  }

  /* ---------------- persistent memory map (vector) ---------------- */
  // Pair up adjacent rays that hit the same continuous wall (cached on the ping).
  linkRays(p, lv) {
    const n = p.n, hk = p.hk, hx = p.hx, hy = p.hy;
    const lk = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const j = i === 0 ? n - 1 : i - 1;
      if (hk[i] !== HK.WALL || hk[j] !== HK.WALL) continue;
      const dx = hx[i] - hx[j], dy = hy[i] - hy[j], d2 = dx * dx + dy * dy;
      if (d2 > 3600) continue;
      // a chord that follows the surface keeps close to it; one that bridges two walls does not
      if (d2 > 49 && sdfAt(lv, (hx[i] + hx[j]) * 0.5, (hy[i] + hy[j]) * 0.5) > 3.4) continue;
      lk[i] = 1;
    }
    p._lk = lk;
    return lk;
  }

  // Turn a ping's wall hits into >=3 unit polyline segments, ordered by the radius at which the wave reveals them.
  buildChains(p, lv) {
    const n = p.n, hd = p.hd, hk = p.hk, hx = p.hx, hy = p.hy;
    const lk = p._lk || this.linkRays(p, lv);
    let start = 0;
    for (let i = 0; i < n; i++) if (!lk[i]) { start = i; break; }
    const segs = [];
    const gv = { x: 0, y: 0 };
    const push = (a, b, rev) => {
      gradAt(lv, (hx[a] + hx[b]) * 0.5, (hy[a] + hy[b]) * 0.5, gv);   // points into open water: the rock is the other way
      segs.push({ x0: hx[a], y0: hy[a], x1: hx[b], y1: hy[b], dx: -gv.x, dy: -gv.y, rev });
    };
    let a = -1, last = -1, rev = 0, cnt = 0, had = false;
    const flush = () => { if (a >= 0 && (cnt > 0 || !had)) push(a, last, rev); a = -1; cnt = 0; had = false; };
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (hk[i] !== HK.WALL) { flush(); continue; }
      if (a >= 0 && lk[i]) {
        last = i; cnt++; if (hd[i] > rev) rev = hd[i];
        const dx = hx[i] - hx[a], dy = hy[i] - hy[a];
        if (dx * dx + dy * dy >= 9) { push(a, i, rev); had = true; a = i; last = i; rev = hd[i]; cnt = 0; }
      } else { flush(); a = i; last = i; rev = hd[i]; }
    }
    flush();
    segs.sort((u, v) => u.rev - v.rev);
    return { segs, i: 0 };
  }

  memAdd(s) {
    // skip stretches of wall we already hold (1.5-unit occupancy grid) so repeated pings do not pile up geometry
    const occ = this.mocc, ow = this.mow, oh = this.moh;
    const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0), steps = Math.max(1, Math.ceil(len / 1.2));
    let fresh = false;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const cx = clamp(((s.x0 + (s.x1 - s.x0) * t) * MIC) | 0, 0, ow - 1), cy = clamp(((s.y0 + (s.y1 - s.y0) * t) * MIC) | 0, 0, oh - 1);
      const idx = cy * ow + cx;
      if (!occ[idx]) { fresh = true; occ[idx] = 1; }
    }
    if (!fresh) return;
    const mx = clamp(((s.x0 + s.x1) * 0.5 / MCELL) | 0, 0, this.mcw - 1), my = clamp(((s.y0 + s.y1) * 0.5 / MCELL) | 0, 0, this.mch - 1);
    let c = this.mcells[my * this.mcw + mx];
    if (!c) c = this.mcells[my * this.mcw + mx] = { a: new Float32Array(192), n: 0, core: null, halo: null, haloW: null, hatch: null, dirty: true };
    if (c.n + 6 > c.a.length) { const b = new Float32Array(c.a.length * 2); b.set(c.a); c.a = b; }
    const a = c.a, k = c.n;
    a[k] = s.x0; a[k + 1] = s.y0; a[k + 2] = s.x1; a[k + 3] = s.y1; a[k + 4] = s.dx; a[k + 5] = s.dy;
    c.n += 6; c.dirty = true;
  }

  memBuild(c) {
    const a = c.a, n = c.n;
    const core = new Path2D(), halo = new Path2D(), haloW = new Path2D(), hatch = new Path2D();
    for (let k = 0; k < n; k += 6) {
      const x0 = a[k], y0 = a[k + 1], x1 = a[k + 2], y1 = a[k + 3], dx = a[k + 4], dy = a[k + 5];
      core.moveTo(x0, y0); core.lineTo(x1, y1);
      // the glow strokes are wide and overlap their neighbours, so they are fed from every 2nd / 4th segment only
      const si = k / 6, long = Math.abs(x1 - x0) + Math.abs(y1 - y0) > 9;
      if ((si & 1) === 0 || long) { halo.moveTo(x0 + dx * 5.5, y0 + dy * 5.5); halo.lineTo(x1 + dx * 5.5, y1 + dy * 5.5); }
      if ((si & 3) === 0 || long) { haloW.moveTo(x0 + dx * 5.5, y0 + dy * 5.5); haloW.lineTo(x1 + dx * 5.5, y1 + dy * 5.5); }
      // sparse, uneven ticks leaning into the rock read as a cliff face rather than a fence
      const h = Math.imul(k + 7, 2654435761) >>> 24;
      if (h & 1) continue;
      const mx = (x0 + x1) * 0.5 + dx * 2.5, my = (y0 + y1) * 0.5 + dy * 2.5;
      const L = 3 + (h >> 1) % 6;
      hatch.moveTo(mx, my); hatch.lineTo(mx + dx * L, my + dy * L);
    }
    c.core = core; c.halo = halo; c.haloW = haloW; c.hatch = hatch; c.dirty = false;
  }

  drawMemory(ctx, g, lv, hue, vb, title) {
    // reveal wall segments as the wavefronts reach them
    for (const p of g.pings) {
      if (p.kind === 'death') continue;
      const q = p._mq || (p._mq = this.buildChains(p, lv));
      const segs = q.segs, r = p.r;
      while (q.i < segs.length && segs[q.i].rev <= r) this.memAdd(segs[q.i++]);
    }
    const boost = g.run ? g.stats.memory : 1;
    const A = clamp(0.62 + 0.2 * (boost - 1), 0.5, 1) / 0.62;
    // which cells overlap the view
    const vis = this.mvis; vis.length = 0;
    const cw = this.mcw, ch = this.mch;
    const x0 = Math.max(0, Math.floor((vb.x0 - MPAD) / MCELL)), x1 = Math.min(cw - 1, Math.floor((vb.x1 + MPAD) / MCELL));
    const y0 = Math.max(0, Math.floor((vb.y0 - MPAD) / MCELL)), y1 = Math.min(ch - 1, Math.floor((vb.y1 + MPAD) / MCELL));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const c = this.mcells[y * cw + x];
      if (!c) continue;
      if (c.dirty) this.memBuild(c);
      vis.push(c);
    }
    if (!vis.length) return;
    const tb = title ? 1.35 : 1;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = hc(hue, 80, 52, 1);   // glow bleeding into the rock, soft edged (wide + narrow pass)
    ctx.lineWidth = 17; ctx.globalAlpha = Math.min(1, 0.05 * A * tb);
    for (let i = 0; i < vis.length; i++) ctx.stroke(vis[i].haloW);
    ctx.lineWidth = 8; ctx.globalAlpha = Math.min(1, 0.075 * A * tb);
    for (let i = 0; i < vis.length; i++) ctx.stroke(vis[i].halo);
    ctx.strokeStyle = hc(hue, 85, 70, 1); ctx.lineWidth = 0.8; ctx.globalAlpha = Math.min(1, 0.17 * A * tb);      // cliff hatching
    for (let i = 0; i < vis.length; i++) ctx.stroke(vis[i].hatch);
    ctx.strokeStyle = hc(hue, 85, 68, 1); ctx.lineWidth = 1.4; ctx.globalAlpha = Math.min(1, 0.48 * A * tb);     // the mapped contour
    for (let i = 0; i < vis.length; i++) ctx.stroke(vis[i].core);
    ctx.globalAlpha = 1;
  }

  // debug/dev helper: paint the whole cave into the memory map
  revealAll() {
    const lv = this.game.lv, W = lv.W, H = lv.H, s = lv.sdf;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x, s0 = s[i];
        if (s0 < 0 || s0 >= 3.2) continue;
        let gx = s[i + 1] - s[i - 1], gy = s[i + W] - s[i - W];
        const m = Math.hypot(gx, gy) || 1; gx /= m; gy /= m;
        const px = (x + 0.5) * 8, py = (y + 0.5) * 8;
        this.memAdd({ x0: px, y0: py, x1: px + gy * 6, y1: py - gx * 6, dx: -gx, dy: -gy });
      }
    }
  }

  updateFlora(g, lv) {
    const fl = lv.flora, nf = fl.length;
    const dt = clamp(g.realTime - this.lastT, 0, 0.25);
    this.lastT = g.realTime;
    for (let i = 0; i < nf; i++) fl[i].lit = Math.max(0, fl[i].lit - dt * 0.75);
    for (const p of g.pings) {
      if (p.quiet && p.kind === 'death') continue;
      const prev = this.lastPingR.get(p) || 0;
      this.lastPingR.set(p, p.r);
      if (p.r > p.maxR) continue;
      const hi = p.r + 6, lo = prev - 6, hi2 = hi * hi, lo2 = lo > 0 ? lo * lo : -1, mx2 = p.maxR * p.maxR;
      for (let i = 0; i < nf; i++) {
        const f = fl[i];
        const dx = f.x - p.x, dy = f.y - p.y, d2 = dx * dx + dy * dy;
        if (d2 > hi2 || d2 < lo2 || d2 > mx2) continue;
        const d = Math.sqrt(d2);
        const a = Math.atan2(dy, dx) - p.off;
        const k = Math.round(((a % TAU) + TAU) % TAU / (TAU / p.n)) % p.n;
        if (p.hd[k] + 22 >= d) f.lit = Math.max(f.lit, 1 - 0.55 * (d / p.maxR));
      }
    }
  }

  drawFlora(ctx, g, lv, hue, vb) {
    const p = g.player, t = g.realTime;
    ctx.lineCap = 'round';
    const fl = lv.flora, fcl = this.fcl, grp = this.fgrp;
    // pass 1: visible plants, grouped by (type, hue step, brightness step) so each group is one path and one stroke
    for (const arr of grp.values()) arr.length = 0;
    for (let i = 0; i < fl.length; i++) {
      const f = fl[i];
      if (f.x < vb.x0 || f.x > vb.x1 || f.y < vb.y0 || f.y > vb.y1) continue;
      const dx0 = f.x - p.x, dy0 = f.y - p.y;
      const near = clamp((340 - Math.sqrt(dx0 * dx0 + dy0 * dy0)) / 170, 0, 1);
      const a = Math.max(f.lit, near * 0.2);
      if (a < 0.03) continue;
      const key = (f.type * 16 + Math.round(f.hue / 12) + 4) * 32 + Math.max(1, Math.min(16, Math.round(a * 16)));
      let arr = grp.get(key);
      if (!arr) grp.set(key, arr = []);
      arr.push(i);
    }
    // pass 2: one batch per group
    for (const [key, arr] of grp) {
      const m = arr.length;
      if (!m) continue;
      const A = (key & 31) / 16, h = hue + (((key >> 5) & 15) - 4) * 12, type = key >> 9;
      if (this.tp.length < m * 24) this.tp = new Float32Array(m * 24);
      const tp = this.tp;
      let nt = 0;
      ctx.beginPath();
      for (let q = 0; q < m; q++) {
        const i = arr[q], f = fl[i];
        const sway = Math.sin(t * 1.1 + f.phase);
        const room = Math.max(8, fcl[i] - 10), len = Math.min(f.len, room);   // never grow through the far wall
        const base = Math.atan2(f.ny, f.nx);
        if (type === 0) { // kelp
          const sw = Math.min(1, room / 40), dim = A < 0.3;   // faint ambient plants: every other stalk, drawn straight
          for (let k = 0; k < f.n; k += dim ? 2 : 1) {
            const ang = base + (k - (f.n - 1) / 2) * 0.28;
            const L = len * (0.7 + 0.3 * ((k * 7 + i) % 3) / 2);
            const ex = f.x + Math.cos(ang) * L + sway * 9 * sw * (1 + k * 0.2), ey = f.y + Math.sin(ang) * L - 4 * sw;
            ctx.moveTo(f.x, f.y);
            if (dim) ctx.lineTo(ex, ey);
            else ctx.quadraticCurveTo(f.x + Math.cos(ang) * L * 0.5 - sway * 7 * sw, f.y + Math.sin(ang) * L * 0.5, ex, ey);
            tp[nt++] = ex; tp[nt++] = ey;
          }
        } else if (type === 1) { // coral
          for (let k = 0; k < f.n; k++) {
            const ang = base + (k - (f.n - 1) / 2) * 0.62 + sway * 0.05;
            const L = len * (0.6 + 0.4 * ((k + i) % 2));
            const ex = f.x + Math.cos(ang) * L, ey = f.y + Math.sin(ang) * L;
            ctx.moveTo(f.x, f.y); ctx.lineTo(ex, ey);
            tp[nt++] = ex; tp[nt++] = ey;
          }
        } else { // glowing bulb on a stalk
          const bx = f.x + f.nx * len + sway * 2, by = f.y + f.ny * len;
          ctx.moveTo(f.x, f.y); ctx.lineTo(bx, by);
          tp[nt++] = bx; tp[nt++] = by; tp[nt++] = 2.6 + 1.6 * (0.5 + 0.5 * Math.sin(t * 2 + f.phase));
        }
      }
      if (type === 0) {
        ctx.strokeStyle = hc(h, 90, 62, A * 0.8); ctx.lineWidth = 1.6; ctx.stroke();
        ctx.beginPath();
        for (let u = 0; u < nt; u += 2) ctx.rect(tp[u] - 1.3, tp[u + 1] - 1.3, 2.6, 2.6);
        ctx.fillStyle = hc(h + 10, 100, 78, A); ctx.fill();
      } else if (type === 1) {
        ctx.strokeStyle = hc(h, 95, 64, A * 0.85); ctx.lineWidth = 1.4; ctx.stroke();
        ctx.beginPath();
        for (let u = 0; u < nt; u += 2) { ctx.moveTo(tp[u] + 2.2, tp[u + 1]); ctx.arc(tp[u], tp[u + 1], 2.2, 0, TAU); }
        ctx.fillStyle = hc(h + 8, 100, 80, A); ctx.fill();
      } else {
        ctx.strokeStyle = hc(h, 80, 55, A * 0.6); ctx.lineWidth = 1.2; ctx.stroke();
        if (A >= 0.25) {   // the soft halo only matters once the bulb is actually lit
          ctx.beginPath();
          for (let u = 0; u < nt; u += 3) { ctx.moveTo(tp[u] + tp[u + 2] * 2.4, tp[u + 1]); ctx.arc(tp[u], tp[u + 1], tp[u + 2] * 2.4, 0, TAU); }
          ctx.fillStyle = hc(h, 100, 70, A * 0.35); ctx.fill();
        }
        ctx.beginPath();
        for (let u = 0; u < nt; u += 3) { ctx.moveTo(tp[u] + tp[u + 2] * 0.9, tp[u + 1]); ctx.arc(tp[u], tp[u + 1], tp[u + 2] * 0.9, 0, TAU); }
        ctx.fillStyle = hc(h + 15, 100, 88, A); ctx.fill();
      }
    }
  }

  /* ================================================================ */
  pingHue(p, hue) {
    switch (p.kind) {
      case 'buoy': return 176;
      case 'impact': return 18;
      case 'death': return 4;
      case 'victory': return 52;
      default: return hue;
    }
  }

  drawPings(ctx, g, lv, hue, vb) {
    const wave = PING.speed;
    for (const p of g.pings) {
      const ph = this.pingHue(p, hue);
      const travelEnd = p.maxR / wave;
      const afterWave = Math.max(0, p.age - travelEnd);
      const vis = clamp(1 - afterWave / 1.1, 0, 1);
      const k = clamp(1 - p.r / p.maxR, 0, 1);
      const qa = p.quiet ? 0.7 : 1;
      // nothing of this ping can be on screen
      const Rb = Math.min(p.r, p.maxR) + 24;
      if (p.x + Rb < vb.x0 || p.x - Rb > vb.x1 || p.y + Rb < vb.y0 || p.y - Rb > vb.y1) continue;
      if (!p._lk) this.linkRays(p, lv);
      if (p.r < p.maxR + 40 && vis > 0) this.pingVolume(ctx, p, ph, k, qa, vis, vb);
      if (p.r < p.maxR) this.pingFront(ctx, p, ph, k, qa, vb);
      this.pingEchoes(ctx, p, ph, qa, vb, wave);
    }
  }

  // lit water: a band that trails the wavefront (cheaper than lighting the whole disc, and reads as a pulse)
  pingVolume(ctx, p, ph, k, qa, vis, vb) {
    const n = p.n, r = Math.min(p.r, p.maxR);
    if (r < 6) return;
    const x = p.x, y = p.y, hd = p.hd, cs = p.cosA, sn = p.sinA;
    const Wd = Math.max(46, r * 0.3), ri = r > Wd ? r - Wd : 0;
    if (this.act.length < n) { this.act = new Uint8Array(n); this.rbuf = new Int16Array(n); }
    const act = this.act, run = this.rbuf;
    const bx0 = vb.x0 - Wd, bx1 = vb.x1 + Wd, by0 = vb.y0 - Wd, by1 = vb.y1 + Wd;
    let nAct = 0;
    for (let i = 0; i < n; i++) {
      const d = hd[i] < r ? hd[i] : r;
      let on = d > ri + 0.5;
      if (on) { const ox = x + cs[i] * d, oy = y + sn[i] * d; on = ox > bx0 && ox < bx1 && oy > by0 && oy < by1; }
      act[i] = on ? 1 : 0; nAct += act[i];
    }
    if (!nAct) return;
    const gr = ctx.createRadialGradient(x, y, ri, x, y, r);
    gr.addColorStop(0, hsla(ph, 80, 60, 0));
    gr.addColorStop(0.55, hsla(ph, 80, 60, 0.014 * qa * vis));
    gr.addColorStop(1, hsla(ph, 85, 62, (0.05 + 0.1 * k) * qa * vis));
    ctx.fillStyle = gr;
    ctx.beginPath();
    const stride = Math.max(1, (n / 80) | 0);
    if (nAct === n) {   // the full ring (or disc)
      const d0 = hd[0] < r ? hd[0] : r;
      ctx.moveTo(x + cs[0] * d0, y + sn[0] * d0);
      for (let i = 1; i < n; i++) { const d = hd[i] < r ? hd[i] : r; ctx.lineTo(x + cs[i] * d, y + sn[i] * d); }
      ctx.closePath();
      if (ri > 0) {
        ctx.moveTo(x + cs[n - 1] * ri, y + sn[n - 1] * ri);
        for (let i = n - 1; i >= 0; i -= stride) ctx.lineTo(x + cs[i] * ri, y + sn[i] * ri);
        ctx.closePath();
      }
    } else {
      let s = 0;
      for (let i = 0; i < n; i++) if (act[i] && !act[i === 0 ? n - 1 : i - 1]) { s = i; break; }
      let m = 0;
      for (let q = 0; q <= n; q++) {
        const i = (s + q) % n;
        if (q < n && act[i]) { run[m++] = i; continue; }
        if (!m) continue;
        let j = run[0], d = hd[j] < r ? hd[j] : r;
        ctx.moveTo(x + cs[j] * d, y + sn[j] * d);
        for (let u = 1; u < m; u++) { j = run[u]; d = hd[j] < r ? hd[j] : r; ctx.lineTo(x + cs[j] * d, y + sn[j] * d); }
        if (ri > 0) {
          for (let u = m - 1; u >= 0; u -= stride) { j = run[u]; ctx.lineTo(x + cs[j] * ri, y + sn[j] * ri); }
          j = run[0]; ctx.lineTo(x + cs[j] * ri, y + sn[j] * ri);
        } else ctx.lineTo(x, y);
        ctx.closePath();
        m = 0;
      }
    }
    ctx.fill();
  }

  pingFront(ctx, p, ph, k, qa, vb) {
    const n = p.n, r = p.r, hd = p.hd, x = p.x, y = p.y, cs = p.cosA, sn = p.sinA;
    ctx.beginPath();
    let pen = false, fx = 0, fy = 0, hasFirst = false;
    for (let i = 0; i < n; i++) {
      if (hd[i] > r) {
        const px = x + cs[i] * r, py = y + sn[i] * r;
        if (px < vb.x0 || px > vb.x1 || py < vb.y0 || py > vb.y1) { pen = false; continue; }
        if (pen) ctx.lineTo(px, py); else { ctx.moveTo(px, py); pen = true; }
        if (i === 0) { fx = px; fy = py; hasFirst = true; }
      } else pen = false;
    }
    if (pen && hasFirst) ctx.lineTo(fx, fy);   // close the seam where the ray fan wraps
    ctx.lineCap = 'round';
    ctx.strokeStyle = hsla(ph, 90, 70, 0.16 * k * qa); ctx.lineWidth = 9; ctx.stroke();
    ctx.strokeStyle = hsla(ph, 95, 82, 0.85 * Math.pow(k, 0.7) * qa); ctx.lineWidth = 1.7; ctx.stroke();
  }

  // echoes: walls (bucketed by brightness), then things
  pingEchoes(ctx, p, ph, qa, vb, wave) {
    const n = p.n, hd = p.hd, hx = p.hx, hy = p.hy, hk = p.hk, sh = p.sh, lk = p._lk;
    if (this.bk.length < n) { this.bk = new Uint8Array(n); for (let b = 0; b < BUCKETS; b++) this.bidx[b] = new Int16Array(n); }
    const bk = this.bk, bidx = this.bidx, bn = this.bn, dots = this.dots.length >= n ? this.dots : (this.dots = new Int16Array(n));
    bn.fill(0);
    const tau = p.quiet ? 0.8 : 1.0;
    const r = p.r, age = p.age, maxR = p.maxR;
    const x0 = vb.x0, x1 = vb.x1, y0 = vb.y0, y1 = vb.y1;
    for (let i = 0; i < n; i++) {
      bk[i] = 255;
      const d = hd[i], kd = hk[i];
      if (kd === HK.NONE || d > r) continue;
      const px = hx[i], py = hy[i];
      if (px < x0 || px > x1 || py < y0 || py > y1) continue;
      const since = age - d / wave;
      if (kd === HK.WALL) {
        const a = Math.exp(-since / tau) * (0.28 + 0.72 * sh[i]) * (1 - 0.5 * d / maxR) * qa;
        if (a < 0.05) continue;
        const b = Math.min(BUCKETS - 1, (a * BUCKETS * 1.05) | 0);
        bk[i] = b; bidx[b][bn[b]++] = i;
      } else {
        // threats, loot, gate
        const a = Math.exp(-since / 1.5) * (0.35 + 0.65 * sh[i]);
        if (a < 0.04) continue;
        ctx.fillStyle = kd === HK.THREAT ? hc(THREAT_H, 100, 62, a) : kd === HK.PEARL ? hc(GOLD_H, 100, 70, a) : kd === HK.EXIT ? hc(165, 100, 85, a) : hc(180, 90, 75, a);
        ctx.fillRect(px - 1.7, py - 1.7, 3.4, 3.4);
      }
    }
    ctx.lineCap = 'round';
    for (let b = 2; b < BUCKETS; b++) {   // dimmer echoes are no brighter than the memory map beneath, so they are not drawn twice
      const m = bn[b];
      if (!m) continue;
      const list = bidx[b], alpha = (b + 0.7) / BUCKETS;
      ctx.beginPath();
      // contiguous runs of rays become polylines; points closer than ~2 units to the last vertex are dropped (dense near walls)
      let prev = -2, ax = 0, ay = 0, dn = 0;
      for (let q = 0; q < m; q++) {
        const i = list[q], j = i === 0 ? n - 1 : i - 1;
        if (!lk[i] || bk[j] === 255) { prev = -2; if (!lk[i] && !lk[i === n - 1 ? 0 : i + 1]) dots[dn++] = i; continue; }   // lone hits keep their bead
        if (prev !== j) { ctx.moveTo(hx[j], hy[j]); ax = hx[j]; ay = hy[j]; }
        const dx = hx[i] - ax, dy = hy[i] - ay;
        if (dx * dx + dy * dy >= 4) { ctx.lineTo(hx[i], hy[i]); ax = hx[i]; ay = hy[i]; dots[dn++] = i; }
        prev = i;
      }
      if (b >= 3) { ctx.strokeStyle = hc(ph, 90, 66, alpha * 0.16); ctx.lineWidth = 7; ctx.stroke(); }
      ctx.strokeStyle = hc(ph, 90, 70, alpha * 0.7); ctx.lineWidth = 1.5; ctx.stroke();
      if (b >= 3 && dn) {   // bright beads on the freshest echoes, only at the vertices that were actually drawn
        ctx.beginPath();
        for (let q = 0; q < dn; q++) { const i = dots[q]; ctx.rect(hx[i] - 1.3, hy[i] - 1.3, 2.6, 2.6); }
        ctx.fillStyle = hc(ph, 80, 84, Math.min(1, alpha * 1.1)); ctx.fill();
      }
    }
  }

  drawWhiskers(ctx, g, lv, hue) {
    const p = g.player;
    if (p.dead || g.state === 'title') return;
    const N = 26, R = 46;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU + g.realTime * 0.15;
      const c = Math.cos(a), s = Math.sin(a);
      const d = rayMarch(lv, p.x, p.y, c, s, R);
      if (d >= R - 0.5) continue;
      const al = (1 - d / R) * 0.5;
      ctx.fillStyle = hc(hue, 90, 78, al);
      ctx.fillRect(p.x + c * d - 1.2, p.y + s * d - 1.2, 2.4, 2.4);
    }
  }

  /* ================================================================ */
  drawItems(ctx, g, lv, inView) {
    const t = g.realTime, gt = g.time, p = g.player;
    const dowse = g.run ? g.stats.dowse : 0;
    // pickups
    for (const pk of g.pickups) {
      if (pk.taken || !inView(pk.x, pk.y)) continue;
      const since = gt - pk.seen;
      let a = since < 3.2 ? Math.exp(-since / 1.4) : 0;
      const d = Math.hypot(pk.x - p.x, pk.y - p.y);
      const sense = pk.type === 'pearl' ? 70 + dowse * 130 : 60;
      if (d < sense) a = Math.max(a, 0.5 * (1 - d / sense) + 0.15 + 0.12 * Math.sin(t * 5 + pk.phase));
      if (a < 0.04) continue;
      if (pk.type === 'pearl') {
        ctx.fillStyle = hc(GOLD_H, 100, 60, a * 0.28); ctx.beginPath(); ctx.arc(pk.x, pk.y, 9, 0, TAU); ctx.fill();
        ctx.fillStyle = hc(GOLD_H + 4, 100, 82, a); ctx.beginPath(); ctx.arc(pk.x, pk.y, 3.3, 0, TAU); ctx.fill();
        ctx.strokeStyle = hc(GOLD_H, 100, 85, a * 0.7); ctx.lineWidth = 1;
        const gl = 6 + 2 * Math.sin(t * 4 + pk.phase);
        ctx.beginPath(); ctx.moveTo(pk.x - gl, pk.y); ctx.lineTo(pk.x + gl, pk.y); ctx.moveTo(pk.x, pk.y - gl); ctx.lineTo(pk.x, pk.y + gl); ctx.stroke();
      } else if (pk.type === 'buoy') {
        ctx.strokeStyle = hc(176, 95, 70, a); ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(pk.x, pk.y, 6, 0, TAU); ctx.stroke();
        ctx.fillStyle = hc(176, 100, 80, a); ctx.beginPath(); ctx.arc(pk.x, pk.y, 2.2, 0, TAU); ctx.fill();
      } else {
        ctx.strokeStyle = hc(135, 95, 68, a); ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.moveTo(pk.x - 6, pk.y); ctx.lineTo(pk.x + 6, pk.y); ctx.moveTo(pk.x, pk.y - 6); ctx.lineTo(pk.x, pk.y + 6); ctx.stroke();
      }
    }
    // placed decoys
    for (const b of g.buoys) {
      const ph = (b.beep / 0.95);
      ctx.strokeStyle = hc(176, 95, 72, 0.7); ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(b.x, b.y, 5 + 2 * Math.sin(t * 6), 0, TAU); ctx.stroke();
      ctx.fillStyle = hc(176, 100, 82, 0.9); ctx.beginPath(); ctx.arc(b.x, b.y, 2.4, 0, TAU); ctx.fill();
      ctx.strokeStyle = hc(176, 95, 72, 0.4 * ph); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(b.x, b.y, 8 + (1 - ph) * 26, 0, TAU); ctx.stroke();
    }
    // exit gate: always faintly alive
    const ex = g.exitObj;
    if (inView(ex.x, ex.y, 60)) {
      const since = gt - ex.seen;
      const a = 0.26 + 0.1 * Math.sin(t * 1.6) + (since < 3 ? 0.55 * Math.exp(-since / 1.2) : 0);
      this.drawGate(ctx, ex.x, ex.y, a, t);
    }
  }

  drawGate(ctx, x, y, a, t) {
    const g = ctx;
    g.lineCap = 'round';
    const r = 20;
    g.fillStyle = hc(165, 100, 70, a * 0.14); g.beginPath(); g.arc(x, y, r * 2.4, 0, TAU); g.fill();
    g.strokeStyle = hc(168, 100, 82, a); g.lineWidth = 2.2;
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.stroke();
    g.lineWidth = 1.6; g.strokeStyle = hc(185, 100, 78, a * 0.9);
    g.setLineDash([5, 7]); g.lineDashOffset = -t * 14;
    g.beginPath(); g.arc(x, y, r * 1.45, 0, TAU); g.stroke();
    g.setLineDash([2, 9]); g.lineDashOffset = t * 10;
    g.beginPath(); g.arc(x, y, r * 1.9, 0, TAU); g.stroke();
    g.setLineDash([]);
    g.fillStyle = hc(165, 100, 92, a * 0.8); g.beginPath(); g.arc(x, y, 3.4, 0, TAU); g.fill();
    g.fillStyle = hc(165, 100, 90, a * 0.9);
    for (let i = 0; i < 4; i++) {
      const aa = t * 0.7 + i * TAU / 4;
      g.fillRect(x + Math.cos(aa) * r - 1.5, y + Math.sin(aa) * r - 1.5, 3, 3);
    }
  }

  /* ================================================================ */
  drawEnemies(ctx, g, lv, inView) {
    const life = 4.6 * (g.run ? g.stats.ghostLife : 1);
    const t = g.time, rt = g.realTime, calm = g.settings.reduceFlash;
    for (const e of g.enemies) {
      // angler lure is a real light you can always see
      if (e.type === 'angler') {
        const l = e.lure();
        if (inView(l.x, l.y)) {
          const fl = calm ? 0.85 : 0.6 + 0.4 * Math.sin(rt * 7.3 + e.id) * Math.sin(rt * 3.1);
          const wf = l.flare || 0;   // wind-up before a lunge: the lure flares
          ctx.fillStyle = hc(40, 100, 60, Math.min(0.9, 0.22 * fl + 0.55 * wf)); ctx.beginPath(); ctx.arc(l.x, l.y, 20 + 26 * wf, 0, TAU); ctx.fill();
          ctx.fillStyle = hc(46, 100, 72, 0.5 * fl); ctx.beginPath(); ctx.arc(l.x, l.y, 7, 0, TAU); ctx.fill();
          if (wf > 0) { ctx.fillStyle = hc(50, 100, 92, 0.9 * wf); ctx.beginPath(); ctx.arc(l.x, l.y, 4 + 6 * wf, 0, TAU); ctx.fill(); }
          ctx.fillStyle = hc(50, 100, 92, 0.95 * fl); ctx.beginPath(); ctx.arc(l.x, l.y, 2.6, 0, TAU); ctx.fill();
        }
      }
      const since = t - e.seen;
      if (since > life || since < 0) continue;
      const k = 1 - since / life;
      const a = Math.pow(k, 1.4);
      if (!inView(e.sx, e.sy, 120)) continue;
      // freshly pinged things flare white-hot, then cool to deep orange as the image fades
      const hot = since < 0.8 ? 1 - since / 0.8 : 0;
      if (since < 0.55) {   // acquisition ring
        const q = since / 0.55, rr = e.r * (1.3 + 2.4 * q);
        ctx.strokeStyle = hc(THREAT_H + 14, 100, 78, 0.55 * (1 - q) * (1 - q)); ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(e.sx, e.sy, rr, 0, TAU); ctx.stroke();
      }
      switch (e.type) {
        case 'jelly': this.drawJelly(ctx, e.sx, e.sy, e.sa, e.sPhase, a, e.r, hot); break;
        case 'urchin': this.drawUrchin(ctx, e.sx, e.sy, e.sPhase, a, e.r, hot); break;
        case 'angler': this.drawAngler(ctx, e.sx, e.sy, e.sa, a, e.r, e, hot); break;
        case 'eel': this.drawSerpent(ctx, e.sSpine || e.spine, e.r, a, false, e.sPhase, hot); break;
        case 'leviathan': this.drawSerpent(ctx, e.sSpine || e.spine, e.r, a, true, e.sPhase, hot); break;
      }
    }
  }

  drawJelly(ctx, x, y, ang, phase, a, r, hot = 0) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(ang);
    const pulse = Math.sin(phase);
    const bw = r * (1.0 + 0.16 * pulse), bh = r * (0.95 - 0.18 * pulse);
    ctx.beginPath();
    for (let i = 0; i <= 20; i++) {
      const th = -Math.PI / 2 + (i / 20) * Math.PI;
      const px = Math.cos(th) * bw, py = Math.sin(th) * bh;
      if (i === 0) ctx.moveTo(px * 0.2, py); else ctx.lineTo(px, py);
    }
    // scalloped back edge
    for (let i = 0; i <= 4; i++) {
      const yy = bh - (i / 4) * 2 * bh;
      ctx.lineTo(-2 + (i % 2) * 3, yy);
    }
    ctx.closePath();
    ctx.fillStyle = hc(THREAT_H + 8, 100, 60, a * 0.16); ctx.fill();
    ctx.strokeStyle = hc(THREAT_H + 6, 100, 66 + 16 * hot, a * 0.95); ctx.lineWidth = 1.8; ctx.stroke();
    // inner glow
    ctx.fillStyle = hc(THREAT_H + 16, 100, 75 + 10 * hot, a * 0.35);
    ctx.beginPath(); ctx.arc(bw * 0.25, 0, r * 0.38, 0, TAU); ctx.fill();
    // tentacles
    ctx.lineWidth = 1.3; ctx.strokeStyle = hc(THREAT_H + 12, 100, 68 + 10 * hot, a * 0.7);
    ctx.beginPath();
    for (let i = -2; i <= 2; i++) {
      const y0 = i * bh * 0.38;
      ctx.moveTo(-1, y0);
      for (let s = 1; s <= 6; s++) {
        const sx = -s * r * 0.34;
        ctx.lineTo(sx, y0 + Math.sin(phase * 1.2 - s * 0.9 + i) * 3.2 * s * 0.5);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  drawUrchin(ctx, x, y, phase, a, r, hot = 0) {
    ctx.strokeStyle = hc(THREAT_H, 100, 64 + 16 * hot, a * 0.95); ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
      const ang = i * TAU / 16 + phase * 0.2;
      const L = r * (i % 2 ? 1.5 : 1.95);
      ctx.moveTo(x + Math.cos(ang) * r * 0.7, y + Math.sin(ang) * r * 0.7);
      ctx.lineTo(x + Math.cos(ang) * L, y + Math.sin(ang) * L);
    }
    ctx.stroke();
    ctx.fillStyle = hc(THREAT_H, 100, 55, a * 0.25); ctx.beginPath(); ctx.arc(x, y, r * 0.85, 0, TAU); ctx.fill();
    ctx.strokeStyle = hc(THREAT_H, 100, 68 + 14 * hot, a); ctx.beginPath(); ctx.arc(x, y, r * 0.85, 0, TAU); ctx.stroke();
  }

  drawAngler(ctx, x, y, ang, a, r, e, hot = 0) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(ang);
    ctx.fillStyle = hc(THREAT_H, 100, 55, a * 0.2);
    ctx.strokeStyle = hc(THREAT_H, 100, 66 + 16 * hot, a); ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.ellipse(0, 0, r * 1.15, r * 0.95, 0, 0, TAU); ctx.fill(); ctx.stroke();
    // jaw & teeth
    ctx.beginPath();
    ctx.moveTo(r * 0.3, -r * 0.55);
    for (let i = 0; i <= 5; i++) {
      const xx = r * (0.35 + i * 0.13);
      ctx.lineTo(xx, (i % 2 ? -1 : 1) * r * 0.1 - r * 0.05);
    }
    ctx.lineTo(r * 0.3, r * 0.55);
    ctx.stroke();
    ctx.fillStyle = hc(THREAT_H + 20, 100, 85, a);
    ctx.beginPath(); ctx.arc(r * 0.1, -r * 0.5, 2.4, 0, TAU); ctx.fill();
    // tail
    ctx.beginPath(); ctx.moveTo(-r * 1.1, 0); ctx.lineTo(-r * 1.9, -r * 0.7); ctx.lineTo(-r * 1.7, 0); ctx.lineTo(-r * 1.9, r * 0.7); ctx.closePath();
    ctx.stroke();
    // stalk to this image's own lure: Angler.lure() sits 38 units along the heading and 6 up (world space), converted to local space
    const s = Math.sin(ang), c = Math.cos(ang);
    const lx = 38 - 6 * s, ly = -6 * c;
    ctx.strokeStyle = hc(46, 100, 70, a * 0.8); ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(r * 0.4, -r * 0.9); ctx.quadraticCurveTo(r * 1.4, -r * 2.0, lx, ly); ctx.stroke();
    ctx.fillStyle = hc(48, 100, 80, a * 0.7); ctx.beginPath(); ctx.arc(lx, ly, 2.2, 0, TAU); ctx.fill();
    ctx.restore();
  }

  drawSerpent(ctx, spine, r, a, big, phase, hot = 0) {
    const n = spine.length;
    if (n < 2) return;
    const L = [], R = [];
    for (let i = 0; i < n; i++) {
      const p = spine[i];
      const q = spine[Math.min(n - 1, i + 1)], o = spine[Math.max(0, i - 1)];
      let tx = q.x - o.x, ty = q.y - o.y;       // head -> tail
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const k = i / (n - 1);
      const w = r * (i === 0 ? 0.95 : (1 - 0.88 * Math.pow(k, 0.85)) + 0.12);
      L.push([p.x - ty * w, p.y + tx * w]); R.push([p.x + ty * w, p.y - tx * w]);
    }
    // forward direction of the head
    const h = spine[0], h2 = spine[1];
    let fx = h.x - h2.x, fy = h.y - h2.y; const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
    ctx.beginPath();
    ctx.moveTo(L[0][0], L[0][1]);
    for (let i = 1; i < n; i++) ctx.lineTo(L[i][0], L[i][1]);
    {   // taper to a point
      const e = spine[n - 1], e2 = spine[n - 2], tx = e.x - e2.x, ty = e.y - e2.y, tl = Math.hypot(tx, ty) || 1;
      ctx.lineTo(e.x + (tx / tl) * r * 0.55, e.y + (ty / tl) * r * 0.55);
    }
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(R[i][0], R[i][1]);
    // rounded snout
    ctx.quadraticCurveTo(h.x + fx * r * 1.75, h.y + fy * r * 1.75, L[0][0], L[0][1]);
    ctx.closePath();
    ctx.fillStyle = hc(THREAT_H, 100, 55, a * (big ? 0.2 : 0.22)); ctx.fill();
    ctx.strokeStyle = hc(THREAT_H, 100, 66 + 16 * hot, a * 0.95); ctx.lineWidth = big ? 2.4 : 1.7; ctx.stroke();
    // ribs
    ctx.strokeStyle = hc(THREAT_H + 6, 100, 70, a * 0.5); ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < n - 1; i += big ? 1 : 2) { ctx.moveTo(L[i][0], L[i][1]); ctx.lineTo(R[i][0], R[i][1]); }
    ctx.stroke();
    if (big) {
      // fin spines on both flanks, swept back toward the tail
      ctx.strokeStyle = hc(THREAT_H + 6, 100, 70, a * 0.55);
      ctx.beginPath();
      for (let i = 2; i < n - 2; i += 2) {
        const p = spine[i], q = spine[i - 1];
        let tx = p.x - q.x, ty = p.y - q.y; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        const nx = -ty, ny = tx;
        const w = r * (1 - 0.88 * Math.pow(i / (n - 1), 0.85) + 0.12);
        ctx.moveTo(p.x + nx * w, p.y + ny * w); ctx.lineTo(p.x + nx * (w + 14) + tx * 9, p.y + ny * (w + 14) + ty * 9);
        ctx.moveTo(p.x - nx * w, p.y - ny * w); ctx.lineTo(p.x - nx * (w + 14) + tx * 9, p.y - ny * (w + 14) + ty * 9);
      }
      ctx.stroke();
    }
    // flank lights
    ctx.fillStyle = hc(38, 100, 82, a * 0.55);
    ctx.beginPath();
    for (let i = 2; i < n - 1; i += 3) {
      const p = spine[i], q = spine[i + 1], o = spine[i - 1];
      let tx = q.x - o.x, ty = q.y - o.y; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const w = r * ((1 - 0.88 * Math.pow(i / (n - 1), 0.85)) + 0.12) * 0.5, s = big ? 1.5 : 1;
      ctx.rect(p.x - ty * w - s, p.y + tx * w - s, 2 * s, 2 * s); ctx.rect(p.x + ty * w - s, p.y - tx * w - s, 2 * s, 2 * s);
    }
    ctx.fill();
    // eyes
    const ex = h.x + fx * r * 0.3 - fy * r * 0.45, ey = h.y + fy * r * 0.3 + fx * r * 0.45;
    ctx.fillStyle = hc(40, 100, 85, a); ctx.beginPath(); ctx.arc(ex, ey, big ? 4 : 2.2, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(h.x + fx * r * 0.3 + fy * r * 0.45, h.y + fy * r * 0.3 - fx * r * 0.45, big ? 4 : 2.2, 0, TAU); ctx.fill();
  }

  /* ================================================================ */
  drawPlayer(ctx, g) {
    const p = g.player;
    if (g.state === 'title') {
      this.drawSub(ctx, p, 0.9, g);
      return;
    }
    if (p.dead) return;
    const t = g.realTime;
    if (p.invul > 0 && Math.floor(t * 14) % 2 === 0 && g.state === 'play') { /* blink */ }
    else this.drawSub(ctx, p, 1, g);
    // charge ring & range preview
    if (p.charging) {
      const ch = p.charge;
      const range = (PING.minR + (PING.maxR - PING.minR) * ch) * (g.run ? g.stats.rangeMult : 1);
      ctx.strokeStyle = hsla(g.lv.biome.hue, 90, 75, 0.14 + 0.1 * ch);
      ctx.lineWidth = 1.4; ctx.setLineDash([3, 9]); ctx.lineDashOffset = -t * 10;
      ctx.beginPath(); ctx.arc(p.x, p.y, range, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 2.4; ctx.strokeStyle = hsla(g.lv.biome.hue, 95, 78, 0.35);
      ctx.beginPath(); ctx.arc(p.x, p.y, 21, 0, TAU); ctx.stroke();
      ctx.strokeStyle = hsla(g.lv.biome.hue + 10, 100, 88, 0.95); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(p.x, p.y, 21, -Math.PI / 2, -Math.PI / 2 + TAU * ch); ctx.stroke();
    }
  }

  drawSub(ctx, p, a, g) {
    const hue = g.lv.biome.hue;
    const sp = Math.hypot(p.vx, p.vy);
    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(p.angle);
    // soft halo
    const gr = ctx.createRadialGradient(0, 0, 2, 0, 0, 30);
    gr.addColorStop(0, hsla(hue, 90, 70, 0.28 * a)); gr.addColorStop(1, hsla(hue, 90, 70, 0));
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, 30, 0, TAU); ctx.fill();
    // thrust glow
    if (sp > 30) {
      ctx.fillStyle = hsla(hue + 15, 100, 80, Math.min(0.5, sp / 300) * a);
      ctx.beginPath(); ctx.moveTo(-9, -3); ctx.lineTo(-9 - 6 - sp * 0.06, 0); ctx.lineTo(-9, 3); ctx.closePath(); ctx.fill();
    }
    // hull
    ctx.fillStyle = hsla(hue, 60, 22, 0.9 * a);
    ctx.strokeStyle = hsla(hue, 90, 78, a); ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.quadraticCurveTo(8, -6.5, -3, -6);
    ctx.lineTo(-9, -4.5); ctx.lineTo(-9, 4.5); ctx.lineTo(-3, 6);
    ctx.quadraticCurveTo(8, 6.5, 11, 0);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // fins
    ctx.beginPath(); ctx.moveTo(-2, -6); ctx.lineTo(-8, -10); ctx.lineTo(-8, -4.5); ctx.moveTo(-2, 6); ctx.lineTo(-8, 10); ctx.lineTo(-8, 4.5); ctx.stroke();
    // core
    const pulse = 0.65 + 0.35 * Math.sin(g.realTime * 3);
    ctx.fillStyle = hsla(hue + 20, 100, 85, a * pulse); ctx.beginPath(); ctx.arc(2, 0, 2.6, 0, TAU); ctx.fill();
    ctx.fillStyle = hsla(hue, 100, 80, 0.5 * a); ctx.beginPath(); ctx.arc(2, 0, 5.5, 0, TAU); ctx.fill();
    ctx.restore();
  }

  drawParticles(ctx, g) {
    const hue = g.lv.biome.hue;
    for (const q of g.particles) {
      const k = q.life / q.max;
      let col;
      switch (q.kind) {
        case 'bubble': col = hc(hue, 70, 80, 0.5 * k); break;
        case 'gold': col = hc(GOLD_H, 100, 70, k); break;
        case 'hurt': col = hc(THREAT_H, 100, 62, k); break;
        default: col = hc(hue + 10, 100, 85, k * 0.9);
      }
      const s = q.size * (q.kind === 'bubble' ? 1 : 0.6 + k * 0.6);
      if (q.kind === 'bubble') { ctx.strokeStyle = col; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.arc(q.x, q.y, s, 0, TAU); ctx.stroke(); }
      else { ctx.fillStyle = col; ctx.fillRect(q.x - s / 2, q.y - s / 2, s, s); }
    }
  }

  drawCompass(ctx, g) {
    if (g.state !== 'play') return;
    const p = g.player, ex = g.exitObj;
    const dx = ex.x - p.x, dy = ex.y - p.y, d = Math.hypot(dx, dy);
    if (d < 240) return;
    const a = Math.atan2(dy, dx);
    const since = g.time - ex.seen;
    const al = 0.36 + 0.14 * Math.sin(g.realTime * 2.2) + (since < 4 ? 0.4 * Math.exp(-since / 2) : 0);
    const R = 40;
    const x = p.x + Math.cos(a) * R, y = p.y + Math.sin(a) * R;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(a);
    ctx.strokeStyle = hc(165, 100, 80, al); ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(-5, -6); ctx.lineTo(4, 0); ctx.lineTo(-5, 6); ctx.stroke();
    ctx.restore();
  }

  drawFloaters(ctx, g) {
    if (!g.floaters || !g.floaters.length) return;
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = '700 13px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const f of g.floaters) {
      const k = f.life / f.max;
      ctx.fillStyle = f.color.replace('A', Math.min(1, k * 1.6).toFixed(2));
      ctx.fillText(f.text, f.x, f.y - (1 - k) * 22);
    }
    ctx.globalCompositeOperation = 'lighter';
  }
}
