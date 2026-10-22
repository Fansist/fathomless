// Generation-time benchmark per depth band (Node, single thread).
//   node tools/worldgen-bench.mjs [seeds=40] [depths 1..14]      WORLD=../js/world.baseline.js node tools/worldgen-bench.mjs
// Every (seed, depth) level is generated REPS times and the fastest run is kept: the machine is usually shared with other jobs, so
// the minimum is the honest cost of the algorithm (the retry attempts of unlucky seeds are included, they are deterministic).
const WORLD = process.env.WORLD || '../js/world.js';
const { generateLevel } = await import(WORLD);
const N = +(process.argv[2] || 40), REPS = 3;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
for (let i = 0; i < 3; i++) generateLevel('warm' + i, 6); // JIT warm-up
const bands = [['d1', [1]], ['d2', [2]], ['d3', [3]], ['d4-6', [4, 5, 6]], ['d7-9', [7, 8, 9]], ['d10-11', [10, 11]], ['d12', [12]], ['d13-14', [13, 14]]];
console.log(`world=${WORLD}  seeds/depth=${N}  (best of ${REPS} runs per level)`);
let worstP95 = 0;
for (const [name, ds] of bands) {
  const ms = [], att = [];
  for (const d of ds) for (let s = 0; s < N; s++) {
    let best = 1e9, lv;
    for (let r = 0; r < REPS; r++) { const t0 = performance.now(); lv = generateLevel('bn' + s, d); best = Math.min(best, performance.now() - t0); }
    ms.push(best); att.push(lv.attempt || 0);
  }
  worstP95 = Math.max(worstP95, pct(ms, 0.95));
  console.log(`${name.padEnd(7)} n=${String(ms.length).padStart(4)}  mean ${mean(ms).toFixed(0).padStart(4)}  p50 ${pct(ms, 0.5).toFixed(0).padStart(4)}  p95 ${pct(ms, 0.95).toFixed(0).padStart(4)}  max ${Math.max(...ms).toFixed(0).padStart(4)} ms   retries/level mean ${mean(att).toFixed(2)} max ${Math.max(...att)}`);
}
console.log(`worst band p95: ${worstP95.toFixed(0)} ms  (budget 350)`);
