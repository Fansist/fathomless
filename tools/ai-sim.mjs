// Creature-AI + balance simulator.
//   node tools/ai-sim.mjs [--engine node|browser] [--bots naive,careful,fog,spam] [--depths 1-12] [--seeds 6]
//                         [--max 240] [--procs 6] [--mode level|campaign] [--hs] [--tag name] [--out file.json]
//   level    mode: every depth is played from a full hull (completion rate / hits / deaths by creature per depth).
//   campaign mode: depth 1 -> 12 in one run with upgrade picks and hull carry-over, like the real game.
//   --hs     adds "which creature state hit me" counters.  AI_JSROOT=<dir> tests another copy of the game (before/after).
//   AI_TUNE='{"eel":{"moveHear":1.5}}' overrides EEL_CFG / LEVIATHAN_CFG / PLAYER / PING values for parameter sweeps.
// engine=node    : fast, headless, stubbed DOM (default). Jobs are spread over child processes.
// engine=browser : puppeteer + tools/harness.mjs; drives window.__fathom.game with the same pilots (slow, a cross-check).
import { fork } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
// AI_JSROOT=<project dir> runs the same pilots against another copy of the game (e.g. the original, for before/after tables)
const jsPrefix = pathToFileURL(path.resolve(process.env.AI_JSROOT || root) + '/js/').href;

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (k) => argv.includes('--' + k);

/* ------------------------------ worker ------------------------------ */
if (flag('worker')) {
  const core = await import('./ai-core.mjs');
  const M = await core.loadModules(jsPrefix);
  process.on('message', (job) => {
    if (job === 'bye') process.exit(0);
    let res;
    try { res = job.mode === 'campaign' ? core.simulateCampaign(M, job) : core.simulateLevel(M, job); }
    catch (e) { res = { kind: job.kind, seed: job.seed, depth: job.depth, outcome: 'error', error: String(e && e.stack || e) }; }
    process.send({ res });
  });
  process.send({ ready: true });
} else {
  await main();
}

function parseDepths(s) {
  const out = [];
  for (const part of s.split(',')) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) for (let d = +m[1]; d <= +m[2]; d++) out.push(d); else out.push(+part);
  }
  return out;
}

export function aggregate(results) {
  const groups = new Map();
  for (const r of results) {
    const key = r.kind + '|' + r.depth;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const rows = [];
  for (const [key, arr] of groups) {
    const [kind, depth] = key.split('|');
    const n = arr.length;
    const clear = arr.filter((r) => r.outcome === 'clear'), dead = arr.filter((r) => r.outcome === 'dead'), to = arr.filter((r) => r.outcome === 'timeout');
    const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const deathBy = {}; for (const r of dead) deathBy[r.deathBy] = (deathBy[r.deathBy] || 0) + 1;
    const hitsBy = {}; for (const r of arr) for (const k in r.hitsBy || {}) hitsBy[k] = (hitsBy[k] || 0) + r.hitsBy[k];
    const hs = {}; for (const r of arr) for (const k in r.hitsByState || {}) hs[k] = (hs[k] || 0) + r.hitsByState[k];
    let nan = 0, rock = 0, clip = 0, spine = 0, stuck = [], chases = [];
    const states = {};
    for (const r of arr) {
      const h = r.health; if (!h) continue;
      nan += h.nan; rock += h.rockTicks; clip += h.clipTicks; spine += h.spineRockTicks;
      stuck = stuck.concat(h.stuck.map((s) => ({ ...s, seed: r.seed })));
      chases = chases.concat(h.chases);
      for (const t in h.states) for (const s in h.states[t]) { states[t] = states[t] || {}; states[t][s] = (states[t][s] || 0) + h.states[t][s]; }
    }
    rows.push({
      kind, depth: +depth, n, clear: clear.length / n, dead: dead.length / n, timeout: to.length / n,
      tClear: mean(clear.map((r) => r.t)), tAll: mean(arr.map((r) => r.t)), hits: mean(arr.map((r) => r.hits)), hitsBy, hs, deathBy,
      starve: mean(arr.map((r) => r.starveSec)), lowE: mean(arr.map((r) => r.lowEnergySec)), pings: mean(arr.map((r) => r.pings)), dashes: mean(arr.map((r) => r.dashes)),
      buoys: mean(arr.map((r) => r.buoys)), pearls: mean(arr.map((r) => r.pearls)), route: mean(arr.map((r) => r.route || 0)),
      nan, rock, clip, spine, stuck, chases, states,
      errors: arr.filter((r) => r.outcome === 'error').map((r) => r.error),
    });
  }
  rows.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.depth - b.depth));
  return rows;
}

export function printTable(rows) {
  const pad = (s, n) => String(s).padStart(n);
  console.log('bot      d   n  clear%  dead%  tmo%  tClear  hits  starve  pings dash buoy pearl | deaths by | enemy health');
  for (const r of rows) {
    const db = Object.entries(r.deathBy).map(([k, v]) => k[0] + v).join(' ');
    const cm = r.chases.length ? `chases ${r.chases.length} avg ${(r.chases.reduce((a, c) => a + c.dur, 0) / r.chases.length).toFixed(1)}s max ${Math.max(...r.chases.map((c) => c.dur)).toFixed(1)}s` : '';
    const hsTxt = flag('hs') ? ' | ' + Object.entries(r.hs).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => k + '=' + v).join(' ') : '';
    console.log(`${r.kind.padEnd(8)} ${pad(r.depth, 2)} ${pad(r.n, 3)}  ${pad((r.clear * 100).toFixed(0), 5)}  ${pad((r.dead * 100).toFixed(0), 5)} ${pad((r.timeout * 100).toFixed(0), 5)}  ${pad(r.tClear.toFixed(0), 5)}s ${pad(r.hits.toFixed(1), 5)} ${pad(r.starve.toFixed(1), 6)} ${pad(r.pings.toFixed(0), 5)} ${pad(r.dashes.toFixed(1), 4)} ${pad(r.buoys.toFixed(1), 4)} ${pad(r.pearls.toFixed(0), 5)} | ${db.padEnd(10)} | nan${r.nan} rock${r.rock} clip${r.clip} spine${r.spine} stuck${r.stuck.length} ${cm}${hsTxt}`);
  }
}

