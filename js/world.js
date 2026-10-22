// Procedural cave generation, signed-distance-field physics, ray marching and navigation.
// Pure and DOM-free so it can be fuzz-tested in Node.
import { RNG, noise2, clamp, TAU } from './rng.js';
import { CELL, COARSE, MAX_DEPTH, biomeFor, levelSize, spawnTable } from './config.js';

const INF = 1e20;

/* ------------------------------------------------------------------ */
/* Euclidean distance transform (Felzenszwalb & Huttenlocher)          */
/* ------------------------------------------------------------------ */
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// squared distance from every cell to the nearest cell where feat === 1
function edtSq(feat, W, H) {
  const out = new Float64Array(W * H);
  const n = Math.max(W, H);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 2);
  const v = new Int32Array(n);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = feat[y * W + x] ? 0 : INF;
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) out[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = out[y * W + x];
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) out[y * W + x] = d[x];
  }
  return out;
}

function boxBlur(a, W, H, r) {
  const tmp = new Float32Array(W * H);
  const k = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    const o = y * W;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += a[o + clamp(i, 0, W - 1)];
    for (let x = 0; x < W; x++) {
      tmp[o + x] = acc / k;
      acc += a[o + Math.min(x + r + 1, W - 1)] - a[o + Math.max(x - r, 0)];
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += tmp[clamp(i, 0, H - 1) * W + x];
    for (let y = 0; y < H; y++) {
      a[y * W + x] = acc / k;
      acc += tmp[Math.min(y + r + 1, H - 1) * W + x] - tmp[Math.max(y - r, 0) * W + x];
    }
  }
}

/* ------------------------------------------------------------------ */
/* Coarse cellular-automata cave                                       */
/* ------------------------------------------------------------------ */
// Biome-flavoured parameters for the tunnel carver (units are coarse 16px cells).
// pil = rock-pillar density in the roomiest water, gap = minimum water (cells) kept between a pillar and any wall.
const CARVE = [
  { rMin: 2.0, rMax: 2.9, chamberP: 0.035, cMin: 4.5, cMax: 8.0, target: 0.30, turn: 0.30, lenMin: 28, lenMax: 80, pil: 0.25, gap: 2.6 },
  { rMin: 1.9, rMax: 2.6, chamberP: 0.025, cMin: 4.0, cMax: 7.0, target: 0.27, turn: 0.46, lenMin: 36, lenMax: 90, pil: 0.5, gap: 2.6 },
  { rMin: 1.8, rMax: 2.6, chamberP: 0.022, cMin: 4.2, cMax: 7.0, target: 0.28, turn: 0.42, lenMin: 30, lenMax: 80, pil: 0.5, gap: 2.6 },
  { rMin: 2.0, rMax: 2.9, chamberP: 0.024, cMin: 4.5, cMax: 7.5, target: 0.29, turn: 0.42, lenMin: 30, lenMax: 80, pil: 0.55, gap: 2.6 },
];
// the final level must stay passable for the leviathan (nav class XL needs 80 px of water), so its tunnels stay wide and pillars keep a wide berth
const CARVE_FINAL = { rMin: 3.4, rMax: 4.4, chamberP: 0.035, cMin: 6.5, cMax: 10.5, target: 0.33, turn: 0.36, lenMin: 26, lenMax: 70, pil: 0.55, gap: 6.2 };

// Random-walk worms that bore tunnels and occasionally open a chamber. Always connected by construction.
function carveNetwork(g, gw, gh, rng, P) {
  g.fill(1);
  let open = 0;
  const stamp = (x, y, r) => { open += stampDisc(g, gw, gh, x, y, r); };
  const target = P.target * (gw - 12) * (gh - 12);
  const nodes = [];
  const sx = rng.range(gw * 0.35, gw * 0.65), sy = rng.range(gh * 0.35, gh * 0.65);
  stamp(sx, sy, rng.range(P.cMin, P.cMax));
  nodes.push({ x: sx, y: sy });
  for (let guard = 0; open < target && guard < 600; guard++) {
    const nd = nodes[rng.int(0, nodes.length - 1)];
    let x = nd.x, y = nd.y, a = rng.range(0, TAU);
    const len = rng.int(P.lenMin, P.lenMax);
    const r = rng.range(P.rMin, P.rMax);
    for (let st = 0; st < len; st++) {
      a += rng.gauss() * P.turn * 0.4;
      if (x < 12 && Math.cos(a) < 0) a = Math.PI - a;
      if (x > gw - 13 && Math.cos(a) > 0) a = Math.PI - a;
      if (y < 12 && Math.sin(a) < 0) a = -a;
      if (y > gh - 13 && Math.sin(a) > 0) a = -a;
      x = clamp(x + Math.cos(a), 6, gw - 7);
      y = clamp(y + Math.sin(a), 6, gh - 7);
      stamp(x, y, r * (0.92 + 0.16 * rng.next()));
      if (st % 5 === 0) nodes.push({ x, y });
      if (rng.next() < P.chamberP) stamp(x, y, rng.range(P.cMin, P.cMax));
    }
  }
  return open;
}

