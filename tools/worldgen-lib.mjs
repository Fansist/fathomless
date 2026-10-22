// Shared helpers for the worldgen test tools (Node only, DOM-free).
import { sdfAt, gradAt, cellOf } from '../js/world.js';
import { CELL, COARSE } from '../js/config.js';

export const pct = (a, p) => {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// Flood the fine (8 px) SDF grid from (sx,sy): cells with sdf >= thr are open for a body of that radius,
// optional circular blockers [{x,y,r}] are removed. 8-connected with the usual no-corner-cutting rule.
export function fineFlood(lv, sx, sy, thr, blockers = []) {
  const W = lv.W, H = lv.H, sdf = lv.sdf;
  const open = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) open[i] = sdf[i] >= thr ? 1 : 0;
  for (const b of blockers) {
    const x0 = Math.max(0, Math.floor((b.x - b.r) / CELL - 1)), x1 = Math.min(W - 1, Math.ceil((b.x + b.r) / CELL + 1));
    const y0 = Math.max(0, Math.floor((b.y - b.r) / CELL - 1)), y1 = Math.min(H - 1, Math.ceil((b.y + b.r) / CELL + 1));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5) * CELL - b.x, dy = (y + 0.5) * CELL - b.y;
      if (dx * dx + dy * dy < b.r * b.r) open[y * W + x] = 0;
    }
  }
  const seen = new Uint8Array(W * H);
  let sc = Math.floor(sy / CELL) * W + Math.floor(sx / CELL);
  if (!open[sc]) { // snap to the best neighbour
    let bs = -1e9, bi = -1;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = Math.floor(sx / CELL) + dx, y = Math.floor(sy / CELL) + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (open[y * W + x] && sdf[y * W + x] > bs) { bs = sdf[y * W + x]; bi = y * W + x; }
    }
    if (bi < 0) return seen;
    sc = bi;
  }
  const q = new Int32Array(W * H);
  let qh = 0, qt = 0;
  q[qt++] = sc; seen[sc] = 1;
  while (qh < qt) {
    const c = q[qh++];
    const x = c % W, y = (c / W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const m = ny * W + nx;
      if (seen[m] || !open[m]) continue;
      if (dx && dy && !(open[y * W + nx] && open[ny * W + x])) continue;
      seen[m] = 1; q[qt++] = m;
    }
  }
  return seen;
}

// Is world point (x,y) inside (or within one fine cell of) a flooded region?
export function inFlood(lv, seen, x, y) {
  const W = lv.W, H = lv.H;
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = cx + dx, ny = cy + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    if (seen[ny * W + nx]) return true;
  }
  return false;
}

const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];

// Shortest route (list of coarse cells, exit -> start) following the S-class BFS field downhill.
export function traceRoute(lv) {
  const dist = lv.startDist, gw = lv.gw, gh = lv.gh;
  const nav = lv.nav.S;
  let c = cellOf(lv, lv.exit.x, lv.exit.y);
  if (dist[c] < 0) { // exit cell centre may fall outside nav: take nearest reachable neighbour
    let bd = 1e9;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const x = (c % gw) + dx, y = ((c / gw) | 0) + dy;
      if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
      const m = y * gw + x;
      if (dist[m] >= 0 && dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; c = m; }
    }
  }
  const path = [c];
  let px = 0;
  for (let guard = 0; guard < 5000 && dist[c] > 0; guard++) {
    const cx = c % gw, cy = (c / gw) | 0;
    let best = -1, bd = dist[c];
    for (let k = 0; k < 8; k++) {
      const nx = cx + D8[k][0], ny = cy + D8[k][1];
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const m = ny * gw + nx;
      if (dist[m] < 0 || dist[m] >= bd) continue;
      if (k >= 4 && !(nav[cy * gw + nx] && nav[ny * gw + cx])) continue;
      bd = dist[m]; best = m;
    }
    if (best < 0) break;
    px += (best % gw !== cx && ((best / gw) | 0) !== cy ? Math.SQRT2 : 1) * COARSE;
    c = best; path.push(c);
  }
  return { path, px };
}

// Level-shape statistics on the player-reachable coarse cells.
// chamberClear: coarse-cell clearance (px) that counts as 'roomy'. The boss level's tunnels are 100+ px wide on purpose (the leviathan must
// fit), so it is judged with a stricter 72 px threshold; everywhere else 48 px.
export function shapeStats(lv, chamberClear = lv.depth >= 12 ? 72 : 48) {
  const gw = lv.gw, gh = lv.gh, n = gw * gh, dist = lv.startDist;
  const reach = lv.reach;
  // chambers: connected blobs of very roomy cells
  const chamber = new Uint8Array(n);
  let chamberCells = 0;
  for (let c = 0; c < n; c++) if (dist[c] >= 0 && lv.clear[c] >= chamberClear) { chamber[c] = 1; chamberCells++; }
  const lab = new Int32Array(n).fill(-1);
  const q = new Int32Array(n);
  const comps = [];
  for (let c = 0; c < n; c++) {
    if (!chamber[c] || lab[c] >= 0) continue;
    let qh = 0, qt = 0; q[qt++] = c; lab[c] = comps.length;
    while (qh < qt) {
      const a = q[qh++], x = a % gw, y = (a / gw) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + D8[k][0], ny = y + D8[k][1];
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const m = ny * gw + nx;
        if (chamber[m] && lab[m] < 0) { lab[m] = comps.length; q[qt++] = m; }
      }
    }
    comps.push(qt);
  }
  const big = comps.filter((s) => s >= 8);
  const biggest = comps.length ? Math.max(...comps) : 0;
  let tunnelCells = 0;
  for (let c = 0; c < n; c++) if (dist[c] >= 0 && lv.clear[c] < chamberClear * 0.75) tunnelCells++;
  // dead ends: local maxima of the BFS distance, clustered
  const maxima = [];
  for (let c = 0; c < n; c++) {
    if (dist[c] < 12) continue;
    const x = c % gw, y = (c / gw) | 0;
    let isMax = true;
    for (let k = 0; k < 8 && isMax; k++) {
      const nx = x + D8[k][0], ny = y + D8[k][1];
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const m = ny * gw + nx;
      if (dist[m] > dist[c]) isMax = false;
    }
    if (isMax) maxima.push(c);
  }
  const clusters = [];
  for (const c of maxima) {
    const x = c % gw, y = (c / gw) | 0;
    let hit = null;
    for (const cl of clusters) if (Math.abs(cl.x - x) <= 12 && Math.abs(cl.y - y) <= 12) { hit = cl; break; }
    if (hit) { if (dist[c] > hit.d) { hit.d = dist[c]; hit.x = x; hit.y = y; } } else clusters.push({ x, y, d: dist[c] });
  }
  const ec = cellOf(lv, lv.exit.x, lv.exit.y);
  const ex = ec % gw, ey = (ec / gw) | 0;
  const deadEnds = clusters.filter((cl) => !(Math.abs(cl.x - ex) <= 14 && Math.abs(cl.y - ey) <= 14)).length;
  let openFine = 0;
  for (let i = 0; i < lv.W * lv.H; i++) if (lv.sdf[i] > 0) openFine++;
  return {
    chambers: big.length, chamberFrac: chamberCells / reach, biggestChamberFrac: biggest / reach,
    tunnelFrac: tunnelCells / reach, deadEnds, openFrac: openFine / (lv.W * lv.H), reachFrac: reach / n,
  };
}