async function main() {
  const engine = opt('engine', 'node');
  const bots = opt('bots', 'naive,careful').split(',');
  const depths = parseDepths(opt('depths', '1-12'));
  const seeds = +opt('seeds', 6);
  const maxT = +opt('max', 240);
  const mode = opt('mode', 'level');
  const procs = Math.max(1, Math.min(+opt('procs', Math.max(1, os.cpus().length - 1)), 12));
  const loadout = opt('loadout', '1') !== '0';
  const tag = opt('tag', 'run');
  const outFile = opt('out', path.join(here, 'out', 'ai-sim-' + tag + '.json'));
  const jobs = [];
  if (mode === 'campaign') {
    for (const kind of bots) for (let s = 0; s < seeds; s++) jobs.push({ mode, kind, seed: 'c' + s, depth: 0, maxLevelT: maxT });
  } else {
    for (const kind of bots) for (const depth of depths) for (let s = 0; s < seeds; s++) jobs.push({ mode, kind, depth, seed: 'a' + s, maxT, loadout });
  }
  const t0 = Date.now();
  let results = [];
  if (engine === 'browser') {
    const { launch } = await import('./harness.mjs');
    const h = await launch({});
    const { page } = h;
    await page.goto(h.url + '/index.html?noaudio=1&mute=1', { waitUntil: 'load' });
    await new Promise((r) => setTimeout(r, 600));
    await page.evaluate(() => window.__fathom.freeze(true));
    for (const job of jobs) {
      const res = await page.evaluate(async (j) => {
        // the harness' static server does not know .mjs, so load ai-core as a blob module
        if (!window.__aiCore) {
          const src = await (await fetch('/tools/ai-core.mjs')).text();
          window.__aiCore = await import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
          window.__aiM = await window.__aiCore.loadModules(location.origin + '/js/');
        }
        const core = window.__aiCore, M = window.__aiM;
        const f = window.__fathom;
        if (core.GAME_PATCH && !f.game.__aiPatched) { core.patchGame(f.game); f.game.__aiPatched = true; }
        if (j.mode === 'campaign') return core.simulateCampaign(M, { ...j, game: f.game });
        return core.simulateLevel(M, { ...j, game: f.game });
      }, job);
      results.push(res);
      process.stdout.write(res.outcome === 'clear' ? '.' : res.outcome === 'dead' ? 'x' : 't');
    }
    console.log();
    if (h.errors.length) console.log('page errors:', h.errors.slice(0, 5));
    await h.close();
  } else {
    await new Promise((resolve) => {
      let next = 0, done = 0, alive = 0;
      const spawn = () => {
        const c = fork(fileURLToPath(import.meta.url), ['--worker'], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
        alive++;
        c.on('message', (m) => {
          if (m.res) {
            results.push(m.res); done++;
            process.stdout.write(m.res.outcome === 'clear' ? '.' : m.res.outcome === 'dead' ? 'x' : m.res.outcome === 'error' ? 'E' : 't');
          }
          if (next < jobs.length) c.send(jobs[next++]);
          else { c.send('bye'); }
          if (done === jobs.length) { for (const w of workers) w.kill(); resolve(); }
        });
        c.on('exit', () => { alive--; });
        return c;
      };
      const workers = [];
      for (let i = 0; i < Math.min(procs, jobs.length); i++) workers.push(spawn());
    });
    console.log();
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  if (mode === 'campaign') {
    fs.writeFileSync(outFile, JSON.stringify(results));
    const byKind = {};
    for (const r of results) (byKind[r.kind] = byKind[r.kind] || []).push(r);
    for (const k in byKind) {
      const arr = byKind[k];
      const won = arr.filter((r) => r.outcome === 'won').length;
      const depthsReached = arr.map((r) => r.depth);
      const deaths = {}; for (const r of arr) if (r.deathBy) deaths[r.deathBy] = (deaths[r.deathBy] || 0) + 1;
      const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
      console.log(`${k}: runs ${arr.length} won ${won} | depth reached mean ${mean(depthsReached).toFixed(1)} [${depthsReached.join(',')}] | sim time mean ${(mean(arr.map((r) => r.totalT)) / 60).toFixed(1)} min | deaths ${JSON.stringify(deaths)}`);
      const perDepth = {};
      for (const r of arr) for (const l of r.levels) { const e = perDepth[l.depth] = perDepth[l.depth] || { n: 0, t: 0, hits: 0 }; e.n++; e.t += l.t; e.hits += l.hits; }
      console.log('  per-depth reached/avg time/avg hits: ' + Object.keys(perDepth).map((d) => `${d}:${perDepth[d].n}/${(perDepth[d].t / perDepth[d].n).toFixed(0)}s/${(perDepth[d].hits / perDepth[d].n).toFixed(1)}`).join('  '));
    }
  } else {
    const rows = aggregate(results);
    fs.writeFileSync(outFile, JSON.stringify({ rows, results }));
    printTable(rows);
    const errs = rows.flatMap((r) => r.errors);
    if (errs.length) console.log('ERRORS:\n' + errs.slice(0, 3).join('\n'));
  }
  console.log(`engine=${engine} jobs=${jobs.length} time=${secs}s -> ${outFile}`);
}