// Rock pillars in the roomiest water: cover to hide behind and obstacles to weave around. A pillar always leaves at least
// 'gap' cells of water between itself and the walls (and other pillars), so no passage ever gets pinched shut.
function addPillars(g, gw, gh, rng, pil, gap) {
  if (!(pil > 0)) return 0;
  const dr = edtSq(g, gw, gh);
  const cand = [];
  for (let y = 8; y < gh - 8; y++) for (let x = 8; x < gw - 8; x++) if (!g[y * gw + x] && dr[y * gw + x] >= (gap + 1.6) * (gap + 1.6)) cand.push(y * gw + x);
  rng.shuffle(cand);
  const want = Math.round(pil * cand.length / 170);
  const placed = [];
  for (const c of cand) {
    if (placed.length >= want) break;
    const x = c % gw, y = (c / gw) | 0;
    const rp = Math.min(rng.range(2.0, 3.3), Math.sqrt(dr[c]) - gap);
    if (rp < 1.9) continue;
    let ok = true;
    for (const p of placed) if (Math.hypot(p.x - x, p.y - y) < p.r + rp + gap + 3) { ok = false; break; }
    if (!ok) continue;
    for (let yy = Math.floor(y - rp); yy <= Math.ceil(y + rp); yy++) for (let xx = Math.floor(x - rp); xx <= Math.ceil(x + rp); xx++) {
      if ((xx - x) * (xx - x) + (yy - y) * (yy - y) <= rp * rp) g[yy * gw + xx] = 1;
    }
    placed.push({ x, y, r: rp });
  }
  return placed.length;
}

function keepLargest(g, gw, gh) {
  const n = gw * gh;
  const label = new Int32Array(n).fill(-1);
  const q = new Int32Array(n);
  let best = -1, bestN = 0, lab = 0;
  for (let i = 0; i < n; i++) {
    if (g[i] !== 0 || label[i] >= 0) continue;
    let qh = 0, qt = 0;
    q[qt++] = i; label[i] = lab;
    while (qh < qt) {
      const c = q[qh++];
      const x = c % gw, y = (c / gw) | 0;
      if (x > 0 && g[c - 1] === 0 && label[c - 1] < 0) { label[c - 1] = lab; q[qt++] = c - 1; }
      if (x < gw - 1 && g[c + 1] === 0 && label[c + 1] < 0) { label[c + 1] = lab; q[qt++] = c + 1; }
      if (y > 0 && g[c - gw] === 0 && label[c - gw] < 0) { label[c - gw] = lab; q[qt++] = c - gw; }
      if (y < gh - 1 && g[c + gw] === 0 && label[c + gw] < 0) { label[c + gw] = lab; q[qt++] = c + gw; }
    }
    if (qt > bestN) { bestN = qt; best = lab; }
    lab++;
  }
  const out = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) if (label[i] === best) out[i] = 0;
  return { g: out, area: bestN };
}

function bfsCoarse(g, gw, gh, src) {
  const n = gw * gh;
  const dist = new Int32Array(n).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const q = new Int32Array(n);
  let qh = 0, qt = 0;
  q[qt++] = src; dist[src] = 0;
  while (qh < qt) {
    const c = q[qh++];
    const x = c % gw, y = (c / gw) | 0;
    const dc = dist[c] + 1;
    const tryN = (m) => { if (g[m] === 0 && dist[m] < 0) { dist[m] = dc; prev[m] = c; q[qt++] = m; } };
    if (x > 0) tryN(c - 1);
    if (x < gw - 1) tryN(c + 1);
    if (y > 0) tryN(c - gw);
    if (y < gh - 1) tryN(c + gw);
  }
  return { dist, prev };
}

function stampDisc(g, gw, gh, cx, cy, r) {
  let opened = 0;
  const x0 = Math.max(3, Math.floor(cx - r)), x1 = Math.min(gw - 4, Math.ceil(cx + r));
  const y0 = Math.max(3, Math.floor(cy - r)), y1 = Math.min(gh - 4, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r && g[y * gw + x] === 1) { g[y * gw + x] = 0; opened++; }
    }
  }
  return opened;
}

