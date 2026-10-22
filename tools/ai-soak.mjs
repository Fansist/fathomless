// Long-run creature health soak test: every depth x several seeds x N minutes with a pilot that keeps provoking the
// creatures (hull is refilled every frame so the run never ends). Reports NaN / in-rock / stuck / jitter / state mix.
//   node tools/ai-soak.mjs [--depths 1-12] [--seeds 3] [--secs 240] [--procs 8] [--bots naive,careful]
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

if (argv.includes('--worker')) {
  const core = await import('./ai-core.mjs');
  const M = await core.loadModules(pathToFileURL(path.resolve(process.env.AI_JSROOT || root) + '/js/').href);
  process.on('message', (job) => {
    if (job === 'bye') process.exit(0);
    const { kind, depth, seed, secs } = job;
    core.seedMath('soak|' + kind + '|' + seed + '|' + depth);
    const g = core.makeGame(M);
    g.startRun({ seed });
    core.applyLoadout(M, g, depth, seed);
    g.loadLevel(depth);
    const pilot = new core.Pilot(kind, M, g);
    g.bot = (gg) => pilot.control(gg);
    const mon = new core.Health(M);
    const W = M.world;
    // jitter: 180-degree velocity reversals of patrolling eels within 0.25 s
    const jit = { rev: 0, patrolTicks: 0 }, prev = new Map();
    let stuckPlayer = 0, reloads = 0, hitsTaken = 0, maxNavMs = 0;
    const oh = g.hurt.bind(g);
    g.hurt = (...a) => { const h = g.player.hull; oh(...a); if (g.player.hull < h) hitsTaken++; };
    const frames = Math.round(secs * 60);
    for (let i = 0; i < frames; i++) {
      g.update(1 / 60);
      g.player.hull = g.player.maxHull;
      if (g.state === 'dying' || g.state === 'gameover') { g.state = 'play'; g.player.dead = false; g.player.invul = 1; }
      mon.tick(g);
      if (i % 15 === 0) for (const e of g.enemies) {
        if (e.type !== 'eel' && e.type !== 'leviathan') continue;
        const p0 = prev.get(e), sp = Math.hypot(e.vx, e.vy);
        if (e.state === 'patrol') { jit.patrolTicks++; if (p0 && sp > 30 && p0.sp > 30 && (e.vx * p0.vx + e.vy * p0.vy) < -0.6 * sp * p0.sp) jit.rev++; }
        prev.set(e, { vx: e.vx, vy: e.vy, sp });
      }
      if (g.state === 'levelend') { reloads++; g.loadLevel(depth); mon.rec.clear(); }
      else if (g.state === 'upgrade') { g.state = 'play'; }
    }
    const h = mon.summary();
    process.send({ res: { kind, depth, seed, h: { nan: h.nan, rock: h.rockTicks, clip: h.clipTicks, spineRock: h.spineRockTicks, minSdf: h.minSdf, stuck: h.stuck, chases: h.chases.length, maxChase: Math.max(0, ...h.chases.map((c) => c.dur)), states: h.states, maxSpeed: h.maxSpeed }, jit, reloads, hitsTaken } });
  });
  process.send({ ready: true });
} else {
  const parse = (s) => { const out = []; for (const part of s.split(',')) { const m = part.match(/^(\d+)-(\d+)$/); if (m) for (let d = +m[1]; d <= +m[2]; d++) out.push(d); else out.push(+part); } return out; };
  const depths = parse(opt('depths', '1-12')), seeds = +opt('seeds', 3), secs = +opt('secs', 240), procs = +opt('procs', 8), bots = opt('bots', 'naive,careful').split(',');
  const jobs = [];
  for (const d of depths) for (let s = 0; s < seeds; s++) jobs.push({ kind: bots[s % bots.length], depth: d, seed: 'k' + s, secs });
  const results = [];
  await new Promise((resolve) => {
    let next = 0;
    const kids = [];
    for (let i = 0; i < Math.min(procs, jobs.length); i++) {
      const c = fork(fileURLToPath(import.meta.url), ['--worker'], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
      kids.push(c);
      c.on('message', (m) => {
        if (m.res) { results.push(m.res); process.stdout.write('.'); }
        if (next < jobs.length) c.send(jobs[next++]); else c.send('bye');
        if (results.length === jobs.length) { kids.forEach((k) => k.kill()); resolve(); }
      });
    }
  });
  console.log();
  const sum = (a, f) => a.reduce((x, r) => x + f(r), 0);
  console.log('depth  runs  NaN  headInRock  clipTicks  spineInRock  stuck  minSdf  chases  maxChase  patrolReversals/min  hits/run');
  const states = {}, maxSpeed = {};
  for (const d of depths) {
    const rs = results.filter((r) => r.depth === d);
    const rev = sum(rs, (r) => r.jit.rev), pt = sum(rs, (r) => r.jit.patrolTicks) * 15 / 60 / 60;   // minutes of eel patrol
    console.log(`${String(d).padStart(5)} ${String(rs.length).padStart(5)} ${String(sum(rs, (r) => r.h.nan)).padStart(4)} ${String(sum(rs, (r) => r.h.rock)).padStart(11)} ${String(sum(rs, (r) => r.h.clip)).padStart(10)} ${String(sum(rs, (r) => r.h.spineRock)).padStart(12)} ${String(sum(rs, (r) => r.h.stuck.length)).padStart(6)} ${Math.min(...rs.map((r) => r.h.minSdf)).toFixed(1).padStart(7)} ${String(sum(rs, (r) => r.h.chases)).padStart(7)} ${Math.max(...rs.map((r) => r.h.maxChase)).toFixed(1).padStart(9)} ${(pt > 0 ? rev / pt : 0).toFixed(2).padStart(20)} ${(sum(rs, (r) => r.hitsTaken) / rs.length).toFixed(1).padStart(9)}`);
    for (const r of rs) {
      for (const t in r.h.states) for (const s in r.h.states[t]) { states[t] = states[t] || {}; states[t][s] = (states[t][s] || 0) + r.h.states[t][s]; }
      for (const t in r.h.maxSpeed) maxSpeed[t] = Math.max(maxSpeed[t] || 0, r.h.maxSpeed[t]);
    }
  }
  for (const r of results) for (const s of r.h.stuck) console.log('STUCK', r.kind, r.depth, r.seed, JSON.stringify(s));
  console.log('state occupancy (% of creature-ticks):');
  for (const t in states) { const tot = Object.values(states[t]).reduce((a, b) => a + b, 0); console.log('  ' + t.padEnd(10) + Object.entries(states[t]).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(v / tot * 100).toFixed(1)}%`).join('  ')); }
  console.log('max speeds (px/s):', JSON.stringify(Object.fromEntries(Object.entries(maxSpeed).map(([k, v]) => [k, Math.round(v)]))));
}
