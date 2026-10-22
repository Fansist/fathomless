// Sonar pings: a ring of rays marched through the signed distance field.
// A ping stores where every ray ended; the renderer reveals them as the wavefront reaches them.
import { PING, } from './config.js';
import { TAU } from './rng.js';
import { rayMarch, gradAt } from './world.js';

export const HK = { NONE: 0, WALL: 1, THREAT: 2, PEARL: 3, EXIT: 4, OTHER: 5 };

const _g = { x: 0, y: 0 };
const BIN = 0.06; // seconds per audio echo bin

// targets: [{kind, x, y, r, ref}] -- circles that can reflect sound
export function createPing(lv, x, y, power, o = {}) {
  const rangeMult = o.rangeMult || 1;
  const maxR = (PING.minR + (PING.maxR - PING.minR) * power) * rangeMult * (o.scale || 1);
  const n = Math.round(PING.raysMin + (PING.raysMax - PING.raysMin) * power * (o.scale ? 0.7 : 1));
  const off = o.offset !== undefined ? o.offset : Math.random() * TAU;
  const cosA = new Float32Array(n), sinA = new Float32Array(n);
  const hd = new Float32Array(n), hx = new Float32Array(n), hy = new Float32Array(n), sh = new Float32Array(n);
  const hk = new Uint8Array(n);

  const cand = [];
  for (const t of o.targets || []) {
    const d = Math.hypot(t.x - x, t.y - y);
    if (d - t.r < maxR) cand.push(t);
  }

  const step = TAU / n;
  const binCount = new Map(), binSum = new Map();
  for (let i = 0; i < n; i++) {
    const a = off + i * step;
    const c = Math.cos(a), s = Math.sin(a);
    cosA[i] = c; sinA[i] = s;
    let t = rayMarch(lv, x, y, c, s, maxR);
    let kind = t < maxR - 0.5 ? HK.WALL : HK.NONE;
    let nx = 0, ny = 0, hit = null;
    for (let k = 0; k < cand.length; k++) {
      const tg = cand[k];
      const ox = x - tg.x, oy = y - tg.y;
      const b = ox * c + oy * s;
      const disc = b * b - (ox * ox + oy * oy - tg.r * tg.r);
      if (disc < 0) continue;
      const th = -b - Math.sqrt(disc);
      if (th >= 0 && th < t) { t = th; kind = tg.kind; hit = tg; }
    }
    const px = x + c * t, py = y + s * t;
    if (kind === HK.WALL) { gradAt(lv, px, py, _g); nx = _g.x; ny = _g.y; }
    else if (hit) { nx = (px - hit.x) / hit.r; ny = (py - hit.y) / hit.r; }
    const inc = kind ? Math.max(0, -(c * nx + s * ny)) : 0;
    sh[i] = 0.3 + 0.7 * Math.pow(inc, 0.6);
    hd[i] = t; hk[i] = kind; hx[i] = px; hy[i] = py;
    if (kind) {
      const b = Math.floor(t / PING.speed / BIN);
      binCount.set(b, (binCount.get(b) || 0) + 1);
      binSum.set(b, (binSum.get(b) || 0) + c);
    }
  }

  // which things does the wavefront actually reach in line of sight? (closest circle wins per ref)
  const best = new Map();
  for (const t of cand) {
    const dx = t.x - x, dy = t.y - y;
    const d = Math.hypot(dx, dy);
    if (d > maxR + t.r) continue;
    const free = d < 2 ? d : rayMarch(lv, x, y, dx / d, dy / d, d);
    if (free < d - 3) continue;
    const prev = best.get(t.ref);
    if (!prev || d < prev.d) best.set(t.ref, { ref: t.ref, d, kind: t.kind, done: false });
  }
  const marks = [...best.values()].sort((a, b) => a.d - b.d);

  // audio: rain of echoes
  const echoes = [];
  for (const [b, cnt] of binCount) {
    if (cnt < 3) continue;
    const t = b * BIN;
    echoes.push({ t, gain: Math.min(1, cnt / 36) * (1 - Math.min(0.7, (t * PING.speed) / maxR * 0.6)), pan: binSum.get(b) / cnt });
  }
  echoes.sort((a, b) => b.gain - a.gain);
  echoes.length = Math.min(echoes.length, 14);

  return {
    x, y, power, maxR, n, off, cosA, sinA, hd, hx, hy, sh, hk,
    shown: new Uint8Array(n),
    age: 0, r: 0, life: maxR / PING.speed + PING.lifeAfter,
    marks, echoes, dead: false,
    kind: o.kind || 'player', quiet: !!o.quiet,
  };
}

export function updatePing(p, dt) {
  p.age += dt;
  p.r = PING.speed * p.age;
  if (p.age >= p.life) p.dead = true;
}