/* ------------------------------------------------------------------ */
/* Field queries                                                       */
/* ------------------------------------------------------------------ */
function bilinear(lv, fx, fy) {
  const W = lv.W;
  const x0 = fx | 0, y0 = fy | 0;
  const tx = fx - x0, ty = fy - y0;
  const i = y0 * W + x0, s = lv.sdf;
  const a = s[i], b = s[i + 1], c = s[i + W], d = s[i + W + 1];
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

// Signed distance to the nearest wall in px (positive = open water).
export function sdfAt(lv, x, y) {
  const W = lv.W, H = lv.H;
  const fx = x / CELL - 0.5, fy = y / CELL - 0.5;
  if (fx < 0 || fy < 0 || fx >= W - 1 || fy >= H - 1) {
    const cx = fx < 0 ? 0 : fx > W - 1.001 ? W - 1.001 : fx;
    const cy = fy < 0 ? 0 : fy > H - 1.001 ? H - 1.001 : fy;
    const base = bilinear(lv, cx, cy);
    return Math.min(base, 0) - Math.hypot(fx - cx, fy - cy) * CELL;
  }
  return bilinear(lv, fx, fy);
}

export function gradAt(lv, x, y, out) {
  const h = CELL * 0.75;
  const gx = sdfAt(lv, x + h, y) - sdfAt(lv, x - h, y);
  const gy = sdfAt(lv, x, y + h) - sdfAt(lv, x, y - h);
  const m = Math.hypot(gx, gy);
  if (m < 1e-6) { out.x = 0; out.y = -1; } else { out.x = gx / m; out.y = gy / m; }
  return out;
}

const _g = { x: 0, y: 0 };

// Push a circle out of the walls. e needs x,y,vx,vy. Returns true on contact (and sets e.hitNx/hitNy).
export function resolveCircle(lv, e, r, bounce = 0) {
  let hit = false;
  for (let i = 0; i < 6; i++) { // a few extra passes: the noisy field is not an exact distance, so one push can under-shoot
    const s = sdfAt(lv, e.x, e.y);
    if (s >= r) break;
    gradAt(lv, e.x, e.y, _g);
    const push = r - s;
    e.x += _g.x * Math.min(push, 24);
    e.y += _g.y * Math.min(push, 24);
    const vn = e.vx * _g.x + e.vy * _g.y;
    if (vn < 0) {
      e.vx -= (1 + bounce) * vn * _g.x;
      e.vy -= (1 + bounce) * vn * _g.y;
    }
    e.hitNx = _g.x; e.hitNy = _g.y;
    hit = true;
  }
  return hit;
}

// Integrate a body with sub-stepping so fast movers can't tunnel.
export function moveBody(lv, e, r, dt, bounce = 0) {
  const sp = Math.hypot(e.vx, e.vy) * dt;
  const steps = Math.max(1, Math.ceil(sp / 4));
  const h = dt / steps;
  let hit = false;
  for (let i = 0; i < steps; i++) {
    e.x += e.vx * h;
    e.y += e.vy * h;
    if (resolveCircle(lv, e, r, bounce)) hit = true;
  }
  return hit;
}

// Distance along (dx,dy) (unit) until the wall surface, or maxD.
// (the iteration cap is generous on purpose: a ray skimming a wall takes many tiny steps and must not be cut short)
export function rayMarch(lv, x, y, dx, dy, maxD) {
  let t = 0;
  for (let i = 0; i < 320; i++) {
    const s = sdfAt(lv, x + dx * t, y + dy * t);
    if (s < 0.6) return t;
    t += Math.max(s * 0.88, 1.2);
    if (t >= maxD) return maxD;
  }
  return Math.min(t, maxD);
}

// True if a body of radius r can slide in a straight line from a to b.
export function lineClear(lv, ax, ay, bx, by, r = 2) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-3) return true;
  const ux = dx / len, uy = dy / len;
  let t = 0;
  while (t < len) {
    const s = sdfAt(lv, ax + ux * t, ay + uy * t);
    if (s < r) return false;
    t += Math.max(s - r, 2.5);
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Navigation (coarse grid BFS flow fields)                            */
/* ------------------------------------------------------------------ */
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

export function cellOf(lv, x, y) {
  const cx = clamp(Math.floor(x / COARSE), 0, lv.gw - 1);
  const cy = clamp(Math.floor(y / COARSE), 0, lv.gh - 1);
  return cy * lv.gw + cx;
}

function nearestOpen(lv, nav, c, rad = 5) {
  if (nav[c]) return c;
  const gw = lv.gw, gh = lv.gh;
  const cx = c % gw, cy = (c / gw) | 0;
  for (let r = 1; r <= rad; r++) {
    let best = -1, bd = 1e9;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
        const m = y * gw + x;
        if (nav[m] && dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = m; }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

// Fills dist (Int16Array, -1 = unreachable) with BFS steps from the target. Returns the source cell or -1.
export function bfsNav(lv, cls, tx, ty, dist, queue) {
  const nav = lv.nav[cls];
  const gw = lv.gw, gh = lv.gh;
  dist.fill(-1);
  const c0 = nearestOpen(lv, nav, cellOf(lv, tx, ty));
  if (c0 < 0) return -1;
  let qh = 0, qt = 0;
  queue[qt++] = c0; dist[c0] = 0;
  while (qh < qt) {
    const c = queue[qh++];
    const x = c % gw, y = (c / gw) | 0;
    const dc = dist[c] + 1;
    for (let k = 0; k < 8; k++) {
      const dx = DIRS[k][0], dy = DIRS[k][1];
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const m = ny * gw + nx;
      if (!nav[m] || dist[m] >= 0) continue;
      if (k >= 4 && !(nav[y * gw + nx] && nav[ny * gw + x])) continue;
      dist[m] = dc; queue[qt++] = m;
    }
  }
  return c0;
}

// Direction from (x,y) along a BFS field. Returns false if no useful direction exists.
export function flowDir(lv, cls, dist, x, y, tx, ty, out) {
  const nav = lv.nav[cls];
  const gw = lv.gw, gh = lv.gh;
  const c = cellOf(lv, x, y);
  const cx = c % gw, cy = (c / gw) | 0;
  const here = dist[c];
  if (here >= 0 && here <= 1) {
    const dx = tx - x, dy = ty - y, m = Math.hypot(dx, dy);
    if (m > 1) { out.x = dx / m; out.y = dy / m; return true; }
    out.x = 0; out.y = 0; return true;
  }
  let best = -1, bd = here >= 0 ? here : 32767;
  for (let k = 0; k < 8; k++) {
    const nx = cx + DIRS[k][0], ny = cy + DIRS[k][1];
    if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
    const m = ny * gw + nx;
    const dm = dist[m];
    if (dm < 0 || dm >= bd) continue;
    if (k >= 4 && !(nav[cy * gw + nx] && nav[ny * gw + cx])) continue;
    bd = dm; best = m;
  }
  if (best < 0) {
    // standing outside the nav class (a tight spot after a shove): swim to the nearest navigable cell within two steps
    if (here < 0) {
      let nd = 1e9;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh || dist[ny * gw + nx] < 0) continue;
        const dd = dx * dx + dy * dy;
        if (dd < nd) { nd = dd; best = ny * gw + nx; }
      }
      if (best >= 0) {
        const ax = (best % gw + 0.5) * COARSE - x, ay = (((best / gw) | 0) + 0.5) * COARSE - y, am = Math.hypot(ax, ay) || 1;
        out.x = ax / am; out.y = ay / am;
        return true;
      }
    }
    return false;
  }
  // look one step further along the gradient to cut corners smoothly
  let tx2 = (best % gw + 0.5) * COARSE, ty2 = (((best / gw) | 0) + 0.5) * COARSE;
  const bx = best % gw, by = (best / gw) | 0;
  let best2 = -1, bd2 = bd;
  for (let k = 0; k < 8; k++) {
    const nx = bx + DIRS[k][0], ny = by + DIRS[k][1];
    if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
    const m = ny * gw + nx;
    const dm = dist[m];
    if (dm < 0 || dm >= bd2) continue;
    if (k >= 4 && !(nav[by * gw + nx] && nav[ny * gw + bx])) continue;
    bd2 = dm; best2 = m;
  }
  if (best2 >= 0) {
    const ax = (best2 % gw + 0.5) * COARSE, ay = (((best2 / gw) | 0) + 0.5) * COARSE;
    tx2 = (tx2 + ax) * 0.5; ty2 = (ty2 + ay) * 0.5;
  }
  const dx = tx2 - x, dy = ty2 - y, m = Math.hypot(dx, dy) || 1;
  out.x = dx / m; out.y = dy / m;
  return true;
}

// Reusable BFS buffers for an agent.
export class NavField {
  constructor(lv) {
    this.dist = new Int16Array(lv.gw * lv.gh);
    this.queue = new Int32Array(lv.gw * lv.gh);
    this.tx = 0; this.ty = 0; this.valid = false; this.cls = 'S';
  }
  compute(lv, cls, tx, ty) {
    this.cls = cls; this.tx = tx; this.ty = ty;
    this.valid = bfsNav(lv, cls, tx, ty, this.dist, this.queue) >= 0;
    return this.valid;
  }
  dir(lv, x, y, out) {
    if (!this.valid) return false;
    return flowDir(lv, this.cls, this.dist, x, y, this.tx, this.ty, out);
  }
  steps(lv, x, y) { return this.valid ? this.dist[cellOf(lv, x, y)] : -1; }
}

/* ------------------------------------------------------------------ */
/* Level generation                                                    */
/* ------------------------------------------------------------------ */
// Largest 8-connected patch of one nav class as a mask (same corner rule as bfsNav).
function biggestPatch(lv, cls, allow) {
  const nav = lv.nav[cls], gw = lv.gw, gh = lv.gh, n = gw * gh;
  const lab = new Int32Array(n).fill(-1), q = new Int32Array(n);
  let best = -1, bestN = 0, nl = 0;
  for (let c0 = 0; c0 < n; c0++) {
    if (!nav[c0] || (allow && !allow[c0]) || lab[c0] >= 0) continue;
    let qh = 0, qt = 0;
    q[qt++] = c0; lab[c0] = nl;
    while (qh < qt) {
      const c = q[qh++], x = c % gw, y = (c / gw) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const m = ny * gw + nx;
        if (!nav[m] || (allow && !allow[m]) || lab[m] >= 0) continue;
        if (k >= 4 && !(nav[y * gw + nx] && nav[ny * gw + x])) continue;
        lab[m] = nl; q[qt++] = m;
      }
    }
    if (qt > bestN) { bestN = qt; best = nl; }
    nl++;
  }
  const mask = new Uint8Array(n);
  if (best >= 0) for (let i = 0; i < n; i++) if (lab[i] === best) mask[i] = 1;
  return { mask, size: bestN };
}

