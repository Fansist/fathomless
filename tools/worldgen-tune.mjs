// Build a throw-away copy of js/world.js with different CARVE tables, for parameter sweeps.
//   node tools/worldgen-tune.mjs <name> '<json {carve:[{...}x4], final:{...}}>' [baseFile=js/world.js]
// Writes js/_tune_<name>.js ; evaluate with  WORLD=../js/_tune_<name>.js node tools/worldgen-quality.mjs
import fs from 'node:fs';
const [name, json, base = 'js/world.js'] = process.argv.slice(2);
const cfg = JSON.parse(json);
const root = new URL('..', import.meta.url);
let src = fs.readFileSync(new URL(base, root), 'utf8');
const fmt = (o) => '{ ' + Object.entries(o).map(([k, v]) => k + ': ' + v).join(', ') + ' }';
if (cfg.carve) src = src.replace(/const CARVE = \[[\s\S]*?\n\];/, 'const CARVE = [\n' + cfg.carve.map((o) => '  ' + fmt(o) + ',').join('\n') + '\n];');
if (cfg.final) src = src.replace(/const CARVE_FINAL = \{[^\n]*\};/, 'const CARVE_FINAL = ' + fmt(cfg.final) + ';');
fs.writeFileSync(new URL('js/_tune_' + name + '.js', root), src);
console.log('wrote js/_tune_' + name + '.js');
