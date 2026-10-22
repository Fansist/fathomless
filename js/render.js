// Canvas renderer. Everything is vector art drawn additively on a near-black ocean.
import { PING, MAX_DEPTH } from './config.js';
import { HK } from './sonar.js';
import { rayMarch } from './world.js';
import { clamp, TAU } from './rng.js';

const THREAT_H = 14;
const GOLD_H = 44;
const hsla = (h, s, l, a) => `hsla(${h | 0},${s | 0}%,${l | 0}%,${a.toFixed(3)})`;
const BUCKETS = 6;
const MEM_SCALE = 2;

export class Renderer {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.game = game;
    this.px = 1;            // device pixels per world unit at zoom 1
    this.dpr = 1;
    this.bk = new Uint8Array(1024);
    this.mem = document.createElement('canvas');
    this.mctx = this.mem.getContext('2d');
    this.bloom = [document.createElement('canvas'), document.createElement('canvas'), document.createElement('canvas')];
    this.bctx = this.bloom.map((c) => c.getContext('2d'));
    this.vig = document.createElement('canvas');
    this.snow = [];
    for (let i = 0; i < 150; i++) this.snow.push({ ox: Math.random(), oy: Math.random(), vx: (Math.random() - 0.5) * 6, vy: 2 + Math.random() * 5, s: 0.6 + Math.random() * 1.2, par: i < 90 ? 1 : 0.55, tw: Math.random() * TAU });
    this.lastPingR = new WeakMap();
    this.quality = 'high';
    this.bgKey = '';
    game.onLevel = (lv) => this.resetLevel(lv);
    this.resize();
  }

  resize() {
    const cw = Math.max(320, window.innerWidth), ch = Math.max(240, window.innerHeight);
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cw * dpr > 2560) dpr = 2560 / cw;
    this.dpr = dpr;
    const c = this.canvas;
    c.style.width = cw + 'px'; c.style.height = ch + 'px';
    c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr);
    this.px = dpr * Math.min(cw / 1280, ch / 720);
    const g = this.game;
    g.view.w = c.width / this.px; g.view.h = c.height / this.px;
    const sizes = [2, 4, 8];
    this.bloom.forEach((b, i) => { b.width = Math.max(2, Math.ceil(c.width / sizes[i])); b.height = Math.max(2, Math.ceil(c.height / sizes[i])); });
    // vignette
    const v = this.vig;
    v.width = 256; v.height = 144;
    const vx = v.getContext('2d');
    const gr = vx.createRadialGradient(128, 72, 40, 128, 72, 150);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.65, 'rgba(0,0,0,0.38)'); gr.addColorStop(1, 'rgba(0,0,0,0.9)');
    vx.fillStyle = gr; vx.fillRect(0, 0, 256, 144);
    this.bgKey = '';
  }

  resetLevel(lv) {
    const m = this.mem;
    m.width = Math.ceil(lv.width / MEM_SCALE); m.height = Math.ceil(lv.height / MEM_SCALE);
    this.mctx.clearRect(0, 0, m.width, m.height);
    this.lastPingR = new WeakMap();
    for (const f of lv.flora) f.lit = 0;
    this.bgKey = '';
  }

  /* ================================================================ */
  frame() {
    const g = this.game, lv = g.lv;
    if (!lv) return;
    const ctx = this.ctx, c = this.canvas, W = c.width, H = c.height;
    const hue = lv.biome.hue;
    const t = g.time;

    // ---- backdrop ----
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    if (this.bgKey !== lv.biome.id + ':' + W + 'x' + H) {
      this.bgKey = lv.biome.id + ':' + W + 'x' + H;
      const gr = ctx.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, hsla(hue, 70, 5, 1)); gr.addColorStop(1, hsla(hue + 12, 80, 2, 1));
      this.bgGrad = gr;
    }
    ctx.fillStyle = this.bgGrad;
    ctx.fillRect(0, 0, W, H);

    // ---- camera ----
    const cam = g.cam, S = this.px * cam.zoom;
    ctx.setTransform(S, 0, 0, S, W / 2 - (cam.x + cam.sx) * S, H / 2 - (cam.y + cam.sy) * S);
    const hw = g.view.w / 2 / cam.zoom + 90, hh = g.view.h / 2 / cam.zoom + 90;
    const vb = { x0: cam.x - hw, x1: cam.x + hw, y0: cam.y - hh, y1: cam.y + hh };
    const inView = (x, y, m = 0) => x > vb.x0 - m && x < vb.x1 + m && y > vb.y0 - m && y < vb.y1 + m;
    this.S = S;

    ctx.globalCompositeOperation = 'lighter';
    this.drawSnow(ctx, g, vb, S, 0);          // far plankton layer
    this.drawCurrents(ctx, g, vb);
    this.drawMemory(ctx, g, lv, hue);
    this.updateFlora(g, lv);
    this.drawFlora(ctx, g, lv, hue, vb);
    this.drawPings(ctx, g, lv, hue);
    this.drawWhiskers(ctx, g, lv, hue);
    this.drawItems(ctx, g, lv, inView);
    this.drawEnemies(ctx, g, lv, inView);
    this.drawPlayer(ctx, g);
    this.drawParticles(ctx, g);
    this.drawSnow(ctx, g, vb, S, 1);          // near layer
    this.drawCompass(ctx, g);
    this.drawFloaters(ctx, g);

    // ---- bloom ----
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.quality === 'high') this.drawBloom(ctx, W, H);

    // ---- screen space overlays ----
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(this.vig, 0, 0, W, H);
    this.drawOverlays(ctx, g, W, H);
  }

  /* ================================================================ */
  drawBloom(ctx, W, H) {
    const [a, b, c] = this.bloom, [ax, bx, cx] = this.bctx;
    ax.globalCompositeOperation = 'copy'; ax.drawImage(this.canvas, 0, 0, a.width, a.height);
    bx.globalCompositeOperation = 'copy'; bx.drawImage(a, 0, 0, b.width, b.height);
    cx.globalCompositeOperation = 'copy'; cx.drawImage(b, 0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.55; ctx.drawImage(b, 0, 0, W, H);
    ctx.globalAlpha = 0.75; ctx.drawImage(c, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  drawOverlays(ctx, g, W, H) {
    const reduce = g.settings.reduceFlash;
    // danger tint
    if (g.danger > 0.05) {
      const beat = 0.65 + 0.35 * Math.sin(g.realTime * (5 + g.danger * 8));
      const a = g.danger * 0.4 * beat;
      const gr = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
      gr.addColorStop(0, 'rgba(255,40,10,0)'); gr.addColorStop(1, hsla(THREAT_H, 100, 40, a));
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    }
    if (g.flash > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = hsla(g.state === 'levelend' ? 180 : THREAT_H, 90, 50, g.flash * (reduce ? 0.12 : 0.4));
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (g.state === 'levelend') {
      const a = clamp((g.stateT - 0.9) / 1.0, 0, 1);
      ctx.fillStyle = `rgba(2,10,14,${a})`; ctx.fillRect(0, 0, W, H);
    }
    if (g.state === 'dying') {
      const a = clamp((g.stateT - 0.6) / 1.8, 0, 0.9);
      ctx.fillStyle = `rgba(8,0,0,${a})`; ctx.fillRect(0, 0, W, H);
    }
  }

  /* ================================================================ */
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
          const d = Math.hypot(wx - p.x, wy - p.y);
          if (d < p.r && p.r - d < 34 && p.r < p.maxR) a += 0.8 * (1 - (p.r - d) / 34) * (1 - p.r / p.maxR);
        }
      }
      if (a < 0.05) continue;
      ctx.fillStyle = hsla(hue, 60, 75, Math.min(1, a) * (layer ? 0.6 : 1));
      const s = m.s * (layer ? 1.2 : 0.9);
      ctx.fillRect(wx - s / 2, wy - s / 2, s, s);
    }
  }

  drawCurrents(ctx, g, vb) {
    const lv = g.lv;
    if (!lv.currents.length) return;
    const t = g.realTime;
    ctx.lineCap = 'round';
    for (const c of lv.currents) {
      if (c.x + c.r < vb.x0 || c.x - c.r > vb.x1 || c.y + c.r < vb.y0 || c.y - c.r > vb.y1) continue;
      const dx = Math.cos(c.ang), dy = Math.sin(c.ang);
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 26; i++) {
        const u = ((i * 0.6180339 + t * (0.05 + c.force / 1400)) % 1);
        const v = (((i * 0.7548776) % 1) - 0.5) * 2 * 0.86;
        const px = c.x + dx * (u - 0.5) * 2 * c.r - dy * v * c.r;
        const py = c.y + dy * (u - 0.5) * 2 * c.r + dx * v * c.r;
        const edge = Math.sqrt(Math.max(0, 1 - ((u - 0.5) * 2) ** 2 - v * v));
        if (edge <= 0) continue;
        ctx.strokeStyle = hsla(g.lv.biome.hue + 20, 80, 70, 0.22 * edge);
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + dx * 16, py + dy * 16); ctx.stroke();
      }
    }
  }

  drawMemory(ctx, g, lv, hue) {
    // stamp newly revealed wall points into the persistent map, then draw it
    const mctx = this.mctx;
    mctx.fillStyle = hsla(hue, 85, 66, 0.3);
    mctx.strokeStyle = hsla(hue, 85, 66, 0.26);
    mctx.lineWidth = 1.1;
    mctx.lineCap = 'round';
    const k = 1 / MEM_SCALE;
    for (const p of g.pings) {
      if (p.kind === 'death') continue;
      const n = p.n;
      mctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (p.shown[i] || p.hd[i] > p.r) continue;
        p.shown[i] = 1;
        if (p.hk[i] !== HK.WALL) continue;
        mctx.rect(p.hx[i] * k - 0.6, p.hy[i] * k - 0.6, 1.2, 1.2);
        const j = i === 0 ? n - 1 : i - 1;
        if (p.shown[j] && p.hk[j] === HK.WALL && Math.abs(p.hd[i] - p.hd[j]) < 12) {
          mctx.moveTo(p.hx[j] * k, p.hy[j] * k); mctx.lineTo(p.hx[i] * k, p.hy[i] * k);
        }
      }
      mctx.fill();
      mctx.stroke();
    }
    const boost = g.run ? g.stats.memory : 1;
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = clamp(0.62 + 0.2 * (boost - 1), 0.5, 1);
    ctx.drawImage(this.mem, 0, 0, lv.width, lv.height);
    ctx.globalAlpha = 1;
  }

  // debug/dev helper: paint the whole cave into the memory map
  revealAll() {
    const lv = this.game.lv, mctx = this.mctx, k = 1 / MEM_SCALE;
    mctx.fillStyle = hsla(lv.biome.hue, 85, 66, 0.5);
    for (let y = 1; y < lv.H - 1; y++) {
      for (let x = 1; x < lv.W - 1; x++) {
        const s0 = lv.sdf[y * lv.W + x];
        if (s0 >= 0 && s0 < 3.2) mctx.fillRect(((x + 0.5) * 8) * k - 0.6, ((y + 0.5) * 8) * k - 0.6, 1.2, 1.2);
      }
    }
  }

  updateFlora(g, lv) {
    const fl = lv.flora;
    const dt = 1 / 60;
    for (let i = 0; i < fl.length; i++) fl[i].lit = Math.max(0, fl[i].lit - dt * 0.75);
    for (const p of g.pings) {
      if (p.quiet && p.kind === 'death') continue;
      const prev = this.lastPingR.get(p) || 0;
      this.lastPingR.set(p, p.r);
      if (p.r > p.maxR) continue;
      for (let i = 0; i < fl.length; i++) {
        const f = fl[i];
        const dx = f.x - p.x, dy = f.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d > p.r + 6 || d < prev - 6 || d > p.maxR) continue;
        const a = Math.atan2(dy, dx) - p.off;
        let k = Math.round(((a % TAU) + TAU) % TAU / (TAU / p.n)) % p.n;
        if (p.hd[k] + 22 >= d) f.lit = Math.max(f.lit, 1 - 0.55 * (d / p.maxR));
      }
    }
  }

  drawFlora(ctx, g, lv, hue, vb) {
    const p = g.player, t = g.realTime;
    ctx.lineCap = 'round';
    const fl = lv.flora;
    for (let i = 0; i < fl.length; i++) {
      const f = fl[i];
      if (f.x < vb.x0 || f.x > vb.x1 || f.y < vb.y0 || f.y > vb.y1) continue;
      const d = Math.hypot(f.x - p.x, f.y - p.y);
      const near = clamp((340 - d) / 170, 0, 1);
      const a = Math.max(f.lit, near * 0.2);
      if (a < 0.03) continue;
      const h = hue + f.hue;
      const sway = Math.sin(t * 1.1 + f.phase);
      if (f.type === 0) { // kelp
        for (let k = 0; k < f.n; k++) {
          const ang = Math.atan2(f.ny, f.nx) + (k - (f.n - 1) / 2) * 0.28;
          const L = f.len * (0.7 + 0.3 * ((k * 7 + i) % 3) / 2);
          const ex = f.x + Math.cos(ang) * L + sway * 9 * (1 + k * 0.2), ey = f.y + Math.sin(ang) * L - 4;
          const cx = f.x + Math.cos(ang) * L * 0.5 - sway * 7, cy = f.y + Math.sin(ang) * L * 0.5;
          ctx.strokeStyle = hsla(h, 90, 62, a * 0.8);
          ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.quadraticCurveTo(cx, cy, ex, ey); ctx.stroke();
          ctx.fillStyle = hsla(h + 10, 100, 78, a);
          ctx.fillRect(ex - 1.3, ey - 1.3, 2.6, 2.6);
        }
      } else if (f.type === 1) { // coral
        ctx.strokeStyle = hsla(h, 95, 64, a * 0.85);
        ctx.fillStyle = hsla(h + 8, 100, 80, a);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let k = 0; k < f.n; k++) {
          const ang = Math.atan2(f.ny, f.nx) + (k - (f.n - 1) / 2) * 0.62 + sway * 0.05;
          const L = f.len * (0.6 + 0.4 * ((k + i) % 2));
          ctx.moveTo(f.x, f.y); ctx.lineTo(f.x + Math.cos(ang) * L, f.y + Math.sin(ang) * L);
        }
        ctx.stroke();
        ctx.beginPath();
        for (let k = 0; k < f.n; k++) {
          const ang = Math.atan2(f.ny, f.nx) + (k - (f.n - 1) / 2) * 0.62 + sway * 0.05;
          const L = f.len * (0.6 + 0.4 * ((k + i) % 2));
          const ex = f.x + Math.cos(ang) * L, ey = f.y + Math.sin(ang) * L;
          ctx.moveTo(ex + 2.2, ey); ctx.arc(ex, ey, 2.2, 0, TAU);
        }
        ctx.fill();
      } else { // glowing bulb on a stalk
        const bx = f.x + f.nx * f.len + sway * 2, by = f.y + f.ny * f.len;
        ctx.strokeStyle = hsla(h, 80, 55, a * 0.6); ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(bx, by); ctx.stroke();
        const r = 2.6 + 1.6 * (0.5 + 0.5 * Math.sin(t * 2 + f.phase));
        ctx.fillStyle = hsla(h, 100, 70, a * 0.35); ctx.beginPath(); ctx.arc(bx, by, r * 2.4, 0, TAU); ctx.fill();
        ctx.fillStyle = hsla(h + 15, 100, 88, a); ctx.beginPath(); ctx.arc(bx, by, r * 0.9, 0, TAU); ctx.fill();
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

  drawPings(ctx, g, lv, hue) {
    const wave = PING.speed;
    for (const p of g.pings) {
      const ph = this.pingHue(p, hue);
      const travelEnd = p.maxR / wave;
      const afterWave = Math.max(0, p.age - travelEnd);
      const vis = clamp(1 - afterWave / 1.1, 0, 1);
      const k = clamp(1 - p.r / p.maxR, 0, 1);
      const qa = p.quiet ? 0.7 : 1;
      const n = p.n;

      // lit water volume
      if (p.r < p.maxR + 40 && vis > 0) {
        const r = Math.min(p.r, p.maxR);
        const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(8, r));
        gr.addColorStop(0, hsla(ph, 80, 60, 0.0));
        gr.addColorStop(0.55, hsla(ph, 80, 60, 0.012 * qa));
        gr.addColorStop(1, hsla(ph, 85, 62, (0.05 + 0.1 * k) * qa * vis));
        ctx.fillStyle = gr;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const d = Math.min(r, p.hd[i]);
          const x = p.x + p.cosA[i] * d, y = p.y + p.sinA[i] * d;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath(); ctx.fill();
      }

      // wavefront
      if (p.r < p.maxR) {
        const r = p.r;
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i < n; i++) {
          if (p.hd[i] > r) {
            const x = p.x + p.cosA[i] * r, y = p.y + p.sinA[i] * r;
            if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
          } else pen = false;
        }
        ctx.lineCap = 'round';
        ctx.strokeStyle = hsla(ph, 90, 70, 0.16 * k * qa); ctx.lineWidth = 9; ctx.stroke();
        ctx.strokeStyle = hsla(ph, 95, 82, 0.85 * Math.pow(k, 0.7) * qa); ctx.lineWidth = 1.7; ctx.stroke();
      }

      // echoes: walls (bucketed), then things
      if (this.bk.length < n) this.bk = new Uint8Array(n);
      const bk = this.bk;
      const tau = (p.quiet ? 0.8 : 1.0) * (g.run ? 1 : 1);
      for (let i = 0; i < n; i++) {
        if (p.hk[i] !== HK.WALL || p.hd[i] > p.r) { bk[i] = 255; continue; }
        const since = p.age - p.hd[i] / wave;
        const a = Math.exp(-since / tau) * (0.28 + 0.72 * p.sh[i]) * (1 - 0.5 * p.hd[i] / p.maxR) * qa;
        bk[i] = a < 0.035 ? 255 : Math.min(BUCKETS - 1, (a * BUCKETS * 1.05) | 0);
      }
      ctx.lineCap = 'round';
      for (let b = 0; b < BUCKETS; b++) {
        const alpha = (b + 0.7) / BUCKETS;
        ctx.beginPath();
        let any = false;
        for (let i = 0; i < n; i++) {
          if (bk[i] !== b) continue;
          any = true;
          const j = i === 0 ? n - 1 : i - 1;
          if (bk[j] !== 255 && p.hk[j] === HK.WALL && Math.abs(p.hd[i] - p.hd[j]) < 12) { ctx.moveTo(p.hx[j], p.hy[j]); ctx.lineTo(p.hx[i], p.hy[i]); }
        }
        if (any) {
          ctx.strokeStyle = hsla(ph, 90, 66, alpha * 0.16); ctx.lineWidth = 7; ctx.stroke();
          ctx.strokeStyle = hsla(ph, 90, 70, alpha * 0.7); ctx.lineWidth = 1.5; ctx.stroke();
        }
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          if (bk[i] !== b) continue;
          ctx.moveTo(p.hx[i] - 0.5, p.hy[i]); ctx.lineTo(p.hx[i] + 0.5, p.hy[i]);
        }
        if (any) { ctx.strokeStyle = hsla(ph, 80, 84, Math.min(1, alpha * 1.1)); ctx.lineWidth = 2.6; ctx.stroke(); }
      }
      // threats, loot, gate
      for (let i = 0; i < n; i++) {
        const kd = p.hk[i];
        if (kd <= HK.WALL || p.hd[i] > p.r) continue;
        const since = p.age - p.hd[i] / wave;
        const a = Math.exp(-since / 1.5) * (0.35 + 0.65 * p.sh[i]);
        if (a < 0.04) continue;
        let col;
        if (kd === HK.THREAT) col = hsla(THREAT_H, 100, 62, a);
        else if (kd === HK.PEARL) col = hsla(GOLD_H, 100, 70, a);
        else if (kd === HK.EXIT) col = hsla(165, 100, 85, a);
        else col = hsla(180, 90, 75, a);
        ctx.fillStyle = col;
        ctx.fillRect(p.hx[i] - 1.7, p.hy[i] - 1.7, 3.4, 3.4);
      }
    }
  }

  drawWhiskers(ctx, g, lv, hue) {
    const p = g.player;
    if (p.dead || g.state === 'title') return;
    const N = 26, R = 46;
    ctx.fillStyle = hsla(hue, 90, 75, 0.0);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU + g.realTime * 0.15;
      const c = Math.cos(a), s = Math.sin(a);
      const d = rayMarch(lv, p.x, p.y, c, s, R);
      if (d >= R - 0.5) continue;
      const al = (1 - d / R) * 0.5;
      ctx.fillStyle = hsla(hue, 90, 78, al);
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
        ctx.fillStyle = hsla(GOLD_H, 100, 60, a * 0.28); ctx.beginPath(); ctx.arc(pk.x, pk.y, 9, 0, TAU); ctx.fill();
        ctx.fillStyle = hsla(GOLD_H + 4, 100, 82, a); ctx.beginPath(); ctx.arc(pk.x, pk.y, 3.3, 0, TAU); ctx.fill();
        ctx.strokeStyle = hsla(GOLD_H, 100, 85, a * 0.7); ctx.lineWidth = 1;
        const gl = 6 + 2 * Math.sin(t * 4 + pk.phase);
        ctx.beginPath(); ctx.moveTo(pk.x - gl, pk.y); ctx.lineTo(pk.x + gl, pk.y); ctx.moveTo(pk.x, pk.y - gl); ctx.lineTo(pk.x, pk.y + gl); ctx.stroke();
      } else if (pk.type === 'buoy') {
        ctx.strokeStyle = hsla(176, 95, 70, a); ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(pk.x, pk.y, 6, 0, TAU); ctx.stroke();
        ctx.fillStyle = hsla(176, 100, 80, a); ctx.beginPath(); ctx.arc(pk.x, pk.y, 2.2, 0, TAU); ctx.fill();
      } else {
        ctx.strokeStyle = hsla(135, 95, 68, a); ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.moveTo(pk.x - 6, pk.y); ctx.lineTo(pk.x + 6, pk.y); ctx.moveTo(pk.x, pk.y - 6); ctx.lineTo(pk.x, pk.y + 6); ctx.stroke();
      }
    }
    // placed decoys
    for (const b of g.buoys) {
      const ph = (b.beep / 0.95);
      ctx.strokeStyle = hsla(176, 95, 72, 0.7); ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(b.x, b.y, 5 + 2 * Math.sin(t * 6), 0, TAU); ctx.stroke();
      ctx.fillStyle = hsla(176, 100, 82, 0.9); ctx.beginPath(); ctx.arc(b.x, b.y, 2.4, 0, TAU); ctx.fill();
      ctx.strokeStyle = hsla(176, 95, 72, 0.4 * ph); ctx.lineWidth = 1;
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
    g.fillStyle = hsla(165, 100, 70, a * 0.14); g.beginPath(); g.arc(x, y, r * 2.4, 0, TAU); g.fill();
    g.strokeStyle = hsla(168, 100, 82, a); g.lineWidth = 2.2;
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.stroke();
    g.lineWidth = 1.6; g.strokeStyle = hsla(185, 100, 78, a * 0.9);
    g.setLineDash([5, 7]); g.lineDashOffset = -t * 14;
    g.beginPath(); g.arc(x, y, r * 1.45, 0, TAU); g.stroke();
    g.setLineDash([2, 9]); g.lineDashOffset = t * 10;
    g.beginPath(); g.arc(x, y, r * 1.9, 0, TAU); g.stroke();
    g.setLineDash([]);
    g.fillStyle = hsla(165, 100, 92, a * 0.8); g.beginPath(); g.arc(x, y, 3.4, 0, TAU); g.fill();
    for (let i = 0; i < 4; i++) {
      const aa = t * 0.7 + i * TAU / 4;
      g.fillStyle = hsla(165, 100, 90, a * 0.9);
      g.fillRect(x + Math.cos(aa) * r - 1.5, y + Math.sin(aa) * r - 1.5, 3, 3);
    }
  }

  /* ================================================================ */
  drawEnemies(ctx, g, lv, inView) {
    const life = 4.6 * (g.run ? g.stats.ghostLife : 1);
    const t = g.time, rt = g.realTime;
    for (const e of g.enemies) {
      // angler lure is a real light you can always see
      if (e.type === 'angler') {
        const l = e.lure();
        if (inView(l.x, l.y)) {
          const fl = 0.6 + 0.4 * Math.sin(rt * 7.3 + e.id) * Math.sin(rt * 3.1);
          ctx.fillStyle = hsla(40, 100, 60, 0.22 * fl); ctx.beginPath(); ctx.arc(l.x, l.y, 20, 0, TAU); ctx.fill();
          ctx.fillStyle = hsla(46, 100, 72, 0.5 * fl); ctx.beginPath(); ctx.arc(l.x, l.y, 7, 0, TAU); ctx.fill();
          ctx.fillStyle = hsla(50, 100, 92, 0.95 * fl); ctx.beginPath(); ctx.arc(l.x, l.y, 2.6, 0, TAU); ctx.fill();
        }
      }
      const since = t - e.seen;
      if (since > life || since < 0) continue;
      const k = 1 - since / life;
      const a = Math.pow(k, 1.4);
      if (!inView(e.sx, e.sy, 120)) continue;
      switch (e.type) {
        case 'jelly': this.drawJelly(ctx, e.sx, e.sy, e.sa, e.sPhase, a, e.r); break;
        case 'urchin': this.drawUrchin(ctx, e.sx, e.sy, e.sPhase, a, e.r); break;
        case 'angler': this.drawAngler(ctx, e.sx, e.sy, e.sa, a, e.r, e); break;
        case 'eel': this.drawSerpent(ctx, e.sSpine || e.spine, e.r, a, false, e.sPhase); break;
        case 'leviathan': this.drawSerpent(ctx, e.sSpine || e.spine, e.r, a, true, e.sPhase); break;
      }
      // live "presence" ring if it is right next to you
    }
  }

  drawJelly(ctx, x, y, ang, phase, a, r) {
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
    ctx.fillStyle = hsla(THREAT_H + 8, 100, 60, a * 0.16); ctx.fill();
    ctx.strokeStyle = hsla(THREAT_H + 6, 100, 66, a * 0.95); ctx.lineWidth = 1.8; ctx.stroke();
    // inner glow
    ctx.fillStyle = hsla(THREAT_H + 16, 100, 75, a * 0.35);
    ctx.beginPath(); ctx.arc(bw * 0.25, 0, r * 0.38, 0, TAU); ctx.fill();
    // tentacles
    ctx.lineWidth = 1.3; ctx.strokeStyle = hsla(THREAT_H + 12, 100, 68, a * 0.7);
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      const y0 = i * bh * 0.38;
      ctx.moveTo(-1, y0);
      for (let s = 1; s <= 6; s++) {
        const sx = -s * r * 0.34;
        ctx.lineTo(sx, y0 + Math.sin(phase * 1.2 - s * 0.9 + i) * 3.2 * s * 0.5);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  drawUrchin(ctx, x, y, phase, a, r) {
    ctx.strokeStyle = hsla(THREAT_H, 100, 64, a * 0.95); ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
      const ang = i * TAU / 16 + phase * 0.2;
      const L = r * (i % 2 ? 1.5 : 1.95);
      ctx.moveTo(x + Math.cos(ang) * r * 0.7, y + Math.sin(ang) * r * 0.7);
      ctx.lineTo(x + Math.cos(ang) * L, y + Math.sin(ang) * L);
    }
    ctx.stroke();
    ctx.fillStyle = hsla(THREAT_H, 100, 55, a * 0.25); ctx.beginPath(); ctx.arc(x, y, r * 0.85, 0, TAU); ctx.fill();
    ctx.strokeStyle = hsla(THREAT_H, 100, 68, a); ctx.beginPath(); ctx.arc(x, y, r * 0.85, 0, TAU); ctx.stroke();
  }

  drawAngler(ctx, x, y, ang, a, r, e) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(ang);
    ctx.fillStyle = hsla(THREAT_H, 100, 55, a * 0.2);
    ctx.strokeStyle = hsla(THREAT_H, 100, 66, a); ctx.lineWidth = 1.8;
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
    ctx.fillStyle = hsla(THREAT_H + 20, 100, 85, a);
    ctx.beginPath(); ctx.arc(r * 0.1, -r * 0.5, 2.4, 0, TAU); ctx.fill();
    // tail
    ctx.beginPath(); ctx.moveTo(-r * 1.1, 0); ctx.lineTo(-r * 1.9, -r * 0.7); ctx.lineTo(-r * 1.7, 0); ctx.lineTo(-r * 1.9, r * 0.7); ctx.closePath();
    ctx.stroke();
    // stalk to lure (in local space)
    ctx.strokeStyle = hsla(46, 100, 70, a * 0.8); ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(r * 0.4, -r * 0.9); ctx.quadraticCurveTo(r * 1.2, -r * 1.9, r * 2.1, -r * 0.7); ctx.stroke();
    ctx.restore();
  }

  drawSerpent(ctx, spine, r, a, big, phase) {
    const n = spine.length;
    if (!n) return;
    const L = [], R = [];
    for (let i = 0; i < n; i++) {
      const p = spine[i];
      const q = spine[Math.min(n - 1, i + 1)], o = spine[Math.max(0, i - 1)];
      let tx = q.x - o.x, ty = q.y - o.y;
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const k = i / (n - 1);
      const w = r * (i === 0 ? 0.95 : (1 - 0.88 * Math.pow(k, 0.85)) + 0.12) * (big ? 1.0 : 1.0);
      L.push([p.x - ty * w, p.y + tx * w]); R.push([p.x + ty * w, p.y - tx * w]);
    }
    ctx.beginPath();
    ctx.moveTo(L[0][0], L[0][1]);
    for (let i = 1; i < n; i++) ctx.lineTo(L[i][0], L[i][1]);
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(R[i][0], R[i][1]);
    ctx.closePath();
    ctx.fillStyle = hsla(THREAT_H, 100, 55, a * (big ? 0.2 : 0.22)); ctx.fill();
    ctx.strokeStyle = hsla(THREAT_H, 100, 66, a * 0.95); ctx.lineWidth = big ? 2.4 : 1.7; ctx.stroke();
    // ribs / dorsal ridge
    ctx.strokeStyle = hsla(THREAT_H + 6, 100, 70, a * 0.5); ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < n - 1; i += big ? 1 : 2) { ctx.moveTo(L[i][0], L[i][1]); ctx.lineTo(R[i][0], R[i][1]); }
    ctx.stroke();
    if (big) {
      ctx.beginPath();
      for (let i = 2; i < n - 2; i += 2) {
        const p = spine[i], q = spine[i - 1];
        const tx = p.x - q.x, ty = p.y - q.y, tl = Math.hypot(tx, ty) || 1;
        const nx = -ty / tl, ny = tx / tl;
        const w = r * (1 - 0.88 * Math.pow(i / (n - 1), 0.85) + 0.12);
        ctx.moveTo(p.x + nx * w, p.y + ny * w); ctx.lineTo(p.x + nx * (w + 14) - (tx / tl) * 8, p.y + ny * (w + 14) - (ty / tl) * 8);
      }
      ctx.stroke();
    }
    // eye
    const h = spine[0], h2 = spine[1] || h;
    const hx = h.x - h2.x, hy = h.y - h2.y, hl = Math.hypot(hx, hy) || 1;
    const ex = h.x + (hx / hl) * r * 0.3 - (hy / hl) * r * 0.45, ey = h.y + (hy / hl) * r * 0.3 + (hx / hl) * r * 0.45;
    ctx.fillStyle = hsla(40, 100, 85, a); ctx.beginPath(); ctx.arc(ex, ey, big ? 4 : 2.2, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(h.x + (hx / hl) * r * 0.3 + (hy / hl) * r * 0.45, h.y + (hy / hl) * r * 0.3 - (hx / hl) * r * 0.45, big ? 4 : 2.2, 0, TAU); ctx.fill();
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
      ctx.strokeStyle = hsla(g.lv.biome.hue, 90, 75, 0.1 + 0.08 * ch);
      ctx.lineWidth = 1.2; ctx.setLineDash([3, 9]); ctx.lineDashOffset = -t * 10;
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
    // hull pips orbiting when hurt
  }

  drawParticles(ctx, g) {
    for (const q of g.particles) {
      const k = q.life / q.max;
      let col;
      switch (q.kind) {
        case 'bubble': col = hsla(g.lv.biome.hue, 70, 80, 0.5 * k); break;
        case 'gold': col = hsla(GOLD_H, 100, 70, k); break;
        case 'hurt': col = hsla(THREAT_H, 100, 62, k); break;
        default: col = hsla(g.lv.biome.hue + 10, 100, 85, k * 0.9);
      }
      ctx.fillStyle = col;
      const s = q.size * (q.kind === 'bubble' ? 1 : 0.6 + k * 0.6);
      if (q.kind === 'bubble') { ctx.strokeStyle = col; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.arc(q.x, q.y, s, 0, TAU); ctx.stroke(); }
      else ctx.fillRect(q.x - s / 2, q.y - s / 2, s, s);
    }
  }

  drawCompass(ctx, g) {
    if (g.state !== 'play') return;
    const p = g.player, ex = g.exitObj;
    const dx = ex.x - p.x, dy = ex.y - p.y, d = Math.hypot(dx, dy);
    if (d < 240) return;
    const a = Math.atan2(dy, dx);
    const since = g.time - ex.seen;
    const al = 0.28 + 0.14 * Math.sin(g.realTime * 2.2) + (since < 4 ? 0.4 * Math.exp(-since / 2) : 0);
    const R = 38;
    const x = p.x + Math.cos(a) * R, y = p.y + Math.sin(a) * R;
    ctx.save();
    ctx.translate(x, y); ctx.rotate(a);
    ctx.strokeStyle = hsla(165, 100, 80, al); ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(-4, -5); ctx.lineTo(3, 0); ctx.lineTo(-4, 5); ctx.stroke();
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