// shortest acceptable start -> exit trip in nav cells (8-connected, class S); shorter layouts are re-rolled
const minRoute = (depth) => Math.min(110, 68 + depth * 4);

function tryGenerate(seed, depth, attempt) {
  const rng = new RNG(seed);
  const { gw, gh } = levelSize(depth);
  const final = depth >= MAX_DEPTH;
  const n = gw * gh;

  // 1. tunnels and chambers
  const g = new Uint8Array(n);
  carveNetwork(g, gw, gh, rng, final ? CARVE_FINAL : CARVE[biomeFor(depth).id]);
  let kl = keepLargest(g, gw, gh);
  g.set(kl.g);
  if (kl.area < n * 0.1) return null;
  const P = final ? CARVE_FINAL : CARVE[biomeFor(depth).id];
  addPillars(g, gw, gh, rng, P.pil, P.gap);

  // 2. pick far-apart start/exit (double BFS sweep) and carve a wide route between them
  const open = [];
  for (let i = 0; i < n; i++) if (g[i] === 0) open.push(i);
  const a = open[rng.int(0, open.length - 1)];
  const d1 = bfsCoarse(g, gw, gh, a);
  let s = a, sd = -1;
  const M = 9;
  const inner = (i) => { const x = i % gw, y = (i / gw) | 0; return x >= M && y >= M && x < gw - M && y < gh - M; };
  for (let i = 0; i < n; i++) if (inner(i) && d1.dist[i] > sd) { sd = d1.dist[i]; s = i; }
  if (sd < 0) return null;
  const d2 = bfsCoarse(g, gw, gh, s);
  let e = s, ed = -1;
  for (let i = 0; i < n; i++) if (inner(i) && d2.dist[i] > ed) { ed = d2.dist[i]; e = i; }
  if (ed < Math.min(gw, gh) * 0.6) return null;

  const brush = (final ? 3.9 : 2.5) + attempt * 0.3;
  for (let c = e; c !== -1; c = d2.prev[c]) stampDisc(g, gw, gh, c % gw, (c / gw) | 0, brush);
  stampDisc(g, gw, gh, s % gw, (s / gw) | 0, final ? 5.2 : 4.4);
  stampDisc(g, gw, gh, e % gw, (e / gw) | 0, final ? 5.2 : 4.4);
  kl = keepLargest(g, gw, gh);
  g.set(kl.g);

  // 3. fine signed distance field with smoothed, rocky walls
  const W = gw * 2, H = gh * 2;
  const solid = new Uint8Array(W * H), openF = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = g[(y >> 1) * gw + (x >> 1)];
      solid[y * W + x] = v; openF[y * W + x] = v ? 0 : 1;
    }
  }
  const dS = edtSq(solid, W, H), dO = edtSq(openF, W, H);
  const sdf = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    sdf[i] = solid[i] ? -(Math.sqrt(dO[i]) - 0.5) * CELL : (Math.sqrt(dS[i]) - 0.5) * CELL;
  }
  boxBlur(sdf, W, H, 2);
  boxBlur(sdf, W, H, 2);
  const ns1 = rng.int(1, 99999), ns2 = rng.int(1, 99999);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      sdf[y * W + x] += (noise2(x * 0.085, y * 0.085, ns1) - 0.5) * 7 + (noise2(x * 0.22, y * 0.22, ns2) - 0.5) * 3;
    }
  }

  const lv = {
    seed, depth, biome: biomeFor(depth), gw, gh, W, H,
    width: gw * COARSE, height: gh * COARSE, sdf,
    nav: { S: new Uint8Array(n), L: new Uint8Array(n), XL: new Uint8Array(n) },
    clear: new Float32Array(n),
    start: { x: (s % gw + 0.5) * COARSE, y: (((s / gw) | 0) + 0.5) * COARSE },
    exit: { x: (e % gw + 0.5) * COARSE, y: (((e / gw) | 0) + 0.5) * COARSE },
  };

  // 4. navigation classes
  for (let c = 0; c < n; c++) {
    const sv = sdfAt(lv, (c % gw + 0.5) * COARSE, (((c / gw) | 0) + 0.5) * COARSE);
    lv.clear[c] = sv;
    lv.nav.S[c] = sv >= 15 ? 1 : 0;
    lv.nav.L[c] = sv >= 21 ? 1 : 0;
    lv.nav.XL[c] = sv >= 40 ? 1 : 0;
  }
  const dist = new Int16Array(n), queue = new Int32Array(n);
  if (bfsNav(lv, 'S', lv.start.x, lv.start.y, dist, queue) < 0) return null;
  if (dist[e] < 0) return null; // exit not reachable for the player
  const relax = attempt >= 9; // never let a stubborn seed throw: the quality bars drop after nine failed rolls
  if (!relax && dist[e] < minRoute(depth)) return null; // too short a trip: re-roll
  const reach = [];
  for (let c = 0; c < n; c++) if (dist[c] >= 0) reach.push(c);
  if (reach.length < n * 0.12) return null;
  lv.startDist = dist;
  lv.routeLength = dist[e];
  lv.reach = reach.length;

  // 5. content placement
  const table = spawnTable(depth);
  const prng = rng.sub('place');
  let cells = reach.slice();
  // o: minClear/maxClear (coarse cell clearance), minSdf (exact clearance at the spot), minDist (route steps from start),
  //    avoidStart/avoidExit (px), sep (px to earlier items in 'avoid'), nav (required nav class), r (nominal radius),
  //    keep (hazards to stay clear of: r + o.r + 22 px)
  const place = (count, o, avoid) => {
    const out = [];
    prng.shuffle(cells);
    for (const c of cells) {
      if (out.length >= count) break;
      const clr = lv.clear[c];
      if (clr < (o.minClear || 0) || clr > (o.maxClear || 1e9)) continue;
      if (dist[c] < (o.minDist || 0)) continue;
      if (o.nav && !lv.nav[o.nav][c]) continue;
      if (o.mask && !o.mask[c]) continue;
      const x = (c % gw + 0.5) * COARSE + prng.range(-5, 5);
      const y = (((c / gw) | 0) + 0.5) * COARSE + prng.range(-5, 5);
      const sv = sdfAt(lv, x, y);
      if (sv < (o.minSdf !== undefined ? o.minSdf : Math.max((o.minClear || 0) * 0.85, 12))) continue;
      if (o.avoidStart && Math.hypot(x - lv.start.x, y - lv.start.y) < o.avoidStart) continue;
      if (o.avoidExit && Math.hypot(x - lv.exit.x, y - lv.exit.y) < o.avoidExit) continue;
      let ok = true;
      for (const p of avoid) if (Math.hypot(p.x - x, p.y - y) < Math.max(o.sep || 0, p.sep || 0)) { ok = false; break; }
      if (ok && o.keep) for (const h of o.keep) if (Math.hypot(h.x - x, h.y - y) < h.r + (o.r || 8) + 22) { ok = false; break; }
      if (!ok || (o.block && !pinchOk(x, y, o.block))) continue;
      const item = { x, y, sep: o.sep || 0, r: o.r || 8 };
      avoid.push(item); out.push(item);
    }
    return out;
  };

  // A static blocker (urchin, angler) must never pinch a passage shut. Local topology test on the fine field: label the water the player
  // (r 9) can use inside a window around the spot, with and without a disc of radius R at the spot; if two bits of window border that
  // were connected become separated, the disc would cut a corridor.
  const pinchOk = (x, y, R) => {
    const K = 14, ci = Math.floor(x / CELL), cj = Math.floor(y / CELL);
    const i0 = Math.max(0, ci - K), i1 = Math.min(W - 1, ci + K), j0 = Math.max(0, cj - K), j1 = Math.min(H - 1, cj + K);
    const w = i1 - i0 + 1, h = j1 - j0 + 1, m = w * h;
    const lab = (blockR) => {
      const L = new Int16Array(m).fill(-1), q = new Int16Array(m);
      let nl = 0;
      const open = (i, j) => sdf[(j0 + j) * W + i0 + i] >= 10 && !(blockR > 0 && Math.hypot((i0 + i + 0.5) * CELL - x, (j0 + j + 0.5) * CELL - y) < blockR);
      for (let c0 = 0; c0 < m; c0++) {
        if (L[c0] >= 0 || !open(c0 % w, (c0 / w) | 0)) continue;
        let qh = 0, qt = 0; q[qt++] = c0; L[c0] = nl;
        while (qh < qt) {
          const c = q[qh++], i = c % w, j = (c / w) | 0;
          for (let k = 0; k < 8; k++) {
            const ni = i + DIRS[k][0], nj = j + DIRS[k][1];
            if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
            const nc = nj * w + ni;
            if (L[nc] >= 0 || !open(ni, nj)) continue;
            if (k >= 4 && !(open(ni, j) && open(i, nj))) continue;
            L[nc] = nl; q[qt++] = nc;
          }
        }
        nl++;
      }
      return L;
    };
    const A = lab(0), B = lab(R), seen = new Map();
    for (let c = 0; c < m; c++) {
      const i = c % w, j = (c / w) | 0;
      if ((i && j && i < w - 1 && j < h - 1) || A[c] < 0) continue; // window border cells only
      const b = B[c];
      if (seen.has(A[c])) { if (seen.get(A[c]) !== b) return false; } else seen.set(A[c], b);
    }
    return true;
  };

  const hazards = [], loot = [];
  const sp = {};
  sp.urchins = place(table.urchin, { minClear: 35, minDist: 14, sep: 120, avoidStart: 180, avoidExit: 150, r: 13, block: 30 }, hazards);
  if (sp.urchins.length < table.urchin) sp.urchins.push(...place(table.urchin - sp.urchins.length, { minClear: 30, minDist: 14, sep: 120, avoidStart: 180, avoidExit: 150, r: 13, block: 30 }, hazards)); // tight cave: settle for narrower spots
  // Last line of defence: urchins never move, so flood the fine field (water a 9 px player can use, sdf >= 10) with a 24 px disc blocked
  // around every urchin and drop urchins until the exit is reachable again. Later spawns only use cells that stay reachable.
  const fineSeen = new Uint8Array(W * H), fineQ = new Int32Array(W * H), fineBlock = new Uint8Array(W * H);
  const floodWithUrchins = () => {
    fineBlock.fill(0); fineSeen.fill(0);
    for (const u of sp.urchins) {
      const ci = Math.floor(u.x / CELL), cj = Math.floor(u.y / CELL);
      for (let j = Math.max(0, cj - 4); j <= Math.min(H - 1, cj + 4); j++) for (let i = Math.max(0, ci - 4); i <= Math.min(W - 1, ci + 4); i++) {
        if (Math.hypot((i + 0.5) * CELL - u.x, (j + 0.5) * CELL - u.y) < 24) fineBlock[j * W + i] = 1;
      }
    }
    const open = (i) => sdf[i] >= 10 && !fineBlock[i];
    let qh = 0, qt = 0;
    const s0 = Math.floor(lv.start.y / CELL) * W + Math.floor(lv.start.x / CELL);
    fineQ[qt++] = s0; fineSeen[s0] = 1;
    while (qh < qt) {
      const c = fineQ[qh++], x = c % W, y = (c / W) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const m = ny * W + nx;
        if (fineSeen[m] || !open(m)) continue;
        if (k >= 4 && !(open(y * W + nx) && open(ny * W + x))) continue;
        fineSeen[m] = 1; fineQ[qt++] = m;
      }
    }
  };
  floodWithUrchins();
  while (sp.urchins.length && !fineSeen[Math.floor(lv.exit.y / CELL) * W + Math.floor(lv.exit.x / CELL)]) { const u = sp.urchins.pop(); hazards.splice(hazards.indexOf(u), 1); floodWithUrchins(); }
  const safe = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    const i = (c % gw) * 2, j = ((c / gw) | 0) * 2;
    safe[c] = dist[c] >= 0 ? (fineSeen[j * W + i] | fineSeen[j * W + i + 1] | fineSeen[(j + 1) * W + i] | fineSeen[(j + 1) * W + i + 1]) : 0;
  }
  cells = cells.filter((c) => safe[c]);
  // jellies and anglers navigate with the L-class field: keep them in the big connected L patch so sound can always lure them
  const lmask = biggestPatch(lv, 'L', safe).mask;
  sp.anglers = [];
  if (table.angler) {
    const raw = place(table.angler, { minClear: 25, maxClear: 44, minDist: 28, sep: 200, avoidStart: 300, avoidExit: 160, r: 17, mask: lmask, block: 32 }, hazards);
    const gtmp = { x: 0, y: 0 };
    for (const p of raw) {
      gradAt(lv, p.x, p.y, gtmp);
      // needs open water in front of it, otherwise it would block a tunnel
      if (sdfAt(lv, p.x + gtmp.x * 70, p.y + gtmp.y * 70) < 36) { hazards.splice(hazards.indexOf(p), 1); continue; }
      sp.anglers.push({ x: p.x, y: p.y, a: Math.atan2(gtmp.y, gtmp.x) });
    }
  }
  sp.eels = place(table.eel, { minClear: 22, minDist: 30, sep: 260, avoidStart: 380, avoidExit: 150, r: 11 }, hazards);
  sp.jellies = place(table.jelly, { minClear: 26, minDist: 20, sep: 150, avoidStart: 300, avoidExit: 120, r: 15, mask: lmask }, hazards);
  sp.leviathan = null;
  lv.xlCells = [];
  if (table.leviathan) {
    // the boss needs a big connected sea it can actually swim (nav XL); re-roll the level if there isn't one
    const xp = biggestPatch(lv, 'XL', safe);
    if (xp.size < reach.length * (relax ? 0.12 : 0.35)) return null;
    // it spawns in a roomy, far-off part of that sea, clear of every other hazard
    let lp = place(1, { minClear: 46, minSdf: 40, minDist: 40, mask: xp.mask, sep: 200, avoidStart: 380, avoidExit: 220, r: 27 }, hazards)[0];
    if (!lp) lp = place(1, { minClear: 42, minSdf: 36, minDist: 20, mask: xp.mask, sep: 120, avoidStart: 300, r: 27 }, hazards)[0];
    if (!lp) {
      const xl = reach.filter((c) => xp.mask[c]);
      if (xl.length) { const c = xl[prng.int(0, xl.length - 1)]; lp = { x: (c % gw + 0.5) * COARSE, y: (((c / gw) | 0) + 0.5) * COARSE }; }
    }
    if (lp) {
      sp.leviathan = { x: lp.x, y: lp.y };
      const d3 = new Int16Array(n), q3 = new Int32Array(n);
      bfsNav(lv, 'XL', lp.x, lp.y, d3, q3);
      for (let k = 0; k < n; k++) if (d3[k] >= 0) lv.xlCells.push(k);
    }
  }
  // loot keeps clear of every hazard so nothing sits inside a creature on spawn. The rare pickups (repair patches, buoys) go first
  // and spread out among themselves only; pearls then fill in around them.
  const rare = [];
  sp.patches = place(table.patches, { minClear: 22, minDist: 24, sep: 320, avoidStart: 300, r: 11, keep: hazards }, rare);
  sp.buoys = place(table.buoys, { minClear: 22, minDist: 16, sep: 260, r: 10, keep: hazards }, rare);
  const keepAll = hazards.concat(rare);
  sp.pearls = place(table.pearls, { minClear: 20, minDist: 8, sep: 80, r: 8, keep: keepAll }, loot);
  // sweeten the pearls: some come in small clusters
  const extra = [];
  for (let i = 0; i < sp.pearls.length; i += 2) {
    const p = sp.pearls[i];
    for (let k = 0; k < 2; k++) {
      const ang = prng.range(0, TAU), rr = prng.range(16, 26);
      const x = p.x + Math.cos(ang) * rr, y = p.y + Math.sin(ang) * rr;
      if (sdfAt(lv, x, y) <= 14) continue;
      let ok = true;
      for (const h of keepAll) if (Math.hypot(h.x - x, h.y - y) < h.r + 8 + 22) { ok = false; break; }
      if (ok) extra.push({ x, y });
    }
  }
  sp.pearls.push(...extra);
  lv.spawns = sp;

  // patrol waypoints for hunters
  lv.patrol = reach.filter((c) => lv.clear[c] >= 24);
  if (lv.patrol.length < 20) lv.patrol = reach.slice();

  // 6. bioluminescent flora clinging to the walls
  const flora = [];
  const area = reach.length * COARSE * COARSE;
  const wantFlora = clamp(Math.round(area / 3600), 150, 700);
  const frng = rng.sub('flora');
  const gtmp = { x: 0, y: 0 };
  const surf = [];
  for (let y = 4; y < H - 4; y++) for (let x = 4; x < W - 4; x++) { const sv = sdf[y * W + x]; if (sv > 0.5 && sv < 4) surf.push(y * W + x); }
  for (let tries = 0; surf.length && tries < wantFlora * 8 && flora.length < wantFlora; tries++) {
    const idx = surf[frng.int(0, surf.length - 1)];
    const fx = idx % W, fy = (idx / W) | 0;
    let bx = (fx + 0.5) * CELL, by = (fy + 0.5) * CELL;
    // the field is noisy (not an exact distance), so walk onto the rock surface by iterating towards the zero level
    for (let k = 0; k < 4; k++) { const s0 = sdfAt(lv, bx, by); gradAt(lv, bx, by, gtmp); bx -= gtmp.x * s0; by -= gtmp.y * s0; }
    if (Math.abs(sdfAt(lv, bx, by)) > 0.8) continue;
    gradAt(lv, bx, by, gtmp);
    if (sdfAt(lv, bx + gtmp.x * 30, by + gtmp.y * 30) < 14) continue;
    const r = frng.next();
    const type = r < 0.4 ? 0 : r < 0.76 ? 1 : 2; // 0 kelp, 1 coral, 2 bulb
    let len = type === 0 ? frng.range(34, 96) : type === 1 ? frng.range(14, 30) : frng.range(10, 20);
    // never let a stalk poke through the opposite wall: trim it to the free room in front of it
    const free = rayMarch(lv, bx + gtmp.x * 2, by + gtmp.y * 2, gtmp.x, gtmp.y, len + 8);
    if (free < len) { len = free * 0.88; if (len < 10) continue; }
    flora.push({
      x: bx, y: by, nx: gtmp.x, ny: gtmp.y, type, len,
      hue: frng.range(-26, 26) + (frng.chance(0.16) ? 70 : 0),
      phase: frng.range(0, TAU), n: frng.int(2, 5), lit: 0,
    });
  }
  lv.flora = flora;

  // 7. ocean currents in the deeper biomes
  const currents = [];
  if (depth >= 5) {
    const want = depth >= 10 ? 4 : depth >= 7 ? 3 : 2;
    const cur = [];
    // wide open water only (a gentle push, never a squeeze against the walls), and never on top of the start
    const found = place(want, { minClear: 52, minSdf: 50, minDist: 18, sep: 420, avoidStart: 220 }, cur);
    for (const p of found) {
      currents.push({ x: p.x, y: p.y, r: prng.range(110, 160), ang: prng.range(0, TAU), force: prng.range(70, 120) });
    }
  }
  lv.currents = currents;
  return lv;
}

export function generateLevel(seed, depth) {
  let last = null;
  for (let attempt = 0; attempt < 14; attempt++) {
    const lv = tryGenerate(seed + '#' + depth + '.' + attempt, depth, attempt);
    if (lv) { lv.attempt = attempt; return lv; }
    last = attempt;
  }
  throw new Error('level generation failed for ' + seed + ' depth ' + depth + ' (' + last + ')');
}
