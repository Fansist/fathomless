// Per-frame cost of the creature update (headless, no rendering).
//   node tools/ai-perf.mjs [--root <project dir>] [--depth 12] [--seeds 6] [--bot naive|careful] [--secs 60]
// Prints the per-frame wall time of ALL entity updates together (mean / p99 / max ms) and per creature type.
// Use --root to compare against another copy of the game (e.g. the original) for a before/after table.
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadModules, makeGame, seedMath, Pilot, applyLoadout } from './ai-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const root = path.resolve(opt('root', path.join(here, '..')));
const depth = +opt('depth', 12), seeds = +opt('seeds', 6), secs = +opt('secs', 60), kinds = opt('bot', 'naive,careful').split(',');

const M = await loadModules(pathToFileURL(root + '/js/').href);
// time every flow-field computation (whatever class the creatures use)
const navStat = { calls: 0, ms: 0, max: 0 };
{
  const g0 = makeGame(M); g0.startRun({ seed: 'navprobe' }); g0.loadLevel(depth); g0.god = true;
  const probe = M.entities.makeEnemy('eel', { x: g0.lv.start.x, y: g0.lv.start.y }, depth);
  g0.enemies = [probe]; g0.update(1 / 60);
  const proto = Object.getPrototypeOf(probe.nav), orig = proto.compute;
  proto.compute = function (...a) { const t0 = performance.now(); const r = orig.apply(this, a); const d = performance.now() - t0; navStat.calls++; navStat.ms += d; if (d > navStat.max) navStat.max = d; return r; };
}
const all = [];
const per = {};
let worst = { ms: 0 };
for (const kind of kinds) {
  for (let s = 0; s < seeds; s++) {
    const seed = 'p' + s;
    seedMath('perf|' + kind + '|' + seed);
    const g = makeGame(M);
    g.startRun({ seed });
    applyLoadout(M, g, depth, seed);
    g.loadLevel(depth);
    g.god = true;                              // keep going through hits so we measure the busy scenes
    const pilot = new Pilot(kind, M, g);
    g.bot = (gg) => pilot.control(gg);
    // wrap the creature updates
    let frameEnemyMs = 0;
    for (const e of g.enemies) {
      const orig = e.update.bind(e), t = e.type;
      e.update = function (gg, dt) { const t0 = performance.now(); orig(gg, dt); const d = performance.now() - t0; frameEnemyMs += d; const b = per[t] || (per[t] = { n: 0, sum: 0, max: 0 }); b.n++; b.sum += d; if (d > b.max) b.max = d; };
    }
    // warm up
    for (let i = 0; i < 120; i++) g.update(1 / 60);
    const frames = Math.round(secs * 60);
    for (let i = 0; i < frames; i++) {
      frameEnemyMs = 0;
      g.update(1 / 60);
      all.push(frameEnemyMs);
      if (frameEnemyMs > worst.ms) worst = { ms: frameEnemyMs, kind, seed, frame: i };
      if (g.state !== 'play') { if (g.state === 'levelend') { g.loadLevel(depth); for (const e of g.enemies) { const orig = e.update.bind(e), t = e.type; e.update = function (gg, dt) { const t0 = performance.now(); orig(gg, dt); const d = performance.now() - t0; frameEnemyMs += d; const b = per[t] || (per[t] = { n: 0, sum: 0, max: 0 }); b.n++; b.sum += d; if (d > b.max) b.max = d; }; } } else break; }
    }
  }
}
all.sort((a, b) => a - b);
const q = (p) => all[Math.min(all.length - 1, Math.floor(all.length * p))];
const mean = all.reduce((a, b) => a + b, 0) / all.length;
console.log(`root=${root}\ndepth ${depth}, ${kinds.join('+')} x ${seeds} seeds, ${all.length} frames`);
console.log(`ALL creature updates per frame: mean ${mean.toFixed(3)} ms | p50 ${q(0.5).toFixed(3)} | p99 ${q(0.99).toFixed(3)} | p99.9 ${q(0.999).toFixed(3)} | max ${all[all.length - 1].toFixed(2)} ms | frames > 2 ms: ${all.filter((x) => x > 2).length} | > 5 ms: ${all.filter((x) => x > 5).length}`);
for (const t of Object.keys(per)) console.log(`  ${t.padEnd(10)} mean ${(per[t].sum / per[t].n).toFixed(4)} ms/update   max ${per[t].max.toFixed(2)} ms`);
console.log(`flow-field computations: ${navStat.calls} calls, mean ${(navStat.ms / Math.max(1, navStat.calls)).toFixed(3)} ms, max ${navStat.max.toFixed(2)} ms, total ${navStat.ms.toFixed(0)} ms over ${(all.length / 60).toFixed(0)} s of play (${(navStat.ms / (all.length / 60)).toFixed(2)} ms/s)`);
console.log('worst frame', JSON.stringify(worst));
